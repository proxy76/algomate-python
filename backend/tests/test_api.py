"""End-to-end tests using the *local* sandbox (no Docker needed).

    cd backend && SANDBOX=local DB_PATH=/tmp/t.db python -m pytest -q
"""
import os
import sys
import tempfile

os.environ.setdefault("SANDBOX", "local")
os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(), "snippets.db"))
os.environ.setdefault("RUN_WALL_TIMEOUT", "5")
os.environ.setdefault("RUN_MAX_OUTPUT_BYTES", "20000")

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

client = TestClient(app)


def run(files, entry="main.py", stdin=None):
    out, err, exit_msg = "", "", None
    with client.websocket_connect("/api/run") as ws:
        ws.send_json({"type": "run", "files": files, "entry": entry})
        if stdin is not None:
            ws.send_json({"type": "stdin", "data": stdin})
            ws.send_json({"type": "eof"})
        while True:
            msg = ws.receive_json()
            if msg["type"] == "stdout":
                out += msg["data"]
            elif msg["type"] == "stderr":
                err += msg["data"]
            elif msg["type"] in ("exit", "error"):
                exit_msg = msg
                break
    norm = lambda t: t.replace(chr(13) + chr(10), chr(10))  # noqa: E731 (Windows dev boxes)
    return norm(out), norm(err), exit_msg


def test_hello():
    out, err, ex = run([{"name": "main.py", "content": "print('salut, ă î ș ț')"}])
    assert out == "salut, ă î ș ț\n"
    assert ex["type"] == "exit" and ex["code"] == 0 and ex["reason"] is None


def test_stdin_and_modules():
    files = [
        {"name": "main.py", "content": "from util import dublu\nn = int(input('n = '))\nprint(dublu(n))"},
        {"name": "util.py", "content": "def dublu(x):\n    return 2 * x\n"},
    ]
    out, _, ex = run(files, stdin="21\n")
    assert out == "n = 42\n"
    assert ex["code"] == 0


def test_data_files():
    files = [
        {"name": "main.py", "content": "print(sum(map(int, open('date.in').read().split())))"},
        {"name": "date.in", "content": "1 2 3\n4"},
    ]
    out, _, _ = run(files)
    assert out == "10\n"


def test_traceback_on_stderr():
    out, err, ex = run([{"name": "main.py", "content": "x = 1\n1 / 0\n"}])
    assert "ZeroDivisionError" in err and "line 2" in err
    assert ex["code"] == 1


def test_timeout():
    _, _, ex = run([{"name": "main.py", "content": "input()"}])
    assert ex["reason"] == "timeout"


def test_output_limit():
    out, _, ex = run([{"name": "main.py", "content": "while True: print('x' * 100)"}])
    assert ex["reason"] == "output_limit"
    assert len(out.encode()) <= 20000


def test_rejects_bad_names():
    _, _, ex = run([{"name": "../evil.py", "content": ""}], entry="../evil.py")
    assert ex["type"] == "error" and ex["code"] == "invalid"


def test_snippets_roundtrip():
    files = [{"name": "main.py", "content": "print(1)"}]
    r = client.post("/api/snippets", json={"files": files, "entry": "main.py"})
    assert r.status_code == 200
    sid = r.json()["id"]
    g = client.get(f"/api/snippets/{sid}")
    assert g.status_code == 200 and g.json()["files"] == files
    assert client.get("/api/snippets/nope!").status_code == 404
