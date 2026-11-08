import type { Lang } from "./i18n";

export type ThemeMode = "dark" | "light" | "system";
export type Accent = "orange" | "emerald" | "sky" | "violet" | "rose" | "amber";

export const ACCENTS: { id: Accent; label: string; swatch: string }[] = [
  { id: "orange", label: "AlgoMate", swatch: "#e8734a" },
  { id: "amber", label: "Amber", swatch: "#e8b84a" },
  { id: "emerald", label: "Emerald", swatch: "#3ecf8e" },
  { id: "sky", label: "Sky", swatch: "#4fb3f0" },
  { id: "violet", label: "Violet", swatch: "#a78bfa" },
  { id: "rose", label: "Rose", swatch: "#f06a8a" },
];

export interface Prefs {
  theme: ThemeMode;
  accent: Accent;
  fontSize: number;
  lang: Lang;
  split: number; // editor share of the workspace, 0..1
}

const KEY = "algomate-python:prefs";

export const DEFAULT_PREFS: Prefs = {
  theme: "dark",
  accent: "orange",
  fontSize: 14,
  lang: "ro", // AlgoMate is a Romanian site; English is one click away in Settings
  split: 0.6,
};

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULT_PREFS, ...raw };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode) — prefs just won't persist */
  }
}

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
  if (mode !== "system") return mode;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(mode: ThemeMode, accent: Accent): void {
  const root = document.documentElement;
  const resolved = resolveTheme(mode);
  root.dataset.theme = resolved;
  root.dataset.accent = accent;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", resolved === "dark" ? "#0a0a0a" : "#f6f5f2");
}
