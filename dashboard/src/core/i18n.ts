import { useSyncExternalStore } from "react";
import { en } from "../i18n/en";
import { es, type MessageKey } from "../i18n/es";

export type Lang = "es" | "en";
export const LANGS: readonly Lang[] = ["es", "en"];
const dictionaries: Record<Lang, Record<MessageKey, string>> = { es, en };
const storageKey = "sb-lang";

const isLang = (value: unknown): value is Lang =>
  value === "es" || value === "en";

/** ?lang= wins, then the saved choice, then the build default (VITE_DEFAULT_LANG). */
export function initialLang(): Lang {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (isLang(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(storageKey);
    if (isLang(saved)) return saved;
  } catch {
    /* storage may be blocked */
  }
  const fallback = import.meta.env.VITE_DEFAULT_LANG;
  return isLang(fallback) ? fallback : "es";
}

let current: Lang = initialLang();
const listeners = new Set<() => void>();
document.documentElement.lang = current;

export const getLang = () => current;

export function setLang(lang: Lang) {
  if (lang === current) return;
  current = lang;
  document.documentElement.lang = lang;
  try {
    localStorage.setItem(storageKey, lang);
  } catch {
    /* storage may be blocked */
  }
  listeners.forEach((listener) => listener());
}

export function onLangChange(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Re-renders the caller when the language changes. */
export const useLang = () => useSyncExternalStore(onLangChange, getLang);

/** Translates a key; `{name}` placeholders are filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>) {
  const text = dictionaries[current][key] ?? es[key];
  return vars
    ? text.replace(/\{(\w+)\}/g, (_, name: string) =>
        String(vars[name] ?? `{${name}}`),
      )
    : text;
}

export { dictionaries };
