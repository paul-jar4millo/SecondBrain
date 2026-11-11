// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import {
  Markdown,
  escapeCurrencyDollars,
  sinWikilinks,
} from "../src/components/Markdown";

describe("Markdown de las agentes", () => {
  it("convierte enlaces del vault en su título", () => {
    expect(
      sinWikilinks("Ver [[Prioridades-2026]] y [[02-Areas/Estudio|Estudio]]"),
    ).toBe("Ver Prioridades 2026 y Estudio");
  });
  it("muestra negritas, tablas y código, sin frontmatter ni HTML crudo", () => {
    const { container } = render(
      <Markdown
        texto={
          "---\ntype: diario\n---\n## Hoy\n**listo** y `npm test`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n<img src=x onerror=alert(1)>\n\n[mal](javascript:alert(1))"
        }
      />,
    );
    expect(container.querySelector("h2")?.textContent).toBe("Hoy");
    expect(container.querySelector("strong")?.textContent).toBe("listo");
    expect(container.querySelector("code")?.textContent).toBe("npm test");
    expect(container.querySelectorAll("td")).toHaveLength(2);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("type: diario");
    const enlace = container.querySelector("a");
    expect(enlace?.getAttribute("href") ?? "").not.toMatch(/^javascript:/);
  });
  it("renderiza fórmulas matemáticas con KaTeX en línea y en bloque", () => {
    const { container } = render(
      <Markdown
        texto={
          "Entrada ($x_1, x_2$): manchas $= 0.8$, color $= 0.6$.\n\nCombinación ($z = w_1 x_1 + w_2 x_2 + b$): ej. $z = 2$.\n\nConversión a probabilidad ($\\sigma(z)$): $88.08%$.\n\n$$\nz = w_1 x_1 + b\n$$"
        }
      />,
    );
    expect(container.querySelectorAll(".katex").length).toBeGreaterThan(0);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });
  it("mantiene montos monetarios y rangos en pesos como texto normal sin KaTeX", () => {
    const { container } = render(
      <Markdown
        texto={
          "Pagaste $2,997.00 en LikeU y $1,800.00 en Gold.\n\nEntre $1,200-$1,500 en `code $500` y:\n\n```\n$9,000.00\n```"
        }
      />,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(container.textContent).toContain(
      "Pagaste $2,997.00 en LikeU y $1,800.00 en Gold.",
    );
    expect(container.textContent).toContain("Entre $1,200-$1,500");
    expect(container.querySelector("code")?.textContent).toBe("code $500");
    expect(escapeCurrencyDollars("`$1,200` y $1,200")).toBe(
      "`$1,200` y \\$1,200",
    );
  });
});
