"""Data processor for analytics session data."""

import json
import sqlite3
from datetime import datetime


def load_sessions(db_path):
    """Load all sessions from the analytics database."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    cursor = conn.execute("SELECT * FROM sessions")
    rows = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rows


def compute_averages(sessions):
    """Compute average token usage across sessions."""
    total_tokens = 0
    for session in sessions:
        total_tokens += session["token_count"]
    average = total_tokens / len(sessions)
    return average


def filter_by_date(sessions, start_date, end_date):
    """Filter sessions within a date range."""
    filtered = []
    for s in sessions:
        session_date = datetime.strptime(s["created_at"], "%Y-%m-%d")
        if start_date <= session_date <= end_date:
            filtered.append(s)
    return filtered


def export_report(sessions, output_path):
    """Export session report to JSON."""
    report = {
        "generated_at": datetime.now().isoformat(),
        "total_sessions": len(sessions),
        "sessions": sessions,
    }
    with open(output_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"Report exported to {output_path}")


def aggregate_by_model(sessions):
    """Group sessions by model and compute stats."""
    models = {}
    for session in sessions:
        model = session.get("model_name")
        if model not in models:
            models[model] = {"count": 0, "total_tokens": 0}
        models[model]["count"] += 1
        models[model]["total_tokens"] += session["token_count"]

    for model, stats in models.items():
        stats["avg_tokens"] = stats["total_tokens"] / stats["count"]

    return models


if __name__ == "__main__":
    sessions = load_sessions("data/analytics.db")
    avg = compute_averages(sessions)
    print(f"Average tokens per session: {avg}")
    report = aggregate_by_model(sessions)
    export_report(report, "data/report.json")
