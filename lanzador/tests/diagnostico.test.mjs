import test from "node:test";
import assert from "node:assert/strict";
import { ocultarDiagnostico } from "../diagnostico.mjs";

test("oculta encargos multilínea aunque stderr los serialice como JSON o cite una línea", () => {
  const brief = 'Encargo privado sintético\nRevisar "archivo reservado"';
  const output = ocultarDiagnostico(
    `Error del motor: ${JSON.stringify({ prompt: brief })}\nRevisar "archivo reservado"`,
    { env: {}, textos: [brief] },
  );
  assert.doesNotMatch(output, /Encargo privado|archivo reservado/);
  assert.match(output, /Error del motor/);
});
