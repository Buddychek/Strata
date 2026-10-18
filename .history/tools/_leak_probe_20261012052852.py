"""Probe: does the guard catch the old leak form?  Run with -W error::ResourceWarning.

The old form (open() inside a generator, no with) must raise; the fixed form must not.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def old_form(root, n):
    return dict(line.split() for line in open(os.path.join(root, str(n), "properties"))
                if len(line.split()) == 2)


def new_form(root, n):
    with open(os.path.join(root, str(n), "properties"), encoding="utf-8") as f:
        return dict(line.split() for line in f if len(line.split()) == 2)


def main() -> int:
    which = sys.argv[1]
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "0"))
        with open(os.path.join(d, "0", "properties"), "w") as f:
            f.write("simd_count 128\nmax_engine_clk_fcompute 2350\n")
        for _ in range(200):
            (old_form if which == "old" else new_form)(d, 0)
    print(f"{which}: no ResourceWarning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
