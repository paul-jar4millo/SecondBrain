// A temporary vault with sample notes, plus helpers to build items and
// mutations, for the server tests.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Vault } from "../../vault.mjs";

export async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-vault-"));
  for (const dir of [
    "00-Inbox",
    "01-Proyectos",
    "02-Areas/Finanzas",
    "03-Recursos",
    "04-Archivo",
    "99-Meta",
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Mi vault\n");
  const vault = new Vault(root);
  try {
    await fn({
      root,
      vault,
      write: async (relative, body) => {
        await mkdir(path.dirname(path.join(root, relative)), {
          recursive: true,
        });
        await writeFile(path.join(root, relative), body);
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export const item = (kind, data = {}) => ({
  id: randomUUID(),
  kind,
  title: "Prueba " + kind,
  version: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...data,
});

export const mutate = (vault, entity, mutationId = randomUUID()) =>
  vault.mutate({ mutationId, baseVersion: entity.version, entity });
