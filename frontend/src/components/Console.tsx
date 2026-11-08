import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, Eraser } from "lucide-react";
import type { T } from "../lib/i18n";

export type LineKind = "stdout" | "stderr" | "stdin" | "system" | "error";

export interface ConsoleChunk {
  kind: LineKind;
  text: string;
}

interface Props {
  t: T;
  chunks: ConsoleChunk[];
  running: boolean;
  fileNames: string[];
  runKeyLabel: string;
  focusToken: number;
  onSend(text: string): void;
  onEof(): void;
  onClear(): void;
  onJump(fileName: string, line: number): void;
  children?: ReactNode; // status pill in the header
}

const TRACE_RE = /File "([^"]+)", line (\d+)/g;

/** Map sandbox paths like /workspace/main.py back to workspace file names. */
function toWorkspaceName(path: string, names: string[]): string | null {
  const norm = path.replace(/\\/g, "/");
  const m = norm.match(/(?:^|\/)(?:workspace|algopy-[^/]+)\/(.+)$/);
  const rel = m ? m[1] : norm;
  return names.includes(rel) ? rel : null;
}

function renderStderr(text: string, names: string[], onJump: Props["onJump"]): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TRACE_RE)) {
    const name = toWorkspaceName(m[1], names);
    if (!name) continue;
    const idx = m.index!;
    parts.push(text.slice(last, idx));
    const line = Number(m[2]);
    parts.push(
      <button key={idx} className="trace-link" onClick={() => onJump(name, line)}>
        File "{name}", line {line}
      </button>,
    );
    last = idx + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

export function Console({ t, chunks, running, fileNames, runKeyLabel, focusToken, onSend, onEof, onClear, onJump, children }: Props) {
  const outRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);

  // Auto-scroll unless the user scrolled up to read something.
  useLayoutEffect(() => {
    const el = outRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chunks]);

  useEffect(() => {
    if (focusToken) inputRef.current?.focus({ preventScroll: true });
  }, [focusToken]);

  const send = (text: string) => {
    onSend(text);
    if (text.trim()) setHistory((h) => [...h.slice(-49), text.replace(/\n$/, "")]);
    setHistIdx(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send(value + "\n");
      setValue("");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
      e.preventDefault();
      if (value) send(value);
      setValue("");
      onEof();
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const i = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setValue(history[i]);
    } else if (e.key === "ArrowDown" && histIdx !== null) {
      e.preventDefault();
      const i = histIdx + 1;
      if (i >= history.length) {
        setHistIdx(null);
        setValue("");
      } else {
        setHistIdx(i);
        setValue(history[i]);
      }
    }
  };

  // Pasting several lines sends them all at once (typical for test data).
  const onPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\r\n/g, "\n");
    if (!text.includes("\n")) return;
    e.preventDefault();
    const full = value + text;
    const lastNl = full.lastIndexOf("\n");
    send(full.slice(0, lastNl + 1));
    setValue(full.slice(lastNl + 1));
  };

  const empty = chunks.length === 0;

  return (
    <section className="panel console" aria-label={t("console")}>
      <header className="panel-head">
        <span className="label">{t("console")}</span>
        {children}
        <span className="spacer" />
        <button className="icon-btn" onClick={onClear} title={t("clear")} aria-label={t("clear")} disabled={empty}>
          <Eraser size={15} strokeWidth={1.6} />
        </button>
      </header>

      <div
        className="console-out"
        ref={outRef}
        role="log"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onClick={() => {
          if (running && !window.getSelection()?.toString()) inputRef.current?.focus({ preventScroll: true });
        }}
      >
        {empty ? (
          <div className="console-empty">
            <p className="console-empty-title">{t("emptyTitle")}</p>
            <p className="console-empty-hint">{t("emptyHint", { key: runKeyLabel })}</p>
          </div>
        ) : (
          <pre>
            {chunks.map((c, i) => (
              <Fragment key={i}>
                {c.kind === "system" || c.kind === "error" ? (
                  <span className={`c-${c.kind}`}>{c.text}</span>
                ) : (
                  <span className={`c-${c.kind}`}>
                    {c.kind === "stderr" ? renderStderr(c.text, fileNames, onJump) : c.text}
                  </span>
                )}
              </Fragment>
            ))}
            {running && <span className="caret" aria-hidden />}
          </pre>
        )}
      </div>

      <div className={`console-in ${running ? "is-live" : ""}`}>
        <span className="prompt" aria-hidden>
          ›
        </span>
        <input
          ref={inputRef}
          value={value}
          disabled={!running}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={running ? t("inputRunning") : t("inputIdle")}
          aria-label={t("inputRunning")}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
        />
        <button
          className="icon-btn"
          disabled={!running}
          onClick={() => {
            send(value + "\n");
            setValue("");
            inputRef.current?.focus();
          }}
          aria-label="Enter"
          title="Enter"
        >
          <CornerDownLeft size={15} strokeWidth={1.6} />
        </button>
        <button className="eof-btn" disabled={!running} onClick={onEof} title={t("eofTitle")}>
          {t("eof")}
        </button>
      </div>
    </section>
  );
}
