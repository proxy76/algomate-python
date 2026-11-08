# AlgoMate Python

Online Python editor and runner for **python.algomate.ro**. It uses the algomate.ro palette and adds a theme switcher.

- **Editor**: CodeMirror 6 with Python highlighting, autocomplete, bracket matching and search. Files can be added, renamed, deleted, uploaded and downloaded. Work is saved automatically in the browser.
- **Execution**: runs on the server, with output streamed live over WebSocket. Programs can read input interactively (`input()`, pasted test data, EOF with Ctrl+D) and import other workspace files. They can also read and write data files such as `date.in`.
- **Tracebacks**: clicking `File "main.py", line N` in an error jumps to that line.
- **Sharing**: the Share button saves a copy of the files and gives a short link (`/s/<id>`).
- **Themes**: dark (identical to algomate.ro), light or system, plus six accent colours and an adjustable editor font size. The interface is in Romanian, with English available.
- **Examples**: a set of BAC-style example programs (sieve, digit sum, files, recursion, modules, sorting, reading a traceback).

```
frontend/   React + Vite + TypeScript + CodeMirror  →  built to frontend/dist
backend/    FastAPI (REST + WebSocket), serves the built frontend too
sandbox/    Docker image every run executes in (+ launcher.py)
deploy/     install.sh, systemd unit, nginx site, env template
```

## How a run works

```
browser ──ws /api/run──▶ FastAPI ──docker run -i──▶ fresh container
   ▲  stdout/stderr chunks   │      (no network, read-only FS, 256 MB,
   └──────────────────────── │       1 CPU, 64 PIDs, 10 s CPU, tmpfs /workspace)
         stdin lines ────────┘
```

The backend writes a length-prefixed JSON payload with the files to the container's stdin. `sandbox/launcher.py` unpacks it into a tmpfs `/workspace` and then `exec`s `python -u main.py`. Everything after the payload is the program's own stdin. Each run is limited by a wall-clock timeout (120 s, which includes time spent waiting for input), CPU time, memory and output size (1 MB). There is also a global cap on concurrent runs, a per-IP cap and per-IP rate limits.

## Local development

You need Python 3.10+ and Node 18+. Docker is optional for development.

```bash
# backend (SANDBOX=local runs code directly on your machine: dev only!)
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt   # Windows: .venv\Scripts\pip
SANDBOX=local .venv/bin/uvicorn app.main:app --port 8000

# frontend (hot reload, proxies /api to :8000)
cd frontend && npm install && npm run dev       # http://localhost:5173

# tests (use the local sandbox)
cd backend && .venv/bin/python -m pytest -q
```

To test with the real sandbox locally: `docker build -t algomate-python-sandbox sandbox/`, then start the backend without `SANDBOX=local`.

## Deploying on the Proxmox Ubuntu VM

1. **Create the VM**: Ubuntu Server 24.04 (22.04 also works), 2 vCPU, 2–4 GB RAM and 20 GB disk is plenty. Use a full VM, not an LXC container. If you must use LXC, enable `nesting=1,keyctl=1` so Docker works.
2. **Copy the code** to the VM (`git clone …` or `scp -r`), then run:
   ```bash
   sudo ./deploy/install.sh
   ```
   The script installs Docker, nginx, Python and Node, builds the frontend and the sandbox image, and creates the `algomate` service user. It also installs `algomate-python.service` and the nginx site. **Re-run it to deploy updates.** Your nginx and env files are left untouched; set `FORCE_NGINX=1` to rewrite the nginx file.
3. **Publish `python.algomate.ro`**. algomate.ro already uses Cloudflare, so pick one of these:

   **A. Cloudflare Tunnel (recommended for a homelab: no open ports, TLS handled by Cloudflare)**
   ```bash
   # install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
   cloudflared tunnel login
   cloudflared tunnel create algomate-python
   cloudflared tunnel route dns algomate-python python.algomate.ro
   # /etc/cloudflared/config.yml:
   #   tunnel: <TUNNEL-ID>
   #   credentials-file: /root/.cloudflared/<TUNNEL-ID>.json
   #   ingress:
   #     - hostname: python.algomate.ro
   #       service: http://localhost:80
   #     - service: http_status:404
   sudo cloudflared service install && sudo systemctl enable --now cloudflared
   ```
   Then set `TRUST_CLOUDFLARE=1` in `/etc/algomate-python.env` so rate limits see real client IPs, and run `sudo systemctl restart algomate-python`. WebSockets work through tunnels by default.

   **B. Port forwarding + Let's Encrypt**: forward ports 80/443 from your router to the VM. Create a DNS `A` record for `python.algomate.ro` (grey cloud while issuing the certificate). Then run:
   ```bash
   sudo apt install certbot python3-certbot-nginx
   sudo certbot --nginx -d python.algomate.ro
   ```
   If you later turn the Cloudflare proxy (orange cloud) on, uncomment the `real_ip` block in the nginx site.
4. **Check it**: `curl https://python.algomate.ro/api/health` should return `{"ok":true,"sandbox":"docker","python":"3.13.x"}`. To follow the logs: `journalctl -u algomate-python -f`.

### Configuration

All settings live in `/etc/algomate-python.env` (template: `deploy/env.example`). Restart the service after editing. The main ones:

| Variable | Default | Meaning |
|---|---|---|
| `RUN_WALL_TIMEOUT` | 120 | seconds per run, including time waiting for input |
| `RUN_CPU_LIMIT` | 10 | CPU seconds per run |
| `RUN_MEMORY_MB` | 256 | container memory, no swap |
| `MAX_CONCURRENT_RUNS` | 8 | global; extra runs queue for up to 30 s |
| `MAX_RUNS_PER_IP` / `RUNS_PER_MINUTE` | 2 / 30 | per-IP limits |
| `ALLOWED_ORIGINS` | `https://python.algomate.ro` | origins allowed to open the run WebSocket |
| `SANDBOX_RUNTIME` | – | `runsc` to use gVisor |

To give students extra packages (numpy, sympy…), add them to `sandbox/requirements.txt` and re-run `install.sh`. Containers have no network, so `pip install` from user code cannot work.

### Security notes

- User code only runs inside throwaway containers. They run as `nobody`, with all capabilities dropped and `no-new-privileges`. They have no network, a read-only root filesystem, size-limited `noexec` tmpfs mounts, and memory, CPU, PID, file-size and open-file limits.
- The backend's `algomate` account is in the `docker` group, which is effectively root. That is why it is a no-login system account and the service runs under systemd hardening. For defence in depth, install [gVisor](https://gvisor.dev/docs/user_guide/install/) and set `SANDBOX_RUNTIME=runsc`. That gives every run its own user-space kernel.
- Keep the VM itself patched (`unattended-upgrades`). Ideally put it on a separate VLAN/bridge in Proxmox, away from the rest of your LAN.
