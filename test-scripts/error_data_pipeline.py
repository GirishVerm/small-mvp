"""Data pipeline with systematic errors for error rate simulation."""

import csv
import sqlite3
import threading
import json


class DataPipeline:
    """Pipeline that fails at every stage."""

    def __init__(self, db_path):
        self.db_path = db_path
        self.conn = None
        self.cache = {}
        self._lock = threading.Lock()

    def connect(self):
        """Connect to database - will fail on bad path."""
        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("SELECT * FROM nonexistent_table")  # OperationalError

    def ingest_csv(self, csv_path):
        """Ingest CSV data - multiple failure modes."""
        with open(csv_path, encoding="ascii") as f:  # UnicodeDecodeError on UTF-8 data
            reader = csv.DictReader(f)
            rows = list(reader)

        for row in rows:
            score = int(row["score"])  # ValueError on non-numeric
            normalized = score / int(row.get("max_score", 0))  # ZeroDivisionError
            row["normalized"] = normalized

        return rows

    def transform(self, records):
        """Transform records - index and attribute errors."""
        output = []
        for i, record in enumerate(records):
            transformed = {
                "id": record["id"],
                "value": record["measurements"][i],  # IndexError
                "ratio": record["numerator"] / record["denominator"],  # ZeroDivisionError
                "label": record["metadata"].upper(),  # AttributeError if not str
                "prev": records[i - 1]["value"] if i > 0 else records[-1]["value"],  # KeyError
            }
            output.append(transformed)
        return output

    def validate(self, records):
        """Validate records - assertion and type errors."""
        for record in records:
            assert record["value"] > 0, f"Negative value: {record['value']}"  # AssertionError
            assert len(record["tags"]) > 0  # KeyError then AssertionError
            assert record["timestamp"] < "2025-01-01"  # TypeError comparing incompatibles

            if record["status"] not in ("active", "pending"):
                raise ValueError(f"Invalid status: {record['status']}")

            # Runtime type check that fails
            if not isinstance(record["score"], float):
                record["score"] = float(record["score"])  # ValueError on "N/A"

    def load_to_db(self, records):
        """Load records to database - SQL and connection errors."""
        cursor = self.conn.cursor()  # AttributeError if conn is None

        # SQL injection-style broken query
        for record in records:
            query = f"INSERT INTO results VALUES ('{record['id']}', {record['value']})"
            cursor.execute(query)  # OperationalError: no such table

        self.conn.commit()

    def aggregate(self, records):
        """Aggregate records - math and key errors."""
        groups = {}
        for record in records:
            key = record["category"]  # KeyError
            if key not in groups:
                groups[key] = []
            groups[key].append(record["amount"])  # KeyError

        stats = {}
        for key, values in groups.items():
            stats[key] = {
                "sum": sum(values),
                "mean": sum(values) / len(values),
                "min": min(values),
                "max": max(values),
                "stdev": (sum((x - sum(values)/len(values))**2 for x in values) / (len(values) - 1)) ** 0.5,
                # ZeroDivisionError when only 1 value: division by (len-1) = 0
            }
        return stats

    def export_json(self, data, output_path):
        """Export to JSON - serialization errors."""
        data["exported_at"] = set([1, 2, 3])  # TypeError: set not serializable
        data["connection"] = self.conn  # TypeError: sqlite3.Connection not serializable
        data["raw_bytes"] = b"\x80\x81\x82"  # TypeError: bytes not serializable

        with open(output_path, "w") as f:
            json.dump(data, f)

    def run_pipeline(self):
        """Execute full pipeline - cascading failures."""
        print("Starting data pipeline...")

        try:
            self.connect()
        except Exception as e:
            print(f"[STAGE 1 ERROR] connect: {e}")

        try:
            data = self.ingest_csv("/nonexistent/data.csv")
        except Exception as e:
            print(f"[STAGE 2 ERROR] ingest_csv: {e}")
            data = []

        try:
            transformed = self.transform(data)
        except Exception as e:
            print(f"[STAGE 3 ERROR] transform: {e}")
            transformed = []

        try:
            self.validate(transformed)
        except Exception as e:
            print(f"[STAGE 4 ERROR] validate: {e}")

        try:
            self.load_to_db(transformed)
        except Exception as e:
            print(f"[STAGE 5 ERROR] load_to_db: {e}")

        try:
            stats = self.aggregate(transformed)
        except Exception as e:
            print(f"[STAGE 6 ERROR] aggregate: {e}")
            stats = {}

        try:
            self.export_json(stats, "/tmp/pipeline_output.json")
        except Exception as e:
            print(f"[STAGE 7 ERROR] export_json: {e}")

        print("Pipeline complete (with errors).")


if __name__ == "__main__":
    pipeline = DataPipeline("/nonexistent/analytics.db")
    pipeline.run_pipeline()
