"""Sandboxed execution of user code with streamed, interactive stdio.

Two backends share one protocol (see sandbox/launcher.py):

* ``docker`` — every run is a fresh, network-less, read-only container with
  memory / CPU / PID / disk limits. This is what production uses.
* ``local``  — runs the launcher directly with the host Python. No isolation
  whatsoever; only for developing the UI on a machine without Docker.
"""
from __future__ import annotations

import asyncio
import codecs
import json
import logging
import os
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from .config import Settings

log = logging.getLogger("algomate.runner")

Emit = Callable[[dict], Awaitable[None]]

FILE_NAME_RE = re.compile(r"^(?!.*\.\.)(?!/)[A-Za-z0-9_\-. /]{1,80}$")
CONTAINER_LABEL = "algomate-python=run"


class ValidationError(ValueError):
    pass


def validate_files(files: object, entry: object, settings: Settings) -> tuple[list[dict], str]:
    if not isinstance(files, list) or not files:
        raise ValidationError("no files")
    if len(files) > settings.max_files:
        raise ValidationError(f"too many files (max {settings.max_files})")
    clean: list[dict] = []
    seen: set[str] = set()
    total = 0
    for f in files:
        if not isinstance(f, dict):
            raise ValidationError("bad file")
        name, content = f.get("name"), f.get("content")
        if not isinstance(name, str) or not isinstance(content, str):
            raise ValidationError("bad file")
        name = name.strip()
        if not FILE_NAME_RE.match(name) or name.endswith("/"):
            raise ValidationError(f"invalid file name: {name!r}")
        if name in seen:
            raise ValidationError(f"duplicate file: {name}")
        seen.add(name)
        total += len(content.encode("utf-8"))
        clean.append({"name": name, "content": content})
    if total > settings.max_total_bytes:
        raise ValidationError(f"code too large (max {settings.max_total_bytes // 1000} KB)")
    if not isinstance(entry, str) or entry not in seen or not entry.endswith(".py"):
        raise ValidationError("entry file must be one of the .py files")
    return clean, entry


@dataclass
class RunResult:
    exit_code: int | None
    duration_ms: int
    reason: str | None  # timeout | killed | output_limit | cpu_limit | memory | disconnected | sandbox_error


