"""Runtime settings, read from environment variables (see deploy/env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


def _list(name: str, default: str = "") -> list[str]:
    return [item.strip() for item in os.getenv(name, default).split(",") if item.strip()]


@dataclass(frozen=True)
class Settings:
    # "docker" (production) or "local" (development only — NO isolation).
    sandbox: str = field(default_factory=lambda: os.getenv("SANDBOX", "docker"))
    docker_bin: str = field(default_factory=lambda: os.getenv("DOCKER_BIN", "docker"))
    docker_image: str = field(default_factory=lambda: os.getenv("SANDBOX_IMAGE", "algomate-python-sandbox:latest"))
    # Optional OCI runtime, e.g. "runsc" for gVisor.
    docker_runtime: str = field(default_factory=lambda: os.getenv("SANDBOX_RUNTIME", ""))

    wall_timeout: int = field(default_factory=lambda: _int("RUN_WALL_TIMEOUT", 120))  # s, includes waiting for input
    cpu_limit: int = field(default_factory=lambda: _int("RUN_CPU_LIMIT", 10))  # s of CPU time
    memory_mb: int = field(default_factory=lambda: _int("RUN_MEMORY_MB", 256))
    cpus: str = field(default_factory=lambda: os.getenv("RUN_CPUS", "1"))
    pids_limit: int = field(default_factory=lambda: _int("RUN_PIDS_LIMIT", 64))
    workspace_mb: int = field(default_factory=lambda: _int("RUN_WORKSPACE_MB", 16))
    max_output_bytes: int = field(default_factory=lambda: _int("RUN_MAX_OUTPUT_BYTES", 1_000_000))
    max_stdin_bytes: int = field(default_factory=lambda: _int("RUN_MAX_STDIN_BYTES", 1_000_000))

    max_files: int = field(default_factory=lambda: _int("MAX_FILES", 20))
    max_total_bytes: int = field(default_factory=lambda: _int("MAX_TOTAL_BYTES", 256_000))

    max_concurrent_runs: int = field(default_factory=lambda: _int("MAX_CONCURRENT_RUNS", 8))
    max_runs_per_ip: int = field(default_factory=lambda: _int("MAX_RUNS_PER_IP", 2))
    runs_per_minute: int = field(default_factory=lambda: _int("RUNS_PER_MINUTE", 30))
    shares_per_hour: int = field(default_factory=lambda: _int("SHARES_PER_HOUR", 30))

    db_path: Path = field(default_factory=lambda: Path(os.getenv("DB_PATH", str(ROOT / "backend" / "data" / "snippets.db"))))
    static_dir: Path = field(default_factory=lambda: Path(os.getenv("STATIC_DIR", str(ROOT / "frontend" / "dist"))))
    launcher_path: Path = field(default_factory=lambda: ROOT / "sandbox" / "launcher.py")

    # Empty = accept any Origin (dev). In production: https://python.algomate.ro
    allowed_origins: list[str] = field(default_factory=lambda: _list("ALLOWED_ORIGINS"))
    # Trust CF-Connecting-IP (only enable when the origin is reachable solely via Cloudflare).
    trust_cloudflare: bool = field(default_factory=lambda: os.getenv("TRUST_CLOUDFLARE", "0") == "1")


settings = Settings()
