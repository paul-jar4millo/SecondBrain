import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  readdir,
} from "node:fs/promises";

import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { discoverVault, hash } from "../vault.mjs";

import { fixture, item, mutate } from "./helpers/vault-fixture.mjs";

test("a prompt can create a project and then tasks pointing to its client id", () =>
  fixture(async ({ vault }) => {
    const project = item("project", { title: "Mudanza", status: "active" });
    await mutate(vault, project);
    const task = item("task", {
      title: "Cotizar camión",
      status: "pending",
      projectId: project.id,
    });
    await mutate(vault, task);
    const { items } = await vault.snapshot();
    assert.equal(items.find((x) => x.title === "Mudanza")?.id, project.id);
    assert.equal(
      items.find((x) => x.title === "Cotizar camión")?.projectId,
      project.id,
    );
  }));

test("discovers the real vault from a nested checkout without a prompt", () =>
  fixture(async ({ root }) => {
    await mkdir(path.join(root, "apps/web"), { recursive: true });
    assert.equal(await discoverVault(path.join(root, "apps/web")), root);
  }));

test("reads existing Obsidian notes, projects and checkboxes without rewriting their files", () =>
  fixture(async ({ root, vault, write }) => {
    const text =
      "---\ntype: proyecto\nstatus: active\ncustom: keep-me\n---\n# Trabajo\n\n- [ ] Siguiente paso 📅 2026-11-10\n- [x] Listo\n\n```md\n- [ ] Esto es un ejemplo\n```\n";
    await write("01-Proyectos/Trabajo.md", text);
    const snapshot = await vault.snapshot();
    const project = snapshot.items.find((i) => i.kind === "project");
    assert.equal(project.title, "Trabajo");
    const tasks = snapshot.items.filter((i) => i.kind === "task");
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].projectId, project.id);
    assert.equal(tasks[0].date, "2026-11-10");
    assert.equal(tasks[1].status, "done");
    assert.equal(
      await readFile(path.join(root, "01-Proyectos/Trabajo.md"), "utf8"),
      text,
    );
    assert.deepEqual(await readdir(path.join(root, "00-Inbox")), []);
  }));

