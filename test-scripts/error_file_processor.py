"""File processing with every possible IO and parsing failure."""

import json
import csv
import pickle
import tempfile
import os


def read_nonexistent():
    """Read files that don't exist."""
    with open("/nonexistent/data.json") as f:  # FileNotFoundError
        return json.load(f)


def read_binary_as_text():
    """Read binary file as text."""
    path = tempfile.mktemp(suffix=".bin")
    with open(path, "wb") as f:
        f.write(os.urandom(1024))

    with open(path, "r", encoding="utf-8") as f:
        return f.read()  # UnicodeDecodeError


def write_to_readonly():
    """Write to a read-only location."""
    with open("/proc/cpuinfo", "w") as f:  # PermissionError
        f.write("overwrite system file")


def parse_bad_json():
    """Parse malformed JSON."""
    samples = [
        '{key: "value"}',           # unquoted key
        '{"a": undefined}',          # JS-only undefined
        "{'single': 'quotes'}",      # single quotes
        '{"trailing": "comma",}',    # trailing comma
        '',                           # empty string
        'null',                       # valid but unexpected
        '{"nested": {"deep": {',     # truncated
    ]
    results = []
    for s in samples:
        data = json.loads(s)  # JSONDecodeError
        results.append(data)
    return results


def parse_bad_csv():
    """CSV parsing disasters."""
    bad_data = 'name,age,score\nAlice,25,98\nBob,"unclosed quote\nCharlie,,\n,,,extra,columns'

    reader = csv.DictReader(bad_data.splitlines())
    results = []
    for row in reader:
        score = int(row["score"])  # ValueError on empty string
        age = int(row["age"])      # ValueError on empty
        ratio = score / age         # ZeroDivisionError
        results.append({"name": row["name"], "ratio": ratio})
    return results


def corrupt_pickle():
    """Deserialize corrupt pickle data."""
    corrupt = b'\x80\x04\x95\xff\xff\xff\xff'
    obj = pickle.loads(corrupt)  # UnpicklingError
    return obj


def file_handle_leak():
    """Open files without closing them, then exceed limit."""
    handles = []
    for i in range(100000):
        f = open(f"/tmp/leak_{i}.txt", "w")  # OSError: too many open files
        handles.append(f)
    return handles


def atomic_write_fail():
    """Failed atomic write leaves corrupt state."""
    path = "/tmp/atomic_test.json"

    # Write initial good state
    with open(path, "w") as f:
        json.dump({"version": 1, "data": [1, 2, 3]}, f)

    # "Atomic" update that crashes midway
    with open(path, "w") as f:
        f.write('{"version": 2, "data": [')
        raise IOError("Disk full simulation")  # file now has truncated JSON
        f.write('4, 5, 6]}')


def recursive_directory_walk():
    """Walk a directory that has permission issues and symlink loops."""
    for root, dirs, files in os.walk("/"):
        for f in files:
            path = os.path.join(root, f)
            with open(path) as fh:  # PermissionError on most files
                content = fh.read()
                data = json.loads(content)  # JSONDecodeError on non-JSON


def oversized_read():
    """Try to read more data than memory allows."""
    with open("/dev/zero", "rb") as f:
        data = f.read()  # MemoryError - infinite file


def double_close():
    """Close a file handle twice, then try to use it."""
    f = open("/tmp/double_close_test.txt", "w")
    f.write("hello")
    f.close()
    f.close()  # no error in CPython, but bad practice
    f.write("world")  # ValueError: I/O operation on closed file


if __name__ == "__main__":
    scenarios = [
        ("read nonexistent file", read_nonexistent),
        ("read binary as text", read_binary_as_text),
        ("write to readonly", write_to_readonly),
        ("parse bad JSON", parse_bad_json),
        ("parse bad CSV", parse_bad_csv),
        ("corrupt pickle", corrupt_pickle),
        ("file handle leak", file_handle_leak),
        ("atomic write fail", atomic_write_fail),
        ("recursive dir walk", recursive_directory_walk),
        ("oversized read", oversized_read),
        ("double close", double_close),
    ]

    print(f"=== File Processing Error Simulation ===\n")
    failed = 0
    for name, fn in scenarios:
        try:
            fn()
            print(f"  [OK]   {name}")
        except Exception as e:
            failed += 1
            print(f"  [FAIL] {name}: {type(e).__name__}: {e}")

    print(f"\n{failed}/{len(scenarios)} scenarios errored")
