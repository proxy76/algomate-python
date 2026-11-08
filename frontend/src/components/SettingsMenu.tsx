import { Check, Minus, Monitor, Moon, Plus, Settings2, Sun } from "lucide-react";
import type { Lang, T } from "../lib/i18n";
import { ACCENTS, type Prefs, type ThemeMode } from "../lib/prefs";
import { Popover } from "./Popover";

interface Props {
  t: T;
  prefs: Prefs;
  onChange(patch: Partial<Prefs>): void;
  onReset(): void;
}

const MODES: { id: ThemeMode; icon: typeof Sun; key: "dark" | "light" | "system" }[] = [
  { id: "dark", icon: Moon, key: "dark" },
  { id: "light", icon: Sun, key: "light" },
  { id: "system", icon: Monitor, key: "system" },
];

export function SettingsMenu({ t, prefs, onChange, onReset }: Props) {
  return (
    <Popover
      className="settings"
      trigger={({ open, toggle }) => (
        <button className={`tool-btn ${open ? "is-open" : ""}`} onClick={toggle} aria-expanded={open} title={t("settings")}>
          <Settings2 size={16} strokeWidth={1.6} />
          <span className="tool-label">{t("settings")}</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="field">
            <div className="field-label">{t("theme")}</div>
            <div className="segmented" role="radiogroup" aria-label={t("theme")}>
              {MODES.map(({ id, icon: Icon, key }) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={prefs.theme === id}
                  className={prefs.theme === id ? "is-on" : ""}
                  onClick={() => onChange({ theme: id })}
                >
                  <Icon size={14} strokeWidth={1.7} />
                  {t(key)}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <div className="field-label">{t("accent")}</div>
            <div className="swatches" role="radiogroup" aria-label={t("accent")}>
              {ACCENTS.map((a) => (
                <button
                  key={a.id}
                  role="radio"
                  aria-checked={prefs.accent === a.id}
                  aria-label={a.label}
                  title={a.label}
                  className={`swatch ${prefs.accent === a.id ? "is-on" : ""}`}
                  style={{ background: a.swatch }}
                  onClick={() => onChange({ accent: a.id })}
                >
                  {prefs.accent === a.id && <Check size={13} strokeWidth={2.6} />}
                </button>
              ))}
            </div>
          </div>

          <div className="field field-row">
            <div className="field-label">{t("fontSize")}</div>
            <div className="stepper">
              <button aria-label="−" onClick={() => onChange({ fontSize: Math.max(11, prefs.fontSize - 1) })}>
                <Minus size={13} />
              </button>
              <span>{prefs.fontSize}px</span>
              <button aria-label="+" onClick={() => onChange({ fontSize: Math.min(24, prefs.fontSize + 1) })}>
                <Plus size={13} />
              </button>
            </div>
          </div>

          <div className="field field-row">
            <div className="field-label">{t("language")}</div>
            <div className="segmented segmented-sm">
              {(["ro", "en"] as Lang[]).map((l) => (
                <button key={l} className={prefs.lang === l ? "is-on" : ""} onClick={() => onChange({ lang: l })}>
                  {l.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          <button
            className="link-danger"
            onClick={() => {
              close();
              onReset();
            }}
          >
            {t("resetWorkspace")}
          </button>
        </>
      )}
    </Popover>
  );
}
