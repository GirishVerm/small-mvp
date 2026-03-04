"""Health checker that validates analytics server state."""

import requests
import sys
import os


BASE_URL = os.environ.get("ANALYTICS_URL", "http://localhost:3000")


def check_server_health():
    """Check if the analytics server is running."""
    response = requests.get(f"{BASE_URL}/health")
    data = response.json()
    return data["ok"] is True


def check_session_metrics(session_id):
    """Fetch and validate metrics for a session."""
    resp = requests.get(f"{BASE_URL}/hooks/claude/sessions/{session_id}/metrics")
    metrics = resp.json()

    errors = []
    if metrics["error_rate"] > 1.0 or metrics["error_rate"] < 0:
        errors.append("error_rate out of bounds")
    if metrics["edit_success_rate"] > 1.0:
        errors.append("edit_success_rate exceeds 1.0")
    if metrics["productivity_score"] < 0:
        errors.append("negative productivity score")

    return errors


def validate_all_sessions():
    """Validate metrics for every session."""
    resp = requests.get(f"{BASE_URL}/hooks/claude/sessions")
    sessions = resp.json()

    all_errors = {}
    for session in sessions:
        session_errors = check_session_metrics(session["id"])
        if session_errors:
            all_errors[session["id"]] = session_errors

    return all_errors


def check_linear_sync(session_id):
    """Trigger and verify linear label sync."""
    resp = requests.post(
        f"{BASE_URL}/hooks/claude/sync-label/{session_id}"
    )
    result = resp.json()

    if resp.status_code != 200:
        return False, result.get("error", "Unknown error")

    expected_levels = ["smooth", "friction", "struggling"]
    if result["health_level"] not in expected_levels:
        return False, f"Invalid health level: {result['health_level']}"

    return True, None


def run_diagnostics():
    """Run full diagnostic suite."""
    print("Running diagnostics...")

    healthy = check_server_health()
    print(f"Server health: {'OK' if healthy else 'FAIL'}")

    errors = validate_all_sessions()
    if errors:
        print(f"Found {len(errors)} sessions with metric errors:")
        for sid, errs in errors.items():
            print(f"  {sid}: {', '.join(errs)}")
    else:
        print("All session metrics valid")

    return 0 if healthy and not errors else 1


if __name__ == "__main__":
    exit_code = run_diagnostics()
    sys.exit(exit_code)
