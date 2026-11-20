import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(
  new URL("../deploy/launcher-compatible.mjs", import.meta.url),
);

async function fixture(t, sessions, marker) {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-launcher-compat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const release = path.join(dir, "release");
  await mkdir(path.join(release, "lanzador"), { recursive: true });
  const index = path.join(dir, "sesiones.json");
  await writeFile(
    index,
    typeof sessions === "string" ? sessions : JSON.stringify(sessions),
  );
  if (marker !== undefined)
    await writeFile(
      path.join(release, "lanzador/version-registry.mjs"),
      marker,
    );
  return () =>
    spawnSync(process.execPath, [helper, release, index], { encoding: "utf8" });
}

const legacy = [
  { id: "s1", estado: "terminada", terminal: "pantalla sintética" },
];
const migrated = [
  { id: "s1", estado: "terminada", _detalle: "a".repeat(64) + ".json" },
];

test("índice legacy admite una release antigua", async (t) => {
  const run = await fixture(t, legacy);
  assert.equal(run().status, 0);
});

test("índice migrado rechaza una release antigua aunque no haya proceso activo", async (t) => {
  const run = await fixture(t, migrated);
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /incompatible/);
  assert.doesNotMatch(result.stderr, /pantalla sintética/);
});

test("índice migrado admite la capacidad empaquetada de versión 2", async (t) => {
  const run = await fixture(
    t,
    migrated,
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  assert.equal(run().status, 0);
});

test("índice truncado o con referencia inválida nunca autoriza reinicio", async (t) => {
  for (const sessions of [
    "[{",
    {},
    [null],
    [{ id: "s1", estado: "terminada", _detalle: "../privado.json" }],
  ]) {
    const run = await fixture(
      t,
      sessions,
      "export const SESSION_REGISTRY_VERSION = 2;\n",
    );
    assert.equal(run().status, 1);
  }
});

test("la marca se inspecciona como datos y jamás se ejecuta", async (t) => {
  const run = await fixture(
    t,
    migrated,
    "throw new Error('MARCA EJECUTADA');\nexport const SESSION_REGISTRY_VERSION = 2;\n",
  );
  const result = run();
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /MARCA EJECUTADA/);
});

test("selecciona la release compatible retenida cuando current apunta a un rollback antiguo", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-launcher-select-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = path.join(dir, "old");
  const compatible = path.join(dir, "compatible");
  await mkdir(old);
  await mkdir(path.join(compatible, "lanzador"), { recursive: true });
  await writeFile(
    path.join(compatible, "lanzador/version-registry.mjs"),
    "export const SESSION_REGISTRY_VERSION = 2;\n",
  );
  const index = path.join(dir, "sesiones.json");
  await writeFile(index, JSON.stringify(migrated));
  const select = (...releases) =>
    spawnSync(process.execPath, [helper, "--select", index, ...releases], {
      encoding: "utf8",
    });
  assert.equal(select(old, compatible).stdout.trim(), compatible);
  assert.equal(select(compatible, old).stdout.trim(), compatible);
  await writeFile(index, "corrupto");
  assert.equal(select(compatible, old).status, 1);
});

test("la marca real del lanzador cumple también el formato estricto de helpers ya instalados", async (t) => {
  const marker = await readFile(
    new URL("../../lanzador/version-registry.mjs", import.meta.url),
    "utf8",
  );
  // Helpers installed before 0.1.1 only accept a file made of the export line.
  assert.match(
    marker,
    /^\s*export const SESSION_REGISTRY_VERSION = ([1-9]\d*);\s*$/,
  );
  const run = await fixture(t, migrated, marker);
  assert.equal(run().status, 0);
});

test("la marca admite comentarios de línea antes de la exportación", async (t) => {
  const run = await fixture(
    t,
    migrated,
    "// @ts-check\n\nexport const SESSION_REGISTRY_VERSION = 2;\n",
  );
  assert.equal(run().status, 0);
});
