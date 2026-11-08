import { useEffect, useRef } from "react";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { FileEntry } from "../lib/workspace";

// Every color is a CSS variable, so theme/accent switches restyle the editor
// without reconfiguring CodeMirror.
const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--editor-font-size)", backgroundColor: "var(--editor-bg)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--gutter)", border: "none", paddingLeft: "6px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-2)" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 10px 0 6px", minWidth: "32px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--text-4)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--accent-soft)",
    outline: "1px solid var(--accent-line)",
  },
  ".cm-searchMatch": { backgroundColor: "var(--accent-soft)", outline: "1px solid var(--accent-line)" },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  ".cm-flash-line": { backgroundColor: "var(--accent-soft)", transition: "background-color 1.2s ease" },
  ".cm-tooltip": { backgroundColor: "var(--surface-3)", border: "1px solid var(--border-strong)", color: "var(--text)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--accent-fg)" },
  ".cm-panels": { backgroundColor: "var(--surface-2)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-panel input, .cm-panel button": { fontFamily: "var(--font-sans)", fontSize: "12px" },
  ".cm-textfield": { backgroundColor: "var(--editor-bg)", border: "1px solid var(--border-strong)", color: "var(--text)" },
  ".cm-button": { backgroundImage: "none", backgroundColor: "var(--surface-3)", border: "1px solid var(--border-strong)", color: "var(--text)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--surface-3)", border: "1px solid var(--border-strong)", color: "var(--text-2)" },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "var(--syn-keyword)" },
  { tag: [t.bool, t.null, t.self], color: "var(--syn-constant)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.function(t.definition(t.variableName)), t.function(t.variableName)], color: "var(--syn-function)" },
  { tag: [t.definition(t.className), t.className], color: "var(--syn-class)" },
  { tag: [t.standard(t.variableName)], color: "var(--syn-builtin)" },
  { tag: [t.propertyName, t.attributeName], color: "var(--syn-property)" },
  { tag: [t.operator, t.punctuation, t.bracket], color: "var(--syn-operator)" },
  { tag: [t.meta], color: "var(--syn-decorator)" },
  { tag: [t.escape], color: "var(--syn-constant)" },
  { tag: [t.invalid], color: "var(--danger)" },
]);

export interface JumpRequest {
  fileId: string;
  line: number;
  nonce: number;
}

interface Props {
  file: FileEntry;
  resetKey: number; // bumps when the whole workspace is replaced
  fontSize: number;
  jump: JumpRequest | null;
  onChange(id: string, content: string): void;
  onRun(): void;
  onSave(): void;
  onCursor(line: number, col: number): void;
}

export function Editor({ file, resetKey, fontSize, jump, onChange, onRun, onSave, onCursor }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Cached editor state per file id (keeps undo history), plus the name it was built for.
  const states = useRef(new Map<string, { state: EditorState; name: string }>());
  const current = useRef<{ id: string; name: string } | null>(null);
  const cb = useRef({ onChange, onRun, onSave, onCursor });
  cb.current = { onChange, onRun, onSave, onCursor };

  const makeState = (f: FileEntry) =>
    EditorState.create({
      doc: f.content,
      extensions: [
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: () => (cb.current.onRun(), true) },
            { key: "Shift-Enter", run: () => (cb.current.onRun(), true) },
            { key: "Mod-s", run: () => (cb.current.onSave(), true), preventDefault: true },
          ]),
        ),
        basicSetup,
        keymap.of([indentWithTab]),
        indentUnit.of("    "),
        EditorState.tabSize.of(4),
        f.name.endsWith(".py") ? python() : [],
        theme,
        syntaxHighlighting(highlight),
        EditorView.contentAttributes.of({ "aria-label": `Editor ${f.name}`, spellcheck: "false" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) cb.current.onChange(f.id, u.state.doc.toString());
          if (u.selectionSet || u.docChanged || u.focusChanged) {
            const pos = u.state.selection.main.head;
            const line = u.state.doc.lineAt(pos);
            cb.current.onCursor(line.number, pos - line.from + 1);
          }
        }),
      ],
    });

  // Create the view once.
  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    return () => view.current?.destroy();
  }, []);

  // Forget cached states when the workspace is replaced (example, shared link…).
  useEffect(() => {
    states.current.clear();
    current.current = null;
  }, [resetKey]);

  // Swap documents when the active file changes, keeping per-file undo history.
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    if (current.current?.id === file.id && current.current.name === file.name) return;
    if (current.current) states.current.set(current.current.id, { state: v.state, name: current.current.name });
    const cached = states.current.get(file.id);
    // Language depends on the name, so a renamed file gets a fresh state.
    const next =
      cached && cached.name === file.name && cached.state.doc.toString() === file.content
        ? cached.state
        : makeState(file);
    v.setState(next);
    current.current = { id: file.id, name: file.name };
    const pos = next.selection.main.head;
    const line = next.doc.lineAt(pos);
    cb.current.onCursor(line.number, pos - line.from + 1);
  }, [file.id, file.name, resetKey]);

  useEffect(() => {
    view.current?.requestMeasure();
  }, [fontSize]);

  // Jump to a line (from a clickable traceback).
  useEffect(() => {
    const v = view.current;
    if (!v || !jump || jump.fileId !== file.id) return;
    const line = v.state.doc.line(Math.min(Math.max(jump.line, 1), v.state.doc.lines));
    v.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    });
    v.focus();
  }, [jump, file.id]);

  return <div className="editor-host" ref={host} />;
}
