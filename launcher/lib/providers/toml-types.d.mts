export interface TomlTable {
  [key: string]: TomlValue;
}

// The Codex config reader keeps non-boolean scalars as text.
export type TomlValue = string | boolean | TomlValue[] | TomlTable;
