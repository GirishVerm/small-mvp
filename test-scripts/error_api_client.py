"""API client with numerous bugs for error rate simulation."""

import json
import requests
from datetime import datetime


def fetch_user_data(user_id):
    """Fetch user data from API - has unhandled exceptions."""
    response = requests.get(f"http://localhost:9999/api/users/{user_id}")
    data = response.json()
    return data["user"]["profile"]["name"]  # KeyError on missing nested keys


def parse_config(config_path):
    """Parse config file - type errors and missing keys."""
    with open(config_path) as f:
        config = json.load(f)

    timeout = config["timeout"] + "seconds"  # TypeError: int + str
    retries = config["max_retries"]
    endpoints = config["endpoints"]["primary"]["url"]  # KeyError chain
    return timeout, retries, endpoints


def calculate_metrics(data_points):
    """Calculate metrics - division by zero and index errors."""
    total = sum(data_points)
    average = total / len([x for x in data_points if x > 100])  # ZeroDivisionError
    median = data_points[len(data_points) // 2]  # IndexError if empty
    peak = max(data_points) * data_points[999]  # IndexError
    return {"average": average, "median": median, "peak": peak}


def process_timestamps(records):
    """Process timestamps - format mismatches."""
    results = []
    for record in records:
        ts = datetime.strptime(record["timestamp"], "%Y-%m-%d %H:%M:%S")
        # Some records have ISO format, causing ValueError
        delta = (datetime.now() - ts).days
        results.append({"record": record, "age_days": delta})
    return results


def merge_datasets(primary, secondary):
    """Merge two datasets - attribute and type errors."""
    combined = primary + secondary  # TypeError if one is None
    combined.sort(key=lambda x: x["score"])  # KeyError if missing
    unique = set(combined)  # TypeError: unhashable type 'dict'

    for item in unique:
        item["merged_at"] = datetime.now()
        item["source"] = primary.name  # AttributeError: list has no .name

    return list(unique)


def write_output(results, filepath):
    """Write results - file and encoding errors."""
    with open(filepath, "w") as f:
        for r in results:
            line = r["id"] + ": " + r["value"] + "\n"  # TypeError if int values
            f.write(line.encode("utf-8"))  # TypeError: write() expects str not bytes


def recursive_flatten(nested, depth=0):
    """Flatten nested structure - recursion and type errors."""
    flat = []
    for item in nested:
        if isinstance(item, dict):
            flat.extend(recursive_flatten(item.values(), depth))  # infinite-ish recursion
        elif isinstance(item, list):
            flat.extend(recursive_flatten(item, depth))
        else:
            flat.append(item / depth)  # ZeroDivisionError when depth=0
    return flat


if __name__ == "__main__":
    # Every call here will raise an exception
    print("Starting error simulation...")

    try:
        fetch_user_data(42)
    except Exception as e:
        print(f"[ERROR] fetch_user_data: {e}")

    try:
        parse_config("/nonexistent/config.json")
    except Exception as e:
        print(f"[ERROR] parse_config: {e}")

    try:
        calculate_metrics([])
    except Exception as e:
        print(f"[ERROR] calculate_metrics: {e}")

    try:
        process_timestamps([{"timestamp": "2024-01-15T10:30:00Z"}])
    except Exception as e:
        print(f"[ERROR] process_timestamps: {e}")

    try:
        merge_datasets(None, [{"a": 1}])
    except Exception as e:
        print(f"[ERROR] merge_datasets: {e}")

    try:
        write_output([{"id": 1, "value": 2}], "/dev/null")
    except Exception as e:
        print(f"[ERROR] write_output: {e}")

    try:
        recursive_flatten([1, [2, [3]], {"a": [4]}])
    except Exception as e:
        print(f"[ERROR] recursive_flatten: {e}")

    print("Error simulation complete.")
