import assert from "node:assert/strict";
import test from "node:test";
import { titleOf } from "../threads/engine/thread-engine.ts";

test("a thread's title is the first sentence of the prompt, without Markdown", () => {
  assert.equal(
    titleOf(
      'Crea `principal.txt` con la línea "padre" y haz commit. Luego pide una sub-tarea.',
    ),
    'Crea principal.txt con la línea "padre" y haz commit',
  );
  assert.equal(titleOf("\n\n# Cambia a.txt\nmás detalle"), "Cambia a.txt");
  assert.equal(
    titleOf(
      "Implementa la exportación de slugify con normalización de acentos y guiones colapsados en todo el texto",
    ),
    "Implementa la exportación de slugify con normalización de…",
  );
  assert.equal(titleOf("   "), "Thread");
});
