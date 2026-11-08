#!/usr/bin/env python3
"""Sandbox entrypoint.

Reads one length-prefixed JSON payload from stdin:

    <byte length>\n{"files": [{"name": "main.py", "content": "..."}], "entry": "main.py"}

writes the files into WORKDIR, then replaces itself with `python -u <entry>`.
Everything left on stdin after the payload belongs to the user program, so the
header is read with raw os.read() calls that never consume more than they need.
"""
import json
import os
import sys

MAX_HEADER_DIGITS = 9  # payload < 1 GB; the backend enforces a far lower cap


def fail(message: str) -> None:
    sys.stderr.write(f"[sandbox] {message}\n")
    sys.exit(2)


def read_exact(n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = os.read(0, n - len(buf))
        if not chunk:
            fail("payload truncated")
        buf += chunk
    return bytes(buf)


def read_payload() -> dict:
    digits = bytearray()
    while True:
        b = os.read(0, 1)
        if not b:
            fail("missing payload")
        if b == b"\n":
            break
        digits += b
        if len(digits) > MAX_HEADER_DIGITS or not b.isdigit():
            fail("bad payload header")
    return json.loads(read_exact(int(digits)).decode("utf-8"))


def safe_join(root: str, name: str) -> str:
    norm = os.path.normpath(name.replace("\\", "/"))
    if os.path.isabs(norm) or norm == ".." or norm.startswith(".." + os.sep) or norm.startswith("../"):
        fail(f"invalid file name: {name!r}")
    return os.path.join(root, norm)


def main() -> None:
    payload = read_payload()
    workdir = os.path.abspath(os.environ.get("WORKDIR", "/workspace"))
    os.makedirs(workdir, exist_ok=True)

    for f in payload["files"]:
        path = safe_join(workdir, f["name"])
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="") as fh:
            fh.write(f["content"])

    entry = payload["entry"]
    os.chdir(workdir)

    cpu = int(os.environ.get("CPU_LIMIT", "0") or 0)
    if cpu > 0:
        try:
            import resource

            # soft < hard so the kernel sends SIGXCPU (reported as "CPU limit"),
            # not SIGKILL (indistinguishable from the OOM killer).
            resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu + 1))
        except (ImportError, ValueError, OSError):
            pass

    argv = [sys.executable, "-u", entry]
    if os.name == "posix":
        os.execv(sys.executable, argv)
    # Windows (local dev only): execv is emulated there and would detach us
    # from the parent's pipes, so run as a child and forward the exit code.
    import subprocess

    sys.exit(subprocess.call(argv))


if __name__ == "__main__":
    main()
