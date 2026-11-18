// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { en } from "../src/i18n/en";
import { es } from "../src/i18n/es";
import { dictionaries, setLang, t } from "../src/core/i18n";

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n dictionaries", () => {
  it("have the same keys in Spanish and English", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(es).sort());
  });

  it("never leave a translation empty", () => {
    for (const dictionary of Object.values(dictionaries))
      for (const [key, value] of Object.entries(dictionary))
        expect(value.trim(), key).not.toBe("");
  });

  it("keep the same placeholders in every language", () => {
    for (const key of Object.keys(es) as (keyof typeof es)[])
      expect(placeholders(en[key]), key).toEqual(placeholders(es[key]));
  });

  it("translates and switches language at runtime", () => {
    setLang("es");
    expect(t("tools.settings")).toBe("Ajustes");
    setLang("en");
    expect(t("tools.settings")).toBe("Settings");
    expect(document.documentElement.lang).toBe("en");
    setLang("es");
  });
});
