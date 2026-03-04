"""Export analytics data to CSV for spreadsheet analysis."""

import csv
import sys
import requests
from io import StringIO


BASE_URL = "http://localhost:3000"


def export_sessions_csv(output_path):
    """Export all sessions to CSV."""
    resp = requests.get(f"{BASE_URL}/hooks/claude/sessions", params={"limit": 1000})
    resp.raise_for_status()
    sessions = resp.json()

    if not sessions:
        print("No sessions to export")
        return

    fieldnames = sessions[0].keys()
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(sessions)

    print(f"Exported {len(sessions)} sessions to {output_path}")


def export_metrics_csv(output_path):
    """Export quality metrics for all sessions."""
    resp = requests.get(f"{BASE_URL}/hooks/claude/sessions", params={"limit": 1000})
    sessions = resp.json()

    rows = []
    for s in sessions:
        try:
            m_resp = requests.get(f"{BASE_URL}/hooks/claude/sessions/{s['id']}/metrics")
            metrics = m_resp.json()
            metrics["session_id"] = s["id"]
            metrics["branch"] = s.get("branch")
            metrics["task_id"] = s.get("task_id")
            rows.append(metrics)
        except Exception as e:
            print(f"  Skipping {s['id']}: {e}", file=sys.stderr)

    if not rows:
        print("No metrics to export")
        return

    fieldnames = rows[0].keys()
    with open(output_path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Exported metrics for {len(rows)} sessions to {output_path}")


if __name__ == "__main__":
    export_sessions_csv("data/sessions.csv")
    export_metrics_csv("data/metrics.csv")
