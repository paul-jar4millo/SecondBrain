/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "es" (default) or "en": first language before the user picks one. */
  readonly VITE_DEFAULT_LANG?: string;
  /** "1" builds a backend-less demo (GitHub Pages). */
  readonly VITE_DEMO?: string;
}
