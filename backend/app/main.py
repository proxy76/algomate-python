"""AlgoMate Python — FastAPI backend.

Routes
  GET  /api/health          liveness + sandbox info
  GET  /api/config          limits shown in the UI
  POST /api/snippets        save a shareable snippet  -> {"id": "..."}
  GET  /api/snippets/{id}   load a snippet
  WS   /api/run             run code; streams stdout/stderr, accepts stdin
  GET  /*                   built frontend (SPA fallback to index.html)
"""
from __future__ import annotations

import asyncio
import logging
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .config import settings
from .ratelimit import RateLimiter
from .runner import Run, ValidationError, cleanup_stale_containers, detect_python_version, validate_files
from .snippets import SnippetStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("algomate")

SNIPPET_ID_RE = re.compile(r"^[A-Za-z0-9]{4,16}$")

state: dict = {"python_version": "3"}
store = SnippetStore(settings.db_path)
run_limiter = RateLimiter(settings.runs_per_minute, 60)
share_limiter = RateLimiter(settings.shares_per_hour, 3600)
run_slots = asyncio.Semaphore(settings.max_concurrent_runs)
active_per_ip: dict[str, int] = {}


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.sandbox == "local":
        log.warning("SANDBOX=local: user code runs UNISOLATED on this machine. Development only!")
    await cleanup_stale_containers(settings)
    state["python_version"] = await detect_python_version(settings)
    log.info("sandbox=%s python=%s", settings.sandbox, state["python_version"])
    yield


app = FastAPI(title="AlgoMate Python", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; "
        "connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'self'",
    )
    return response


def client_ip(headers, client) -> str:
    if settings.trust_cloudflare and headers.get("cf-connecting-ip"):
        return headers["cf-connecting-ip"]
    return client.host if client else "unknown"


# ---- REST ----------------------------------------------------------------------
@app.get("/api/health")
async def health():
    return {"ok": True, "sandbox": settings.sandbox, "python": state["python_version"]}


@app.get("/api/config")
async def config():
    return {
        "python": state["python_version"],
        "wall_timeout": settings.wall_timeout,
        "cpu_limit": settings.cpu_limit,
        "memory_mb": settings.memory_mb,
        "max_output_bytes": settings.max_output_bytes,
        "max_files": settings.max_files,
        "max_total_bytes": settings.max_total_bytes,
    }


class SnippetIn(BaseModel):
    files: list[dict]
    entry: str


@app.post("/api/snippets")
def create_snippet(body: SnippetIn, request: Request):
    if not share_limiter.allow(client_ip(request.headers, request.client)):
        raise HTTPException(429, "too many shares, try again later")
    try:
        files, entry = validate_files(body.files, body.entry, settings)
    except ValidationError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"id": store.create(files, entry)}


@app.get("/api/snippets/{sid}")
def get_snippet(sid: str):
    if not SNIPPET_ID_RE.match(sid):
        raise HTTPException(404, "not found")
    snippet = store.get(sid)
    if snippet is None:
        raise HTTPException(404, "not found")
    return snippet


# ---- WebSocket run -------------------------------------------------------------
async def _send(ws: WebSocket, message: dict) -> None:
    try:
        await ws.send_json(message)
    except (WebSocketDisconnect, RuntimeError):
        pass


@app.websocket("/api/run")
async def run_ws(ws: WebSocket):
    origin = ws.headers.get("origin")
    if settings.allowed_origins and origin not in settings.allowed_origins:
        await ws.close(code=1008)
        return
    await ws.accept()
    ip = client_ip(ws.headers, ws.client)

    try:
        first = await asyncio.wait_for(ws.receive_json(), timeout=15)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        await ws.close()
        return

    async def fail(code: str, message: str) -> None:
        await _send(ws, {"type": "error", "code": code, "message": message})
        await ws.close()

    if not isinstance(first, dict) or first.get("type") != "run":
        return await fail("bad_request", "expected a run message")
    try:
        files, entry = validate_files(first.get("files"), first.get("entry"), settings)
    except ValidationError as exc:
        return await fail("invalid", str(exc))
    if active_per_ip.get(ip, 0) >= settings.max_runs_per_ip:
        return await fail("busy", "too many programs running from your address")
    if not run_limiter.allow(ip):
        return await fail("rate_limited", "too many runs, wait a minute")

    active_per_ip[ip] = active_per_ip.get(ip, 0) + 1
    try:
        if run_slots.locked():
            await _send(ws, {"type": "queued"})
        try:
            await asyncio.wait_for(run_slots.acquire(), timeout=30)
        except asyncio.TimeoutError:
            return await fail("overloaded", "server is busy, try again shortly")
        try:
            await _run_session(ws, files, entry)
        finally:
            run_slots.release()
    finally:
        active_per_ip[ip] -= 1
        if active_per_ip[ip] <= 0:
            del active_per_ip[ip]


async def _run_session(ws: WebSocket, files: list[dict], entry: str) -> None:
    run = Run(settings, files, entry, lambda msg: _send(ws, msg))
    run_task = asyncio.create_task(run.execute())

    async def receive_loop() -> None:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            kind = msg.get("type")
            if kind == "stdin" and isinstance(msg.get("data"), str):
                await run.write_stdin(msg["data"][:65536])
            elif kind == "eof":
                await run.close_stdin()
            elif kind == "kill":
                await run.kill("killed")

    recv_task = asyncio.create_task(receive_loop())
    done, _ = await asyncio.wait({run_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
    if recv_task in done:  # client went away (or sent garbage) before the program ended
        await run.kill("disconnected")
    result = await run_task
    if recv_task.done():
        recv_task.exception()  # mark as retrieved; disconnects are expected here
    else:
        recv_task.cancel()
    await _send(ws, {
        "type": "exit",
        "code": result.exit_code,
        "duration_ms": result.duration_ms,
        "reason": result.reason,
    })
    try:
        await ws.close()
    except RuntimeError:
        pass


# ---- Frontend ------------------------------------------------------------------
static_dir: Path = settings.static_dir
if (static_dir / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=static_dir / "assets"), name="assets")


@app.get("/{path:path}", include_in_schema=False)
async def spa(path: str):
    if path.startswith("api/"):
        return JSONResponse({"detail": "not found"}, status_code=404)
    index = static_dir / "index.html"
    if not index.is_file():
        return JSONResponse({"detail": "frontend not built (run `npm run build` in frontend/)"}, status_code=503)
    candidate = (static_dir / path).resolve()
    if path and candidate.is_file() and static_dir.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(index, headers={"Cache-Control": "no-cache"})
