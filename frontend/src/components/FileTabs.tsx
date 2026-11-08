import { useEffect, useRef, useState } from "react";
import { Download, Plus, Upload, X } from "lucide-react";
import type { T } from "../lib/i18n";
import { ENTRY, type FileEntry } from "../lib/workspace";

interface Props {
  t: T;
  files: FileEntry[];
  activeId: string;
  onSelect(id: string): void;
  onCreate(name: string): string | null; // returns an error message or null
  onRename(id: string, name: string): string | null;
  onDelete(id: string): void;
  onUpload(files: FileList): void;
  onDownload(): void;
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder: string; onDone(v: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [v, setV] = useState(initial);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    const dot = initial.lastIndexOf(".");
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  return (
    <input
      ref={ref}
      className="tab-input"
      value={v}
      placeholder={placeholder}
      size={Math.max(8, v.length + 1)}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onDone(v.trim());
        if (e.key === "Escape") onDone(null);
      }}
      onBlur={() => onDone(v.trim() || null)}
      spellCheck={false}
    />
  );
}

export function FileTabs({ t, files, activeId, onSelect, onCreate, onRename, onDelete, onUpload, onDownload }: Props) {
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 3500);
    return () => clearTimeout(id);
  }, [error]);

  return (
    <div className="tabs-bar">
      <div className="tabs" role="tablist">
        {files.map((f) =>
          renaming === f.id ? (
            <div key={f.id} className="tab is-active">
              <NameInput
                initial={f.name}
                placeholder={t("newFilePlaceholder")}
                onDone={(v) => {
                  if (v && v !== f.name) {
                    const err = onRename(f.id, v);
                    if (err) setError(err);
                  }
                  setRenaming(null);
                }}
              />
            </div>
          ) : (
            <div
              key={f.id}
              role="tab"
              tabIndex={0}
              aria-selected={f.id === activeId}
              className={`tab ${f.id === activeId ? "is-active" : ""}`}
              onClick={() => onSelect(f.id)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(f.id)}
              onDoubleClick={() => f.name !== ENTRY && setRenaming(f.id)}
              title={f.name === ENTRY ? t("entryFile") : t("renameTitle")}
            >
              {f.name === ENTRY && <span className="entry-dot" aria-hidden />}
              <span className="tab-name">{f.name}</span>
              {f.name !== ENTRY && (
                <button
                  className="tab-close"
                  aria-label={`${t("deleteFile")} ${f.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(f.id);
                  }}
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          ),
        )}
        {creating && (
          <div className="tab is-active">
            <NameInput
              initial=""
              placeholder={t("newFilePlaceholder")}
              onDone={(v) => {
                if (v) {
                  const err = onCreate(v);
                  if (err) setError(err);
                }
                setCreating(false);
              }}
            />
          </div>
        )}
        <button className="icon-btn tab-add" onClick={() => setCreating(true)} title={t("newFile")} aria-label={t("newFile")}>
          <Plus size={15} strokeWidth={1.6} />
        </button>
      </div>
      {error && (
        <div className="tabs-error" role="alert">
          {error}
        </div>
      )}
      <div className="tabs-actions">
        <button className="icon-btn" onClick={() => fileInput.current?.click()} title={t("upload")} aria-label={t("upload")}>
          <Upload size={15} strokeWidth={1.6} />
        </button>
        <button className="icon-btn" onClick={onDownload} title={t("download")} aria-label={t("download")}>
          <Download size={15} strokeWidth={1.6} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".py,.txt,.in,.out,.csv,.json,.md"
          hidden
          onChange={(e) => {
            if (e.target.files?.length) onUpload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
