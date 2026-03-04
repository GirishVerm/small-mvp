"""Compare metrics between two sessions to track improvement."""

import sys
import requests
from datetime import datetime


BASE_URL = "http://localhost:3000"


def fetch_metrics(session_id):
    """Fetch metrics for a session."""
    resp = requests.get(f"{BASE_URL}/hooks/claude/sessions/{session_id}/metrics")
    resp.raise_for_status()
    return resp.json()


def compare_sessions(id_a, id_b):
    """Compare two sessions side by side."""
    metrics_a = fetch_metrics(id_a)
    metrics_b = fetch_metrics(id_b)

    fields = [
        ("error_rate", "Error Rate", True),
        ("edit_success_rate", "Edit Success", False),
        ("productivity_score", "Productivity", False),
        ("total_tools", "Total Tools", None),
        ("total_errors", "Total Errors", True),
        ("files_touched", "Files Touched", None),
    ]

    print(f"{'Metric':<20} {'Session A':<15} {'Session B':<15} {'Delta':<15}")
    print("-" * 65)

    for key, label, lower_is_better in fields:
        val_a = metrics_a.get(key, 0)
        val_b = metrics_b.get(key, 0)
        delta = val_b - val_a

        if lower_is_better is not None:
            if lower_is_better:
                indicator = "improved" if delta < 0 else "regressed"
            else:
                indicator = "improved" if delta > 0 else "regressed"
        else:
            indicator = ""

        if isinstance(val_a, float):
            print(f"{label:<20} {val_a:<15.3f} {val_b:<15.3f} {delta:+.3f} {indicator}")
        else:
            print(f"{label:<20} {val_a:<15} {val_b:<15} {delta:+} {indicator}")


def trend_report(session_ids):
    """Show metric trends across multiple sessions."""
    print("Session Trend Report")
    print("=" * 80)

    all_metrics = []
    for sid in session_ids:
        try:
            m = fetch_metrics(sid)
            m["session_id"] = sid
            all_metrics.append(m)
        except Exception as e:
            print(f"  Skipping {sid}: {e}")

    if len(all_metrics) < 2:
        print("Need at least 2 sessions for a trend.")
        return

    # Compute trend direction
    first = all_metrics[0]
    last = all_metrics[-1]

    er_trend = last["error_rate"] - first["error_rate"]
    esr_trend = last["edit_success_rate"] - first["edit_success_rate"]

    print(f"\n  Error rate trend:        {er_trend:+.1%}")
    print(f"  Edit success rate trend: {esr_trend:+.1%}")

    if er_trend < 0 and esr_trend > 0:
        print("\n  Overall: IMPROVING")
    elif er_trend > 0 or esr_trend < 0:
        print("\n  Overall: DEGRADING")
    else:
        print("\n  Overall: STABLE")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: session_diff.py <session_a> <session_b> [session_c ...]")
        print("  2 args: side-by-side comparison")
        print("  3+ args: trend report")
        sys.exit(1)

    ids = sys.argv[1:]
    if len(ids) == 2:
        compare_sessions(ids[0], ids[1])
    else:
        trend_report(ids)