test("edits the original Markdown, preserving unknown YAML/comments, body and verification dates", () =>
  fixture(async ({ root, vault, write }) => {
    await write(
      "03-Recursos/Idea.md",
      "---\ntype: nota\nverified: 2026-10-01\nexpires: 2026-10-31\ncustom: 42 # retain this\n---\n# Idea\n\nTexto anterior.\n",
    );
    const note = (await vault.snapshot()).items.find((i) => i.title === "Idea");
    const result = await mutate(vault, {
      ...note,
      body: "# Idea\n\nTexto nuevo.\n",
    });
    const raw = await readFile(path.join(root, note.vaultPath), "utf8");
    assert.match(raw, /Texto nuevo/);
    assert.match(raw, /custom: 42 # retain this/);
    assert.match(raw, /verified: 2026-10-01/);
    assert.equal(result.version, hash(raw));
    assert.equal((await readdir(path.join(root, "03-Recursos"))).length, 1);
  }));

test("reflects external Obsidian edits, additions, renames and removals on the next read", () =>
  fixture(async ({ root, vault, write }) => {
    await write("03-Recursos/Uno.md", "# Uno\nTexto 1");
    let record = (await vault.snapshot()).items.find((i) => i.title === "Uno");
    await mutate(vault, record);
    record = (await vault.snapshot()).items.find((i) => i.title === "Uno");
    await rename(
      path.join(root, record.vaultPath),
      path.join(root, "03-Recursos/Renombrado.md"),
    );
    let current = (await vault.snapshot()).items.find(
      (i) => i.id === record.id,
    );
    assert.equal(current.vaultPath, "03-Recursos/Renombrado.md");
    await write(
      "03-Recursos/Renombrado.md",
      (await readFile(path.join(root, current.vaultPath), "utf8")).replace(
        "Texto 1",
        "Desde Obsidian",
      ),
    );
    assert.match(
      (await vault.snapshot()).items.find((i) => i.id === record.id).body,
      /Desde Obsidian/,
    );
    await rm(path.join(root, current.vaultPath));
    assert.ok(!(await vault.snapshot()).items.some((i) => i.id === record.id));
  }));

test("never overwrites an externally edited note with a stale browser revision", () =>
  fixture(async ({ root, vault, write }) => {
    await write("00-Inbox/Nota.md", "# Nota\nOriginal");
    const note = (await vault.snapshot()).items.find((i) => i.title === "Nota");
    await write("00-Inbox/Nota.md", "# Nota\nCambio externo");
    await assert.rejects(
      mutate(vault, { ...note, body: "Mi borrador" }),
      (e) => e.status === 409 && e.server.body.includes("Cambio externo"),
    );
    assert.match(
      await readFile(path.join(root, note.vaultPath), "utf8"),
      /Cambio externo/,
    );
  }));

test("updates native checkboxes in place and preserves unrelated text and external edits", () =>
  fixture(async ({ root, vault, write }) => {
    const file = "01-Proyectos/Pasos.md";
    await write(
      file,
      "# Pasos\n\n- [ ] Uno 📅 2026-11-10\n- [ ] Dos\n\nContexto.\n",
    );
    let first = (await vault.snapshot()).items.find(
      (i) => i.kind === "task" && i.title === "Uno",
    );
    await write(
      file,
      (await readFile(path.join(root, file), "utf8")).replace(
        "Contexto.",
        "Contexto externo.",
      ),
    );
    const operation = randomUUID();
    const saved = await mutate(vault, { ...first, status: "done" }, operation);
    assert.equal(saved.status, "done");
    const raw = await readFile(path.join(root, file), "utf8");
    assert.match(raw, /- \[x\] Uno 📅 2026-11-10/);
    assert.match(raw, /- \[ \] Dos/);
    assert.match(raw, /Contexto externo/);
    assert.equal(
      (await mutate(vault, { ...first, status: "done" }, operation)).id,
      first.id,
    );
    assert.equal(
      (await vault.snapshot()).items.filter((i) => i.kind === "task").length,
      2,
    );
  }));

test("creates readable native files, an index and stable identities instead of SQL rows", () =>
  fixture(async ({ root, vault }) => {
    const note = await mutate(
      vault,
      item("note", { title: "Una idea", body: "Texto legible en Obsidian." }),
    );
    assert.match(note.vaultPath, /00-Inbox\/App\/.*\.md$/);
    const raw = await readFile(path.join(root, note.vaultPath), "utf8");
    assert.match(raw, /type: nota/);
    assert.match(raw, /Texto legible/);
    assert.match(
      await readFile(path.join(root, "00-Inbox/_App.md"), "utf8"),
      /Una idea/,
    );
    const again = await vault.snapshot();
    assert.equal(
      again.items.find((i) => i.id === note.id).version,
      note.version,
    );
  }));

test("ignores application code, secrets, hidden folders and symlinks outside the vault", (t) =>
  fixture(async ({ root, vault, write }) => {
    await write("apps/private.md", "# Not a note");
    await write(".git/secret.md", "# Ignore");
    const outside = await mkdtemp(path.join(tmpdir(), "sb-outside-"));
    try {
      await writeFile(path.join(outside, "Secret.md"), "# Secret");
      let linked = true;
      try {
        await symlink(
          path.join(outside, "Secret.md"),
          path.join(root, "00-Inbox/Escape.md"),
        );
      } catch (e) {
        if (process.platform !== "win32" || e.code !== "EPERM") throw e;
        linked = false;
        t.diagnostic(
          "Windows no permite crear symlinks; esa aserción se verifica en CI Linux.",
        );
      }
      const snapshot = await vault.snapshot();
      assert.ok(
        !snapshot.items.some((i) =>
          ["Secret", "Not a note", "Ignore"].includes(i.title),
        ),
      );
      if (linked)
        await assert.rejects(
          vault.safe("00-Inbox/Escape.md"),
          (e) => e.status === 403,
        );
      await assert.rejects(
        vault.safe("../outside.md"),
        (e) => e.status === 403,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  }));

test("exposes invalid YAML for repair and refuses to clobber it", () =>
  fixture(async ({ vault, write }) => {
    await write("00-Inbox/Mala.md", "---\nlist: [broken\n---\n# Mala");
    const note = (await vault.snapshot()).items.find((i) => i.title === "Mala");
    assert.ok(note.validationErrors?.length);
    await assert.rejects(
      mutate(vault, { ...note, body: "changed" }),
      /frontmatter/,
    );
  }));

test("rejects invalid imports before creating files and skips duplicate IDs", () =>
  fixture(async ({ vault, root }) => {
    const first = item("note", { title: "Imported" });
    await assert.rejects(
      vault.import([first, item("account", { accountType: "invalid" })]),
    );
    assert.equal((await readdir(path.join(root, "00-Inbox"))).length, 0);
    await vault.import([first]);
    assert.equal((await vault.import([first])).imported, 0);
  }));

test("new tasks are native Markdown checkboxes; editing them in Obsidian controls their status", () =>
  fixture(async ({ vault, root }) => {
    const task = await mutate(
      vault,
      item("task", { title: "Tarea nueva", status: "pending" }),
    );
    assert.equal(task.sourceKind, "inline-task");
    const full = path.join(root, task.vaultPath);
    const raw = await readFile(full, "utf8");
    assert.match(raw, /- \[ \] Tarea nueva/);
    await writeFile(
      full,
      raw.replace("[ ] Tarea nueva", "[x] Tarea nueva editada"),
    );
    const changed = (await vault.snapshot()).items.find(
      (i) => i.id === task.id,
    );
    assert.equal(changed.status, "done");
    assert.equal(changed.title, "Tarea nueva editada");
    await assert.rejects(
      mutate(vault, { ...task, status: "doing" }),
      (e) => e.status === 409,
    );
  }));

test("creates a project task inside its existing Obsidian project note", () =>
  fixture(async ({ root, vault, write }) => {
    await write(
      "01-Proyectos/Existente.md",
      "---\ntype: proyecto\nstatus: active\n---\n# Existente\n\nTexto original.\n",
    );
    const project = (await vault.snapshot()).items.find(
      (i) => i.kind === "project",
    );
    const task = await mutate(
      vault,
      item("task", { title: "Avanzar", projectId: project.id }),
    );
    assert.equal(task.vaultPath, project.vaultPath);
    const raw = await readFile(path.join(root, project.vaultPath), "utf8");
    assert.match(raw, /Texto original/);
    assert.match(raw, /- \[ \] Avanzar/);
    assert.match(
      await readFile(path.join(root, "00-Inbox/_App.md"), "utf8"),
      /#\^sb-/,
    );
  }));

test("concurrent app writes to separate tasks in one note do not overwrite each other", () =>
  fixture(async ({ root, vault, write }) => {
    await write("00-Inbox/Lista.md", "# Lista\n- [ ] Uno\n- [ ] Dos\n");
    const tasks = (await vault.snapshot()).items.filter(
      (i) => i.kind === "task",
    );
    await Promise.all(
      tasks.map((t) => mutate(vault, { ...t, status: "done" })),
    );
    const raw = await readFile(path.join(root, "00-Inbox/Lista.md"), "utf8");
    assert.match(raw, /- \[x\] Uno/);
    assert.match(raw, /- \[x\] Dos/);
  }));

test("supports flat Obsidian properties and does not schedule project templates as real projects", () =>
  fixture(async ({ vault, write }) => {
    await write(
      "02-Areas/Agenda.md",
      '---\ntype: event\ntitle: Evento externo\ndate: 2026-11-06\nendDate: 2026-11-06\ntime: "19:00"\nendTime: "20:00"\ntimezone: America/Mexico_City\n---\nContexto\n',
    );
    await write(
      "99-Meta/Templates/Proyecto.md",
      "---\ntype: proyecto\n---\n# Plantilla\n",
    );
    const snapshot = await vault.snapshot();
    assert.equal(
      snapshot.items.find((i) => i.title === "Evento externo").startsAt,
      "2026-11-07T01:00:00Z",
    );
    assert.equal(
      snapshot.items.find((i) => i.title === "Plantilla").kind,
      "note",
    );
  }));

test("rolls back earlier files if a multi-file import fails halfway through", () =>
  fixture(async ({ vault }) => {
    const first = item("note", { title: "First" });
    const second = item("note", { title: "Second" });
    const atomic = vault.atomic.bind(vault);
    vault.atomic = async (relative, text, expected) => {
      if (relative.includes(second.id))
        throw new Error("injected disk failure");
      return atomic(relative, text, expected);
    };
    await assert.rejects(vault.import([first, second]), /disk failure/);
    const snapshot = await vault.snapshot();
    assert.ok(
      !snapshot.items.some((i) => i.id === first.id || i.id === second.id),
    );
    assert.ok(!snapshot.byPath.has("00-Inbox/_App.md"));
  }));

test("recovers interrupted writes and preserves subsequent external edits", () =>
  fixture(async ({ root, vault, write }) => {
    const { Journal } = await import("../journal.mjs");
    await write("00-Inbox/Recovery.md", "# Before");
    const journal = new Journal(vault, vault.journalDirectory);
    await journal.record("00-Inbox/Recovery.md", "# Before", "# After");
    await write("00-Inbox/Recovery.md", "# After");
    await vault.recover();
    assert.equal(
      await readFile(path.join(root, "00-Inbox/Recovery.md"), "utf8"),
      "# Before",
    );
    const second = new Journal(vault, vault.journalDirectory);
    await second.record("00-Inbox/Recovery.md", "# Before", "# App version");
    await write("00-Inbox/Recovery.md", "# External edit");
    await vault.recover();
    assert.equal(
      await readFile(path.join(root, "00-Inbox/Recovery.md"), "utf8"),
      "# External edit",
    );
    assert.equal(vault.recoveryWarnings.length, 1);
  }));

test("discovers notes in custom Obsidian folders as well as PARA", () =>
  fixture(async ({ vault, write }) => {
    await write("Mi carpeta/Nueva.md", "# Nueva nota\nTexto");
    assert.ok(
      (await vault.snapshot()).items.some((i) => i.title === "Nueva nota"),
    );
  }));

test("reports duplicate native block IDs instead of silently editing the wrong note", () =>
  fixture(async ({ vault, write }) => {
    const id = randomUUID();
    await write("00-Inbox/Uno.md", `# Uno\n- [ ] Primera ^sb-${id}\n`);
    await write("00-Inbox/Dos.md", `# Dos\n- [ ] Segunda ^sb-${id}\n`);
    const snapshot = await vault.snapshot();
    const tasks = snapshot.items.filter((i) => i.kind === "task");
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((i) => i.validationErrors.length));
    await assert.rejects(
      mutate(vault, { ...tasks[0], status: "done" }),
      /frontmatter/,
    );
  }));

test("malformed external property types remain visible without breaking the whole vault", () =>
  fixture(async ({ vault, write }) => {
    await write(
      "02-Areas/Finanzas/Incorrecto.md",
      "---\ntype: transaction\ntitle:\n  nested: title\ndate: 20261106\namountMinor: wrong\naccountId: 123\ntransactionType: expense\nstatus: confirmed\n---\nContenido conservado.",
    );
    const snapshot = await vault.read();
    const record = snapshot.items.find((i) =>
      i.vaultPath.endsWith("Incorrecto.md"),
    );
    assert.equal(typeof record.title, "string");
    assert.equal(typeof record.date, "string");
    assert.ok(record.validationErrors.length);
    assert.match(record.body, /Contenido conservado/);
    assert.equal((await vault.ledger()).length, 0);
  }));

test("a task survives text that would close its HTML comment", () =>
  fixture(async ({ vault }) => {
    const task = item("task", {
      title: "Revisar flecha --> aquí",
      status: "pending",
      body: "nota con --> dentro",
    });
    await mutate(vault, task);
    const saved = (await vault.snapshot()).items.find((x) => x.id === task.id);
    assert.equal(saved?.title, "Revisar flecha --> aquí");
    assert.equal(saved?.body, "nota con --> dentro");
  }));

test("a task title cannot contain a line break", () =>
  fixture(async ({ vault }) => {
    await assert.rejects(
      mutate(
        vault,
        item("task", { title: "uno\n- [ ] dos", status: "pending" }),
      ),
      /título/i,
    );
  }));
