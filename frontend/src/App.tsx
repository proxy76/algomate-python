import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, BookOpen, Check, Copy, Link2, Loader2, Play, Square } from "lucide-react";
import { Console, type ConsoleChunk, type LineKind } from "./components/Console";
import { Editor, type JumpRequest } from "./components/Editor";
import { FileTabs } from "./components/FileTabs";
import { Popover } from "./components/Popover";
import { SettingsMenu } from "./components/SettingsMenu";
import { formatDuration, makeT, type Key, type T } from "./lib/i18n";
import { applyTheme, loadPrefs, savePrefs, type Prefs } from "./lib/prefs";
import { RunSession, type ExitInfo } from "./lib/runner";
import {
  backupWorkspace,
  ENTRY,
  EXAMPLES,
  FILE_NAME_RE,
  loadBackup,
  loadWorkspace,
  makeWorkspace,
  MAX_FILES,
  newId,
  saveWorkspace,
  STARTER,
  type Workspace,
} from "./lib/workspace";

type RunState = "idle" | "connecting" | "queued" | "running";
type Outcome = { kind: "ready" } | { kind: "done"; ms: number } | { kind: "failed" };

interface ServerConfig {
  python: string;
  wall_timeout: number;
  cpu_limit: number;
  memory_mb: number;
}

interface Toast {
  id: number;
  text: string;
  action?: { label: string; run(): void };
}

const MAX_CONSOLE_CHARS = 1_500_000;
const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const RUN_KEY = isMac ? "⌘ + Enter" : "Ctrl + Enter";

function mergeChunks(prev: ConsoleChunk[], add: ConsoleChunk[]): ConsoleChunk[] {
  const out = prev.slice();
  for (const c of add) {
    const last = out[out.length - 1];
    if (last && last.kind === c.kind) out[out.length - 1] = { kind: c.kind, text: last.text + c.text };
    else out.push({ ...c });
  }
  let total = out.reduce((n, c) => n + c.text.length, 0);
  while (total > MAX_CONSOLE_CHARS && out.length > 1) total -= out.shift()!.text.length;
  return out;
}

function ShareMenu({ t, workspace }: { t: T; workspace: Workspace }) {
  const [state, setState] = useState<{ status: "loading" | "ok" | "error"; url?: string }>({ status: "loading" });
  const [copied, setCopied] = useState(false);

  const create = async () => {
    setState({ status: "loading" });
    setCopied(false);
    try {
      const res = await fetch("/api/snippets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: workspace.files.map(({ name, content }) => ({ name, content })), entry: ENTRY }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = await res.json();
      const url = `${location.origin}/s/${id}`;
      setState({ status: "ok", url });
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
      } catch {
        /* clipboard blocked: the field below is selectable */
      }
    } catch {
      setState({ status: "error" });
    }
  };

  return (
    <Popover
      className="share"
      trigger={({ open, toggle }) => (
        <button
          className={`tool-btn ${open ? "is-open" : ""}`}
          aria-expanded={open}
          title={t("share")}
          onClick={() => {
            if (!open) create();
            toggle();
          }}
        >
          <Link2 size={16} strokeWidth={1.6} />
          <span className="tool-label">{t("share")}</span>
        </button>
      )}
    >
      {() => (
        <>
          <div className="field-label">{t("shareTitle")}</div>
          {state.status === "loading" && (
            <div className="share-row muted">
              <Loader2 size={14} className="spin" /> …
            </div>
          )}
          {state.status === "error" && <div className="share-row error-text">{t("shareFail")}</div>}
          {state.status === "ok" && (
            <div className="share-row">
              <input readOnly value={state.url} onFocus={(e) => e.currentTarget.select()} aria-label={t("shareTitle")} />
              <button
                className="btn-secondary"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(state.url!);
                    setCopied(true);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
          )}
          <p className="hint">{t("shareHint")}</p>
        </>
      )}
    </Popover>
  );
}

