/** Per-device preferences. Vault data never lives here. */
const defaults = {
  startView: "/",
  defaultAgent: "ambar",
  financeAgent: "ambar",
};
type Preference = keyof typeof defaults;
const keys: Record<Preference, string> = {
  startView: "sb-start-view",
  defaultAgent: "sb-default-agent",
  financeAgent: "sb-finance-agent",
};

export function preference(name: Preference) {
  try {
    return localStorage.getItem(keys[name]) || defaults[name];
  } catch {
    return defaults[name];
  }
}

export function setPreference(name: Preference, value: string) {
  try {
    localStorage.setItem(keys[name], value);
  } catch {
    // Private windows may refuse storage; the choice simply does not persist.
  }
}
