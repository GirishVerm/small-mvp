"""CLI tool to query the Claude Analytics server."""

import argparse
import json
import sys
import requests


DEFAULT_URL = "http://localhost:3000"


def get_sessions(base_url, limit=10):
    """List recent sessions with their health metrics."""
    resp = requests.get(f"{base_url}/hooks/claude/sessions", params={"limit": limit})
    resp.raise_for_status()
    sessions = resp.json()

    if not sessions:
        print("No sessions found.")
        return

    print(f"{'Session ID':<40} {'Branch':<35} {'Task':<10} {'Turns':<7} {'Events':<7}")
    print("-" * 100)
    for s in sessions:
        print(
            f"{s['id']:<40} "
            f"{(s.get('branch') or 'unknown'):<35} "
            f"{(s.get('task_id') or '-'):<10} "
            f"{s.get('conversation_turns', 0):<7} "
            f"{s.get('tool_event_count', 0):<7}"
        )


def get_metrics(base_url, session_id):
    """Show quality metrics for a specific session."""
    resp = requests.get(f"{base_url}/hooks/claude/sessions/{session_id}/metrics")
    resp.raise_for_status()
    metrics = resp.json()

    print(f"Metrics for session: {session_id}\n")

    # Determine health level
    er = metrics.get("error_rate", 0)
    esr = metrics.get("edit_success_rate", 1)
    if er > 0.3 or esr < 0.5:
        health = "STRUGGLING"
        color = "\033[91m"  # red
    elif er >= 0.1 or esr <= 0.8:
        health = "FRICTION"
        color = "\033[93m"  # yellow
    else:
        health = "SMOOTH"
        color = "\033[92m"  # green
    reset = "\033[0m"

    print(f"  Health Level:      {color}{health}{reset}")
    print(f"  Error Rate:        {er:.1%}")
    print(f"  Edit Success Rate: {esr:.1%}")
    print(f"  Productivity:      {metrics.get('productivity_score', 0):.1f} tools/turn")
    print(f"  Total Tools:       {metrics.get('total_tools', 0)}")
    print(f"  Total Errors:      {metrics.get('total_errors', 0)}")
    print(f"  Files Touched:     {metrics.get('files_touched', 0)}")
    print(f"  Tool Diversity:    {metrics.get('tool_diversity', 0)}")


def get_health(base_url):
    """Show server health status."""
    resp = requests.get(f"{base_url}/health")
    resp.raise_for_status()
    data = resp.json()

    print("Server Health:")
    print(f"  Status:        {'OK' if data.get('ok') else 'FAIL'}")
    print(f"  Sessions:      {data.get('sessions', 0)}")
    print(f"  Tool Events:   {data.get('tool_events', 0)}")
    print(f"  Tasks:         {data.get('tasks', 0)}")
    print(f"  Commits:       {data.get('commits', 0)}")
    print(f"  Pull Requests: {data.get('pull_requests', 0)}")


def sync_label(base_url, session_id):
    """Trigger a manual health label sync to Linear."""
    resp = requests.post(f"{base_url}/hooks/claude/sync-label/{session_id}")
    result = resp.json()

    if resp.status_code != 200:
        print(f"Sync failed: {result.get('error', 'Unknown error')}", file=sys.stderr)
        return 1

    task_id = result.get("task_id", "unknown")
    metrics = result.get("metrics", {})
    er = metrics.get("error_rate", 0)
    esr = metrics.get("edit_success_rate", 1)

    if er > 0.3 or esr < 0.5:
        level = "struggling"
    elif er >= 0.1 or esr <= 0.8:
        level = "friction"
    else:
        level = "smooth"

    print(f"Synced health label for {task_id}: {level}")
    print(f"  Error Rate:        {er:.1%}")
    print(f"  Edit Success Rate: {esr:.1%}")
    return 0


def get_quality(base_url):
    """Show quality leaderboard across sessions."""
    resp = requests.get(f"{base_url}/hooks/claude/metrics/quality")
    resp.raise_for_status()
    rows = resp.json()

    if not rows:
        print("No quality metrics yet.")
        return

    print(f"{'Session':<40} {'Branch':<30} {'Err%':<8} {'Edit%':<8} {'Prod':<8}")
    print("-" * 95)
    for r in rows:
        print(
            f"{r['session_id']:<40} "
            f"{(r.get('branch') or '-'):<30} "
            f"{r.get('error_rate', 0):.1%}   "
            f"{r.get('edit_success_rate', 0):.1%}   "
            f"{r.get('productivity_score', 0):.1f}"
        )


def main():
    parser = argparse.ArgumentParser(description="Claude Analytics CLI")
    parser.add_argument("--url", default=DEFAULT_URL, help="Analytics server URL")
    sub = parser.add_subparsers(dest="command", required=True)

    # sessions
    p_sessions = sub.add_parser("sessions", help="List recent sessions")
    p_sessions.add_argument("-n", "--limit", type=int, default=10)

    # metrics
    p_metrics = sub.add_parser("metrics", help="Show session metrics")
    p_metrics.add_argument("session_id", help="Session ID")

    # health
    sub.add_parser("health", help="Server health check")

    # sync
    p_sync = sub.add_parser("sync", help="Sync health label to Linear")
    p_sync.add_argument("session_id", help="Session ID")

    # quality
    sub.add_parser("quality", help="Quality leaderboard")

    args = parser.parse_args()

    if args.command == "sessions":
        get_sessions(args.url, args.limit)
    elif args.command == "metrics":
        get_metrics(args.url, args.session_id)
    elif args.command == "health":
        get_health(args.url)
    elif args.command == "sync":
        sync_label(args.url, args.session_id)
    elif args.command == "quality":
        get_quality(args.url)


if __name__ == "__main__":
    main()
