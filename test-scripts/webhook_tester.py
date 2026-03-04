"""Test webhook delivery to the analytics server."""

import requests
import hmac
import hashlib
import json
import time


BASE_URL = "http://localhost:3000"


def generate_github_signature(payload, secret):
    """Generate GitHub webhook HMAC signature."""
    mac = hmac.new(secret.encode(), payload.encode(), hashlib.sha256)
    return f"sha256={mac.hexdigest()}"


def send_push_webhook(repo, branch, commits, secret=None):
    """Send a simulated GitHub push webhook."""
    payload = {
        "ref": f"refs/heads/{branch}",
        "repository": {"full_name": repo},
        "commits": commits,
        "head_commit": commits[-1] if commits else None,
    }

    headers = {
        "Content-Type": "application/json",
        "X-GitHub-Event": "push",
        "X-GitHub-Delivery": f"test-{int(time.time())}",
    }

    body = json.dumps(payload)
    if secret:
        headers["X-Hub-Signature-256"] = generate_github_signature(body, secret)

    resp = requests.post(f"{BASE_URL}/webhooks/github", headers=headers, data=body)
    return resp.status_code, resp.json()


def send_linear_webhook(identifier, title, state, action="update"):
    """Send a simulated Linear issue webhook."""
    payload = {
        "action": action,
        "type": "Issue",
        "data": {
            "id": f"fake-{identifier}",
            "identifier": identifier,
            "title": title,
            "state": {"name": state},
            "createdAt": "2026-02-03T00:00:00Z",
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
    }

    headers = {"Content-Type": "application/json"}
    resp = requests.post(
        f"{BASE_URL}/webhooks/linear", headers=headers, json=payload
    )
    return resp.status_code, resp.json()


def run_webhook_tests():
    """Run a suite of webhook delivery tests."""
    print("Testing GitHub push webhook...")
    status, body = send_push_webhook(
        repo="test/analytics",
        branch="feat/TES-10-live-hook-testing",
        commits=[
            {
                "id": "abc123",
                "message": "Add analytics CLI\n\nCo-Authored-By: Claude",
                "author": {"name": "Test", "email": "test@test.com"},
                "timestamp": "2026-02-03T12:00:00Z",
                "added": ["test-scripts/analytics_cli.py"],
                "modified": [],
                "removed": [],
            }
        ],
    )
    print(f"  Status: {status}, Response: {body}")

    print("\nTesting Linear issue webhook...")
    status, body = send_linear_webhook(
        identifier="TES-10",
        title="Live hook testing",
        state="In Progress",
    )
    print(f"  Status: {status}, Response: {body}")

    print("\nDone!")


if __name__ == "__main__":
    run_webhook_tests()