class Run:
    def __init__(self, settings: Settings, files: list[dict], entry: str, emit: Emit) -> None:
        self.s = settings
        self.files = files
        self.entry = entry
        self.emit = emit
        self.name = f"algopy-{secrets.token_hex(6)}"
        self.proc: asyncio.subprocess.Process | None = None
        self.reason: str | None = None
        self.output_bytes = 0
        self.stdin_bytes = 0
        self._tmpdir: tempfile.TemporaryDirectory | None = None
        self._killing = False
        # Set once the payload header is written; stdin from the client waits for it.
        self._ready = asyncio.Event()

    # ---- command construction -------------------------------------------------
    def _docker_cmd(self) -> list[str]:
        s = self.s
        cmd = [
            s.docker_bin, "run", "--rm", "-i",
            "--name", self.name,
            "--label", CONTAINER_LABEL,
            "--init",  # tini as PID 1, so default signal actions (SIGXCPU…) apply to python
            "--network", "none",
            "--read-only",
            "--tmpfs", f"/workspace:rw,noexec,nosuid,nodev,size={s.workspace_mb}m,mode=1777",
            "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777",
            "--memory", f"{s.memory_mb}m",
            "--memory-swap", f"{s.memory_mb}m",
            "--cpus", s.cpus,
            "--pids-limit", str(s.pids_limit),
            "--ulimit", f"cpu={s.cpu_limit}:{s.cpu_limit + 1}",
            "--ulimit", "nofile=128:128",
            "--ulimit", f"fsize={s.workspace_mb * 1024 * 1024}",
            "--cap-drop", "ALL",
            "--security-opt", "no-new-privileges",
            "--user", "65534:65534",
            "--log-driver", "none",
            "-e", f"CPU_LIMIT={s.cpu_limit}",
        ]
        if s.docker_runtime:
            cmd += ["--runtime", s.docker_runtime]
        cmd.append(s.docker_image)
        return cmd

    def _local_cmd(self) -> tuple[list[str], dict]:
        self._tmpdir = tempfile.TemporaryDirectory(prefix="algopy-")
        env = {
            "PATH": os.environ.get("PATH", ""),
            "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
            "SYSTEMDRIVE": os.environ.get("SYSTEMDRIVE", ""),
            "TEMP": self._tmpdir.name,
            "TMP": self._tmpdir.name,
            "PYTHONUNBUFFERED": "1",
            "PYTHONDONTWRITEBYTECODE": "1",
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUTF8": "1",
            "WORKDIR": self._tmpdir.name,
            "CPU_LIMIT": str(self.s.cpu_limit),
        }
        return [sys.executable, "-u", str(self.s.launcher_path)], env

    # ---- lifecycle ------------------------------------------------------------
    async def execute(self) -> RunResult:
        if self.s.sandbox == "docker":
            cmd, env, extra = self._docker_cmd(), None, {}
        else:
            cmd, env = self._local_cmd()
            extra = {"start_new_session": True} if os.name == "posix" else {}

        started = time.monotonic()
        try:
            self.proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=env,
                **extra,
            )
        except (FileNotFoundError, PermissionError) as exc:
            log.error("cannot start sandbox: %s", exc)
            self._ready.set()
            return RunResult(None, 0, "sandbox_error")

        try:
            payload = json.dumps({"files": self.files, "entry": self.entry}).encode("utf-8")
            assert self.proc.stdin is not None
            self.proc.stdin.write(f"{len(payload)}\n".encode() + payload)
            await self.proc.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            pass
        self._ready.set()

        await self.emit({"type": "started"})

        pumps = asyncio.gather(
            self._pump(self.proc.stdout, "stdout"),
            self._pump(self.proc.stderr, "stderr"),
        )
        try:
            await asyncio.wait_for(asyncio.shield(pumps), timeout=self.s.wall_timeout)
        except asyncio.TimeoutError:
            await self.kill("timeout")
            try:
                await asyncio.wait_for(pumps, timeout=5)
            except asyncio.TimeoutError:
                pumps.cancel()
        except asyncio.CancelledError:
            await self.kill("disconnected")
            raise

        try:
            code = await asyncio.wait_for(self.proc.wait(), timeout=10)
        except asyncio.TimeoutError:
            await self._hard_kill()
            code = await self.proc.wait()
        duration = int((time.monotonic() - started) * 1000)
        self._cleanup()
        return RunResult(code, duration, self.reason or self._classify(code))

    def _classify(self, code: int | None) -> str | None:
        if code in (152, -signal.SIGXCPU if hasattr(signal, "SIGXCPU") else -24):
            return "cpu_limit"
        if self.s.sandbox == "docker":
            if code == 137:
                return "memory"
            if code in (125, 126, 127):
                return "sandbox_error"
        return None

    async def _pump(self, stream: asyncio.StreamReader | None, kind: str) -> None:
        if stream is None:
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await stream.read(16384)
            if not chunk:
                break
            remaining = self.s.max_output_bytes - self.output_bytes
            self.output_bytes += len(chunk)
            if remaining <= 0:
                continue  # keep draining so the process isn't blocked before the kill lands
            if len(chunk) > remaining:
                text = decoder.decode(chunk[:remaining])
                if text:
                    await self.emit({"type": kind, "data": text})
                await self.kill("output_limit")
                continue
            text = decoder.decode(chunk)
            if text:
                await self.emit({"type": kind, "data": text})
        tail = decoder.decode(b"", final=True)
        if tail and self.output_bytes <= self.s.max_output_bytes:
            await self.emit({"type": kind, "data": tail})

    async def _wait_ready(self) -> None:
        try:
            await asyncio.wait_for(self._ready.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass

    async def write_stdin(self, data: str) -> None:
        await self._wait_ready()
        if not self.proc or not self.proc.stdin or self.proc.stdin.is_closing():
            return
        raw = data.encode("utf-8")
        self.stdin_bytes += len(raw)
        if self.stdin_bytes > self.s.max_stdin_bytes:
            return
        try:
            self.proc.stdin.write(raw)
            await asyncio.wait_for(self.proc.stdin.drain(), timeout=2)
        except (BrokenPipeError, ConnectionResetError, asyncio.TimeoutError):
            pass

    async def close_stdin(self) -> None:
        await self._wait_ready()
        if self.proc and self.proc.stdin and not self.proc.stdin.is_closing():
            try:
                self.proc.stdin.close()
            except (BrokenPipeError, ConnectionResetError):
                pass

    async def kill(self, reason: str) -> None:
        if self.reason is None:
            self.reason = reason
        await self._wait_ready()
        if self._killing or not self.proc or self.proc.returncode is not None:
            return
        self._killing = True
        if self.s.sandbox == "docker":
            killer = await asyncio.create_subprocess_exec(
                self.s.docker_bin, "kill", self.name,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(killer.wait(), timeout=10)
            except asyncio.TimeoutError:
                killer.kill()
            # The `docker run` client exits once the container is gone.
        else:
            await self._hard_kill()

    async def _hard_kill(self) -> None:
        if not self.proc or self.proc.returncode is not None:
            return
        try:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            elif self.s.sandbox == "local":
                os.killpg(self.proc.pid, signal.SIGKILL)
            else:
                self.proc.kill()
        except (ProcessLookupError, PermissionError):
            pass

    def _cleanup(self) -> None:
        if self._tmpdir is not None:
            self._tmpdir.cleanup()
            self._tmpdir = None


async def cleanup_stale_containers(settings: Settings) -> None:
    """Remove containers left behind by a previous crash of the backend."""
    if settings.sandbox != "docker":
        return
    try:
        proc = await asyncio.create_subprocess_exec(
            settings.docker_bin, "ps", "-aq", "--filter", f"label={CONTAINER_LABEL}",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out, _ = await proc.communicate()
        ids = out.decode().split()
        if ids:
            log.warning("removing %d stale sandbox containers", len(ids))
            rm = await asyncio.create_subprocess_exec(
                settings.docker_bin, "rm", "-f", *ids,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            await rm.wait()
    except FileNotFoundError:
        log.error("docker binary not found: %s", settings.docker_bin)


async def detect_python_version(settings: Settings) -> str:
    if settings.sandbox == "docker":
        cmd = [settings.docker_bin, "run", "--rm", "--network", "none", "--entrypoint", "python",
               settings.docker_image, "-c", "import platform; print(platform.python_version())"]
    else:
        cmd = [sys.executable, "-c", "import platform; print(platform.python_version())"]
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.DEVNULL)
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=60)
        return out.decode().strip() or "3"
    except (FileNotFoundError, asyncio.TimeoutError):
        return "3"
