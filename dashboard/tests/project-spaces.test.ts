import { describe, it, expect } from "vitest";
import { espaciosDe } from "../src/features/sala/sala-espacios";

describe("project spaces", () => {
  it("uses the actual Mundo project identity instead of adding a second fixed project", () => {
    const spaces = espaciosDe([
      {
        id: "real-id",
        kind: "project",
        title: "Mundo Hipotético",
        vaultPath: "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
      },
    ]);
    expect(spaces.filter((p) => p.titulo === "Mundo Hipotético")).toHaveLength(
      1,
    );
    expect(spaces.find((p) => p.titulo === "Mundo Hipotético")?.id).toBe(
      "real-id",
    );
  });
});
