"""Memory and resource management disasters for error simulation."""

import gc
import sys
import weakref


class CircularNode:
    """Nodes that leak via circular references."""
    def __init__(self, name):
        self.name = name
        self.children = []
        self.parent = None
        self._cache = {}

    def add_child(self, child):
        self.children.append(child)
        child.parent = self  # circular ref

    def __del__(self):
        raise RuntimeError(f"Destructor crash for {self.name}")  # __del__ exception


def leak_circular_refs():
    """Create circular references that crash on GC."""
    nodes = []
    for i in range(50):
        parent = CircularNode(f"parent-{i}")
        child = CircularNode(f"child-{i}")
        parent.add_child(child)
        child.add_child(parent)  # circular
        nodes.append(parent)

    del nodes  # triggers __del__ crashes
    gc.collect()


def overflow_recursion(n=0):
    """Stack overflow via unbounded recursion."""
    return overflow_recursion(n + 1) + 1  # RecursionError


def exhaust_generator():
    """Generator that raises mid-iteration."""
    for i in range(100):
        if i == 42:
            raise StopIteration("Manual StopIteration")  # deprecated pattern
        if i % 7 == 0:
            yield i / (i - 21)  # ZeroDivisionError at i=21
        yield i


def broken_context_manager():
    """Context manager that fails on enter and exit."""
    class BadManager:
        def __enter__(self):
            raise OSError("Failed to acquire resource")
        def __exit__(self, *args):
            raise RuntimeError("Failed to release resource")

    with BadManager() as resource:
        resource.do_something()


def misuse_weakref():
    """Access dead weakrefs."""
    class Obj:
        def __init__(self, val):
            self.val = val

    obj = Obj(42)
    ref = weakref.ref(obj)
    del obj
    print(ref().val)  # AttributeError: NoneType has no attribute 'val'


def bad_slots_class():
    """Class with __slots__ misuse."""
    class Strict:
        __slots__ = ('x', 'y')

    s = Strict()
    s.x = 1
    s.z = 3  # AttributeError: 'Strict' has no attribute 'z'
    return s


def string_encoding_hell():
    """Encoding/decoding disasters."""
    raw = b'\x80\x81\x82\xff\xfe'
    text = raw.decode('utf-8')  # UnicodeDecodeError

    emoji = "🔥💀"
    ascii_bytes = emoji.encode('ascii')  # UnicodeEncodeError

    mixed = "café"
    wrong = mixed.encode('utf-8').decode('ascii')  # UnicodeDecodeError


def number_disasters():
    """Numeric edge cases that blow up."""
    results = []

    results.append(float('inf') - float('inf'))  # nan
    results.append(float('nan') == float('nan'))  # False, logic bugs

    import math
    results.append(math.sqrt(-1))  # ValueError
    results.append(math.log(0))    # ValueError
    results.append(math.factorial(-1))  # ValueError

    huge = 10 ** 10000
    results.append(float(huge))  # OverflowError

    return results


def unpacking_errors():
    """Destructuring / unpacking gone wrong."""
    a, b, c = [1, 2]  # ValueError: not enough values
    x, y = [1, 2, 3]  # ValueError: too many values

    data = {"key": "value"}
    a, b = data  # only gets keys, not key-value pairs

    first, *middle, last = []  # ValueError: not enough values


def bad_inheritance():
    """MRO and inheritance disasters."""
    class A:
        def method(self):
            return super().method()  # AttributeError at top of MRO

    class B(A):
        pass

    class C(A):
        def method(self):
            return super().method() + 1  # TypeError: can't add int to None

    class D(B, C):
        pass

    d = D()
    d.method()  # MRO chaos + AttributeError


def descriptor_hell():
    """Property/descriptor failures."""
    class Broken:
        @property
        def value(self):
            return self._value  # AttributeError: _value not set

        @value.setter
        def value(self, v):
            if v < 0:
                raise ValueError("Negative!")
            self._value = v

    b = Broken()
    print(b.value)  # AttributeError
    b.value = -5    # ValueError


if __name__ == "__main__":
    errors = [
        ("circular refs", leak_circular_refs),
        ("recursion overflow", overflow_recursion),
        ("broken generator", lambda: list(exhaust_generator())),
        ("bad context manager", broken_context_manager),
        ("dead weakref", misuse_weakref),
        ("slots misuse", bad_slots_class),
        ("encoding hell", string_encoding_hell),
        ("number disasters", number_disasters),
        ("unpacking errors", unpacking_errors),
        ("bad inheritance", bad_inheritance),
        ("descriptor hell", descriptor_hell),
    ]

    print(f"Running {len(errors)} error scenarios...\n")
    failed = 0
    for name, fn in errors:
        try:
            fn()
            print(f"  [PASS] {name} (unexpected)")
        except Exception as e:
            failed += 1
            print(f"  [FAIL] {name}: {type(e).__name__}: {e}")

    print(f"\n{failed}/{len(errors)} scenarios failed")
