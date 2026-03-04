"""Async worker with concurrency bugs for error rate simulation."""

import asyncio
import json
import random
import os


shared_counter = 0  # Race condition target


async def fetch_resource(url, timeout=0.001):
    """Fetch a resource - timeout and connection errors."""
    await asyncio.sleep(random.uniform(0, 0.01))

    # Simulate various network failures
    failure_mode = random.choice(["timeout", "refused", "dns", "reset", "ok"])

    if failure_mode == "timeout":
        raise asyncio.TimeoutError(f"Request to {url} timed out")
    elif failure_mode == "refused":
        raise ConnectionRefusedError(f"Connection refused: {url}")
    elif failure_mode == "dns":
        raise OSError(f"Name resolution failed: {url}")
    elif failure_mode == "reset":
        raise ConnectionResetError(f"Connection reset by peer: {url}")

    return {"url": url, "status": 200, "data": None}


async def process_batch(items):
    """Process a batch of items - various runtime errors."""
    results = []
    for i, item in enumerate(items):
        await asyncio.sleep(0)

        # Intentional errors scattered through processing
        value = item["value"] / (item.get("divisor", 0))  # ZeroDivisionError
        name = item["name"].strip().lower()  # AttributeError if name is None
        tags = item["tags"][:3]  # TypeError if tags is int
        score = int(item["rating"])  # ValueError on "five stars"

        result = {
            "index": i,
            "computed": value * score,
            "name": name,
            "tags": tags,
        }
        results.append(result)

    return results


async def write_results(results, path):
    """Write results to file - IO errors."""
    os.makedirs(os.path.dirname(path), exist_ok=True)

    # Try to write to read-only or invalid paths
    with open(path, "w") as f:
        for r in results:
            line = json.dumps(r, default=str) + "\n"
            f.write(line)

    # Then try to read it back incorrectly
    with open(path, "r") as f:
        data = json.load(f)  # JSONDecodeError: file has one JSON per line, not valid JSON


async def race_condition_counter(n):
    """Demonstrate race condition on shared state."""
    global shared_counter
    for _ in range(n):
        current = shared_counter
        await asyncio.sleep(0)  # yield to event loop
        shared_counter = current + 1  # lost updates


async def failing_gather():
    """Run multiple tasks that mostly fail."""
    urls = [
        "http://localhost:1/api",
        "http://192.0.2.1/timeout",  # RFC 5737 TEST-NET
        "http://invalid.test/dns-fail",
        "http://localhost:2/refused",
        "http://[::1]:3/ipv6-fail",
    ]

    tasks = [fetch_resource(url) for url in urls]
    results = await asyncio.gather(*tasks, return_exceptions=True)

    errors = [r for r in results if isinstance(r, Exception)]
    print(f"  {len(errors)}/{len(results)} requests failed")
    return results


async def process_with_bad_data():
    """Process intentionally malformed data."""
    bad_batches = [
        [{"value": 10, "name": "alice", "tags": ["a"], "rating": "3"}],
        [{"value": 5, "name": None, "tags": 42, "rating": "bad"}],  # AttributeError, TypeError, ValueError
        [{"value": 1, "divisor": 0, "name": "bob", "tags": [], "rating": "2"}],  # ZeroDivisionError
        [{"no_value_key": 1}],  # KeyError
        [],
    ]

    for i, batch in enumerate(bad_batches):
        try:
            results = await process_batch(batch)
            print(f"  Batch {i}: processed {len(results)} items")
        except Exception as e:
            print(f"  Batch {i}: {type(e).__name__}: {e}")


async def main():
    """Run all error simulations."""
    print("=== Async Worker Error Simulation ===\n")

    print("[1] Network failures (gather):")
    try:
        await failing_gather()
    except Exception as e:
        print(f"  Unexpected: {e}")

    print("\n[2] Bad data processing:")
    await process_with_bad_data()

    print("\n[3] Race condition simulation:")
    global shared_counter
    shared_counter = 0
    tasks = [race_condition_counter(100) for _ in range(10)]
    await asyncio.gather(*tasks)
    expected = 1000
    actual = shared_counter
    print(f"  Expected: {expected}, Got: {actual}, Lost: {expected - actual}")

    print("\n[4] File write/read errors:")
    try:
        await write_results([{"a": 1}, {"b": 2}], "/tmp/error_sim_output.jsonl")
    except Exception as e:
        print(f"  {type(e).__name__}: {e}")

    print("\n=== Simulation Complete ===")


if __name__ == "__main__":
    asyncio.run(main())