export default function App() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const t = useMemo(() => makeT(prefs.lang), [prefs.lang]);
  const [ws, setWs] = useState<Workspace>(loadWorkspace);
  const [resetKey, setResetKey] = useState(0);
  const [chunks, setChunks] = useState<ConsoleChunk[]>([]);
  const [runState, setRunState] = useState<RunState>("idle");
  const [outcome, setOutcome] = useState<Outcome>({ kind: "ready" });
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [jump, setJump] = useState<JumpRequest | null>(null);
  const [focusToken, setFocusToken] = useState(0);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 860px)").matches);

  const session = useRef<RunSession | null>(null);
  const pending = useRef<ConsoleChunk[]>([]);
  const frame = useRef<number | null>(null);
  const lastChar = useRef("\n"); // last character written to the console
  const splitRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const activeFile = ws.files.find((f) => f.id === ws.activeId) ?? ws.files[0];
  const running = runState !== "idle";

  // ---- prefs & theme ----------------------------------------------------------
  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });
  }, []);

  useEffect(() => {
    applyTheme(prefs.theme, prefs.accent);
    document.documentElement.lang = prefs.lang;
    if (prefs.theme !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system", prefs.accent);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [prefs.theme, prefs.accent, prefs.lang]);

  useEffect(() => {
    const mq = matchMedia("(max-width: 860px)");
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // ---- persistence ------------------------------------------------------------
  useEffect(() => {
    const id = setTimeout(() => saveWorkspace(ws), 300);
    return () => clearTimeout(id);
  }, [ws]);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => c && setConfig(c))
      .catch(() => {});
  }, []);

  // ---- toasts -----------------------------------------------------------------
  const toast = useCallback((text: string, action?: Toast["action"], ms = 5000) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { id, text, action }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), ms);
  }, []);

  const replaceWorkspace = useCallback((next: Workspace) => {
    setWs(next);
    setResetKey((k) => k + 1);
  }, []);

  // ---- shared snippet links (/s/<id>) ----------------------------------------
  useEffect(() => {
    const m = location.pathname.match(/^\/s\/([A-Za-z0-9]{4,16})\/?$/);
    if (!m) return;
    fetch(`/api/snippets/${m[1]}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((snip: { files: { name: string; content: string }[] }) => {
        backupWorkspace(wsRef.current);
        replaceWorkspace(makeWorkspace(snip.files));
        toast(t("loadedSnippet"), {
          label: t("restore"),
          run: () => {
            const b = loadBackup();
            if (b) replaceWorkspace(b);
          },
        }, 10000);
      })
      .catch(() => toast(t("snippetMissing")))
      .finally(() => history.replaceState(null, "", "/"));
    // Only on first load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- console ----------------------------------------------------------------
  const flush = useCallback(() => {
    frame.current = null;
    const add = pending.current;
    pending.current = [];
    if (add.length) setChunks((prev) => mergeChunks(prev, add));
  }, []);

  const push = useCallback(
    (kind: LineKind, text: string) => {
      if (!text) return;
      pending.current.push({ kind, text });
      lastChar.current = text[text.length - 1];
      if (frame.current === null) frame.current = requestAnimationFrame(flush);
    },
    [flush],
  );

  // System messages always start on a fresh line.
  const endLine = (text: string) => (lastChar.current === "\n" ? "" : "\n") + text + "\n";

  const clearConsole = () => {
    pending.current = [];
    lastChar.current = "\n";
    setChunks([]);
  };

  const describeExit = (info: ExitInfo): { kind: LineKind; text: string } => {
    const dur = formatDuration(info.duration_ms);
    if (info.reason) {
      const n =
        info.reason === "timeout" ? config?.wall_timeout : info.reason === "cpu_limit" ? config?.cpu_limit : config?.memory_mb;
      const msg = t(`r_${info.reason}` as Key, { n: n ?? "?" });
      return { kind: info.reason === "killed" ? "system" : "error", text: `── ${msg} · ${dur} ──` };
    }
    return {
      kind: info.code === 0 ? "system" : "error",
      text: `── ${t("exitLine", { code: info.code ?? "?", s: dur })} ──`,
    };
  };

  // ---- run --------------------------------------------------------------------
  const run = useCallback(() => {
    if (session.current && !session.current.done) return;
    clearConsole();
    setRunState("connecting");
    setFocusToken((n) => n + 1);
    const files = wsRef.current.files.map(({ name, content }) => ({ name, content }));
    session.current = new RunSession(files, ENTRY, {
      onQueued: () => setRunState("queued"),
      onStarted: () => setRunState("running"),
      onOutput: (kind, text) => push(kind, text),
      onExit: (info) => {
        flush();
        const { kind, text } = describeExit(info);
        push(kind, endLine(text));
        setRunState("idle");
        setOutcome(info.reason && info.reason !== "killed" ? { kind: "failed" } : { kind: "done", ms: info.duration_ms });
      },
      onError: (code, message) => {
        flush();
        const key = `e_${code}` as Key;
        const known = ["connection", "busy", "rate_limited", "overloaded", "invalid"].includes(code);
        push("error", endLine(known ? t(key, { msg: message }) : message || t("e_connection")));
        setRunState("idle");
        setOutcome({ kind: "failed" });
      },
    });
    // describeExit/endLine read fresh state via closures re-created each render;
    // the session keeps the handlers from the render that started it, which is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [push, flush, t, config]);

  const stop = () => session.current?.kill();

  const sendInput = (text: string) => {
    if (!session.current || session.current.done) return;
    push("stdin", text);
    session.current.stdin(text);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [run]);

  // ---- files ------------------------------------------------------------------
  const validateName = (name: string, exceptId?: string): string | null => {
    if (!FILE_NAME_RE.test(name)) return t("invalidName");
    if (ws.files.some((f) => f.name === name && f.id !== exceptId)) return t("duplicateName", { name });
    return null;
  };

  const createFile = (name: string) => {
    if (ws.files.length >= MAX_FILES) return t("tooManyFiles", { n: MAX_FILES });
    const err = validateName(name);
    if (err) return err;
    const f = { id: newId(), name, content: "" };
    setWs((w) => ({ files: [...w.files, f], activeId: f.id }));
    return null;
  };

  const renameFile = (id: string, name: string) => {
    const err = validateName(name, id);
    if (err) return err;
    setWs((w) => ({ ...w, files: w.files.map((f) => (f.id === id ? { ...f, name } : f)) }));
    return null;
  };

  const deleteFile = (id: string) => {
    const f = ws.files.find((x) => x.id === id);
    if (!f || f.name === ENTRY) return;
    if (f.content.trim() && !confirm(t("confirmDelete", { name: f.name }))) return;
    setWs((w) => {
      const files = w.files.filter((x) => x.id !== id);
      return { files, activeId: w.activeId === id ? files[0].id : w.activeId };
    });
  };

  const uploadFiles = async (list: FileList) => {
    const incoming = await Promise.all(
      Array.from(list).map(async (file) => ({ name: file.name.replace(/[^A-Za-z0-9_\-.]/g, "_"), content: await file.text() })),
    );
    const files = ws.files.slice();
    let lastId = ws.activeId;
    for (const inc of incoming) {
      const existing = files.find((f) => f.name === inc.name);
      if (existing) {
        existing.content = inc.content;
        lastId = existing.id;
      } else if (files.length < MAX_FILES && FILE_NAME_RE.test(inc.name)) {
        const f = { id: newId(), ...inc };
        files.push(f);
        lastId = f.id;
      }
    }
    replaceWorkspace({ files: files.map((f) => ({ ...f })), activeId: lastId });
  };

  const downloadFile = () => {
    const blob = new Blob([activeFile.content], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = activeFile.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const isDirty = ws.files.length > 1 || ws.files[0].content !== STARTER;

  const loadExample = (id: string) => {
    const ex = EXAMPLES.find((e) => e.id === id)!;
    if (isDirty && !confirm(t("confirmExample", { name: ex.title[prefs.lang] }))) return;
    replaceWorkspace(makeWorkspace(ex.files));
    clearConsole();
    setOutcome({ kind: "ready" });
  };

  const resetWorkspace = () => {
    if (!confirm(t("confirmReset"))) return;
    replaceWorkspace(makeWorkspace([{ name: ENTRY, content: STARTER }]));
  };

  const onJump = (name: string, line: number) => {
    const f = ws.files.find((x) => x.name === name);
    if (!f) return;
    setWs((w) => ({ ...w, activeId: f.id }));
    setJump({ fileId: f.id, line, nonce: Date.now() });
  };

  // ---- splitter ---------------------------------------------------------------
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = splitRef.current!;
    const rect = el.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio = narrow ? (ev.clientY - rect.top) / rect.height : (ev.clientX - rect.left) / rect.width;
      el.style.setProperty("--split", String(Math.min(0.8, Math.max(0.2, ratio))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("is-dragging", "is-dragging-v");
      updatePrefs({ split: Number(el.style.getPropertyValue("--split")) || prefs.split });
    };
    document.body.classList.add("is-dragging", ...(narrow ? ["is-dragging-v"] : []));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onSplitterKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.03;
    const dec = narrow ? "ArrowUp" : "ArrowLeft";
    const inc = narrow ? "ArrowDown" : "ArrowRight";
    if (e.key === dec || e.key === inc) {
      e.preventDefault();
      updatePrefs({ split: Math.min(0.8, Math.max(0.2, prefs.split + (e.key === inc ? step : -step))) });
    }
  };

  useEffect(() => {
    splitRef.current?.style.setProperty("--split", String(prefs.split));
  }, [prefs.split]);

  // ---- status -----------------------------------------------------------------
  const statusText =
    runState === "connecting"
      ? t("st_connecting")
      : runState === "queued"
        ? t("st_queued")
        : runState === "running"
          ? t("st_running")
          : outcome.kind === "done"
            ? t("st_done", { s: formatDuration(outcome.ms) })
            : outcome.kind === "failed"
              ? t("st_failed")
              : t("st_ready");
  const statusTone = running ? "live" : outcome.kind === "failed" ? "bad" : outcome.kind === "done" ? "good" : "idle";

  return (
    <div className="app" style={{ ["--editor-font-size" as string]: `${prefs.fontSize}px` }}>
      <div className="glow" aria-hidden />
      <header className="topbar">
        <a className="brand" href="https://algomate.ro" title={t("backToSite")}>
          ALGO<span>MATE</span>
        </a>
        <span className="brand-sub">
          <span className="slash">/</span>python
        </span>

        <nav className="tools">
          <Popover
            align="left"
            className="examples"
            trigger={({ open, toggle }) => (
              <button className={`tool-btn ${open ? "is-open" : ""}`} onClick={toggle} aria-expanded={open} title={t("examples")}>
                <BookOpen size={16} strokeWidth={1.6} />
                <span className="tool-label">{t("examples")}</span>
              </button>
            )}
          >
            {(close) => (
              <ul className="menu">
                {EXAMPLES.map((ex, i) => (
                  <li key={ex.id}>
                    <button
                      onClick={() => {
                        close();
                        loadExample(ex.id);
                      }}
                    >
                      <span className="menu-num">{String(i + 1).padStart(2, "0")}</span>
                      {ex.title[prefs.lang]}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Popover>
          <ShareMenu t={t} workspace={ws} />
          <SettingsMenu t={t} prefs={prefs} onChange={updatePrefs} onReset={resetWorkspace} />
        </nav>

        {running ? (
          <button className="run-btn is-stop" onClick={stop}>
            <Square size={13} fill="currentColor" strokeWidth={0} />
            <span>{t("stop")}</span>
          </button>
        ) : (
          <button className="run-btn" onClick={run} title={RUN_KEY}>
            <Play size={14} fill="currentColor" strokeWidth={0} />
            <span>{t("run")}</span>
            <kbd>{RUN_KEY}</kbd>
          </button>
        )}
      </header>

      <main className={`split ${narrow ? "is-vertical" : ""}`} ref={splitRef}>
        <section className="panel editor-panel" aria-label="Editor">
          <FileTabs
            t={t}
            files={ws.files}
            activeId={activeFile.id}
            onSelect={(id) => setWs((w) => ({ ...w, activeId: id }))}
            onCreate={createFile}
            onRename={renameFile}
            onDelete={deleteFile}
            onUpload={uploadFiles}
            onDownload={downloadFile}
          />
          <Editor
            file={activeFile}
            resetKey={resetKey}
            fontSize={prefs.fontSize}
            jump={jump}
            onChange={(id, content) =>
              setWs((w) => ({ ...w, files: w.files.map((f) => (f.id === id ? { ...f, content } : f)) }))
            }
            onRun={run}
            onSave={() => {
              saveWorkspace(wsRef.current);
              toast(t("saved"), undefined, 2000);
            }}
            onCursor={(line, col) => setCursor({ line, col })}
          />
        </section>

        <div
          className="splitter"
          role="separator"
          aria-orientation={narrow ? "horizontal" : "vertical"}
          aria-valuenow={Math.round(prefs.split * 100)}
          aria-valuemin={20}
          aria-valuemax={80}
          tabIndex={0}
          onPointerDown={startDrag}
          onKeyDown={onSplitterKey}
        />

        <Console
          t={t}
          chunks={chunks}
          running={running}
          fileNames={ws.files.map((f) => f.name)}
          runKeyLabel={RUN_KEY}
          focusToken={focusToken}
          onSend={sendInput}
          onEof={() => session.current?.eof()}
          onClear={clearConsole}
          onJump={onJump}
        >
          <span className={`status-pill tone-${statusTone}`}>
            {running && <span className="pulse" aria-hidden />}
            {statusText}
          </span>
        </Console>
      </main>

      <footer className="statusbar">
        <span className={`dot tone-${statusTone}`} aria-hidden />
        <span>{statusText}</span>
        <span className="spacer" />
        {config && <span className="hide-sm">{t("limits", { cpu: config.cpu_limit, mem: config.memory_mb })}</span>}
        <span>Python {config?.python ?? "3"}</span>
        <span className="hide-sm">
          Ln {cursor.line}, Col {cursor.col}
        </span>
        <a className="hide-sm" href="https://algomate.ro" target="_blank" rel="noreferrer">
          algomate.ro <ArrowUpRight size={11} />
        </a>
      </footer>

      <div className="toasts" aria-live="polite">
        {toasts.map((x) => (
          <div key={x.id} className="toast">
            <span>{x.text}</span>
            {x.action && (
              <button
                onClick={() => {
                  x.action!.run();
                  setToasts((ts) => ts.filter((y) => y.id !== x.id));
                }}
              >
                {x.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
