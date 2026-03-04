"""Simulate different health label scenarios for Linear sync testing."""

import random
import json
import time
import requests
from dataclasses import dataclass


BASE_URL = "http://localhost:3000"


@dataclass
class MockSession:
    session_id: str
    total_tools: int
    total_errors: int
    total_edits: int
    successful_edits: int
    conversation_turns: int


def generate_smooth_session():
    """Generate a session that should produce 'smooth' health label."""
    return MockSession(
        session_id=f"sim-smooth-{random.randint(1000, 9999)}",
        total_tools=50,
        total_errors=2,
        total_edits=30,
        successful_edits=28,
        conversation_turns=10,
    )


def generate_friction_session():
    """Generate a session that should produce 'friction' health label."""
    return MockSession(
        session_id=f"sim-friction-{random.randint(1000, 9999)}",
        total_tools=40,
        total_errors=6,
        total_edits=20,
        successful_edits=15,
        conversation_turns=12,
    )


def generate_struggling_session():
    """Generate a session that should produce 'struggling' health label."""
    return MockSession(
        session_id=f"sim-struggling-{random.randint(1000, 9999)}",
        total_tools=30,
        total_errors=12,
        total_edits=15,
        successful_edits=5,
        conversation_turns=8,
    )


def compute_expected_health(session):
    """Mirror the health computation from linear.js."""
    error_rate = session.total_errors / session.total_tools
    edit_success = session.successful_edits / session.total_edits

    if error_rate > 0.3 or edit_success < 0.5:
        return "struggling"
    elif error_rate >= 0.1 or edit_success <= 0.8:
        return "friction"
    else:
        return "smooth"


def send_hook_events(session):
    """Send simulated hook events to the analytics server."""
    # Build a list of events with independent error and edit assignments
    events = []
    for i in range(session.total_tools):
        events.append({"is_error": False, "is_edit": False})

    # Assign errors to the first N events
    for i in range(session.total_errors):
        events[i]["is_error"] = True

    # Assign edits spread from the end so they don't overlap with errors
    for i in range(session.total_edits):
        events[session.total_tools - 1 - i]["is_edit"] = True

    for i, event in enumerate(events):
        payload = {
            "type": "PostToolUse",
            "session_id": session.session_id,
            "tool": {
                "name": "Edit" if event["is_edit"] else "Bash",
                "input": {"command": "test"},
            },
            "result": "error: something failed" if event["is_error"] else "success",
        }

        resp = requests.post(f"{BASE_URL}/hooks/claude", json=payload)
        if resp.status_code != 200:
            print(f"Failed to send event {i}: {resp.text}")

    # Send stop events to trigger turn counting
    for turn in range(session.conversation_turns):
        stop_payload = {
            "type": "Stop",
            "session_id": session.session_id,
            "result": {"text": f"Turn {turn} completed"},
        }
        requests.post(f"{BASE_URL}/hooks/claude", json=stop_payload)
        time.sleep(0.1)


def run_simulation():
    """Run the full label simulation test suite."""
    generators = [
        ("smooth", generate_smooth_session),
        ("friction", generate_friction_session),
        ("struggling", generate_struggling_session),
    ]

    results = []

    for expected_label, generator in generators:
        session = generator()
        expected = compute_expected_health(session)

        print(f"\nSimulating {expected_label} session: {session.session_id}")
        print(f"  Expected health level: {expected}")

        send_hook_events(session)

        # Check the computed metrics
        resp = requests.get(
            f"{BASE_URL}/hooks/claude/sessions/{session.session_id}/metrics"
        )
        metrics = resp.json()

        # Trigger label sync
        sync_resp = requests.post(
            f"{BASE_URL}/hooks/claude/sync-label/{session.session_id}"
        )
        sync_result = sync_resp.json()

        actual_level = sync_result.get("health_level", "unknown")
        passed = actual_level == expected

        results.append({
            "session_id": session.session_id,
            "expected": expected,
            "actual": actual_level,
            "passed": passed,
            "metrics": metrics,
        })

        print(f"  Actual health level: {actual_level}")
        print(f"  Result: {'PASS' if passed else 'FAIL'}")

    # Summary
    print("\n--- Simulation Summary ---")
    passed_count = sum(1 for r in results if r["passed"])
    print(f"Passed: {passed_count}/{len(results)}")

    if passed_count < len(results):
        print("\nFailed tests:")
        for r in results:
            if not r["passed"]:
                print(f"  {r['session_id']}: expected={r['expected']}, got={r['actual']}")

    return results


if __name__ == "__main__":
    results = run_simulation()
    with open("data/simulation_results.json", "w") as f:
        json.dump(results, f, indent=2, default=str)
