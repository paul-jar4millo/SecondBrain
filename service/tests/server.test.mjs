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
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Vault, discoverVault, hash } from "../vault.mjs";
import { createApplication } from "../index.mjs";
import { totp } from "../auth.mjs";

async function fixture(fn) {
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
const item = (kind, data = {}) => ({
  id: randomUUID(),
  kind,
  title: "Prueba " + kind,
  version: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...data,
});
const mutate = (vault, entity, mutationId = randomUUID()) =>
  vault.mutate({ mutationId, baseVersion: entity.version, entity });

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
test("derives a balanced ledger from the same Markdown records, with no double-counted card payments", () =>
  fixture(async ({ vault }) => {
    const a = await mutate(
      vault,
      item("account", { accountType: "asset", currency: "MXN" }),
    );
    const c = await mutate(
      vault,
      item("account", { accountType: "credit", currency: "MXN" }),
    );
    await mutate(
      vault,
      item("transaction", {
        transactionType: "opening",
        amountMinor: 100000,
        accountId: a.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    const expense = await mutate(
      vault,
      item("transaction", {
        transactionType: "expense",
        amountMinor: 12000,
        accountId: c.id,
        category: "Personal",
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    await mutate(
      vault,
      item("transaction", {
        transactionType: "payment",
        amountMinor: 12000,
        accountId: a.id,
        otherAccountId: c.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    const ledger = await vault.ledger();
    const sum = (id) =>
      ledger
        .filter((x) => x.account === id)
        .reduce((n, x) => n + x.debit - x.credit, 0);
    assert.equal(sum(a.id), 88000);
    assert.equal(sum(c.id), 0);
    assert.equal(sum("expense:Personal"), 12000);
    assert.equal(
      ledger.reduce((n, x) => n + x.debit - x.credit, 0),
      0,
    );
    await assert.rejects(
      mutate(vault, { ...expense, title: "overwrite" }),
      /confirmados/,
    );
  }));
test("excludes malformed externally edited financial records from totals, while showing the source and errors", () =>
  fixture(async ({ root, vault }) => {
    const account = await mutate(
      vault,
      item("account", { accountType: "asset" }),
    );
    const transaction = await mutate(
      vault,
      item("transaction", {
        transactionType: "expense",
        amountMinor: 1000,
        accountId: account.id,
        date: "2026-11-06",
        status: "confirmed",
      }),
    );
    await writeFile(
      path.join(root, transaction.vaultPath),
      (await readFile(path.join(root, transaction.vaultPath), "utf8")).replace(
        "amountMinor: 1000",
        "amountMinor: wrong",
      ),
    );
    const snapshot = await vault.snapshot();
    assert.ok(
      snapshot.items.find((i) => i.id === transaction.id).validationErrors
        .length,
    );
    assert.equal((await vault.ledger()).length, 0);
    assert.ok(snapshot.issues.length);
  }));
test("monthly recurrence preserves the day anchor through February and cannot duplicate its next occurrence", () =>
  fixture(async ({ vault }) => {
    const task = await mutate(
      vault,
      item("task", {
        date: "2027-01-31",
        recurrence: "monthly",
        status: "pending",
      }),
    );
    const op = randomUUID();
    await mutate(vault, { ...task, status: "done" }, op);
    await mutate(vault, { ...task, status: "done" }, op);
    let next = (await vault.snapshot()).items.filter(
      (i) => i.kind === "task" && i.date === "2027-02-28",
    );
    assert.equal(next.length, 1);
    await mutate(vault, { ...next[0], status: "done" });
    assert.equal(
      (await vault.snapshot()).items.filter(
        (i) => i.kind === "task" && i.date === "2027-03-31",
      ).length,
      1,
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
test("fresh authentication protects a real file-backed API; CSRF, TOTP, recovery, external updates and static routes work", () =>
  fixture(async ({ root, write }) => {
    await write("00-Inbox/Existente.md", "# Ya estaba aquí\nSin importar.");
    const runtime = await mkdtemp(path.join(tmpdir(), "sb-auth-"));
    const staticRoot = path.join(runtime, "dist");
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<h1>App</h1>");
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: runtime,
      staticRoot,
      authLimit: 100,
      auth: true,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + app.server.address().port;
    const jar = new Map();
    async function request(
      route,
      method = "GET",
      data,
      expected = 200,
      csrf = true,
    ) {
      let token;
      if (method !== "GET" && csrf)
        token = (await request("/api/v1/auth/csrf")).token;
      const response = await fetch(base + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(";")[0];
        const i = first.indexOf("=");
        jar.set(first.slice(0, i), first.slice(i + 1));
      }
      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    }
    try {
      await request("/api/v1/items", "GET", undefined, 401);
      await request("/api/v1/mutations", "POST", {}, 400, false);
      const password = "a-unique-long-password";
      await request(
        "/api/v1/auth/setup",
        "POST",
        { username: "..", password },
        400,
      );
      await request("/api/v1/auth/setup", "POST", {
        username: "owner",
        password,
      });
      const loaded = await request("/api/v1/items");
      assert.ok(loaded.some((i) => i.title === "Ya estaba aquí"));
      const status = await request("/api/v1/vault/status");
      assert.equal(status.root, root);
      assert.equal(status.documents, 2);
      const note = loaded.find((i) => i.title === "Ya estaba aquí");
      await request("/api/v1/mutations", "POST", {
        mutationId: randomUUID(),
        baseVersion: note.version,
        entity: { ...note, body: "Escrito desde la app" },
      });
      assert.match(
        await readFile(path.join(root, note.vaultPath), "utf8"),
        /Escrito desde la app/,
      );
      await write(
        note.vaultPath,
        (await readFile(path.join(root, note.vaultPath), "utf8")).replace(
          "Escrito desde la app",
          "Editado en Obsidian",
        ),
      );
      assert.equal(
        (await request("/api/v1/items")).find((i) => i.id === note.id).body,
        undefined,
      );
      assert.match(
        (
          await request(
            "/api/v1/vault/note?path=" + encodeURIComponent(note.vaultPath),
          )
        ).content,
        /Editado en Obsidian/,
      );
      const controller = new AbortController();
      const stream = await fetch(base + "/api/v1/events", {
        headers: { Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      await reader.read();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        await write(
          note.vaultPath,
          (await readFile(path.join(root, note.vaultPath), "utf8")) +
            "\nCambio para notificar.",
        );
        let message = "";
        while (!message.includes("data: changed")) {
          const chunk = await reader.read();
          assert.ok(!chunk.done);
          message += new TextDecoder().decode(chunk.value);
        }
        assert.match(message, /data: changed/);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      const setup = await request("/api/v1/auth/totp/start", "POST", {});
      const recovery = await request("/api/v1/auth/totp/enable", "POST", {
        code: totp(setup.key),
      });
      assert.equal(recovery.codes.length, 8);
      await request("/api/v1/auth/logout", "POST", {}, 204);
      assert.equal(
        (
          await request("/api/v1/auth/login", "POST", {
            username: "owner",
            password,
          })
        ).requiresCode,
        true,
      );
      await request("/api/v1/items", "GET", undefined, 401);
      await request("/api/v1/auth/login", "POST", {
        username: "owner",
        password,
        code: recovery.codes[0],
      });
      await request("/api/v1/auth/logout", "POST", {}, 204);
      await request(
        "/api/v1/auth/login",
        "POST",
        { username: "owner", password, code: recovery.codes[0] },
        401,
      );
      await request("/api/v1/auth/login", "POST", {
        username: "owner",
        password,
        code: totp(setup.key),
      });
      assert.match(await request("/notes/anything"), /App/);
      await request("/api/v1/not-there", "GET", undefined, 404);
    } finally {
      await app.close();
      await rm(runtime, { recursive: true, force: true });
    }
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

test("keeps credentials and sessions across Node restarts, and persists logout revocation", () =>
  fixture(async ({ root }) => {
    const { Auth } = await import("../auth.mjs");
    const directory = path.join(root, ".auth");
    const first = new Auth(directory);
    await first.init();
    const values = new Map();
    const response = {
      getHeader: (key) => values.get(key),
      setHeader: (key, value) => values.set(key, value),
    };
    const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    await first.setup(
      {
        password: "a-password-for-restarts",
        username: "owner",
      },
      request,
      response,
    );
    const cookie = values
      .get("Set-Cookie")
      .find((s) => s.startsWith("sb.session="))
      .split(";")[0];
    const second = new Auth(directory);
    await second.init();
    const authenticated = { ...request, headers: { cookie } };
    assert.ok(second.authenticated(authenticated));
    await second.logout(authenticated, response);
    const third = new Auth(directory);
    await third.init();
    assert.equal(third.authenticated(authenticated), false);
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

test("a malformed request target gets a 400 and the server stays up", () =>
  fixture(async ({ root }) => {
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: path.join(root, ".data"),
      auth: false,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const { port } = app.server.address();
      const reply = await new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(
            "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
          ),
        );
        let text = "";
        socket.on("data", (d) => (text += d));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
      assert.match(reply, /^HTTP\/1\.1 400/);
      const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      assert.equal(health.status, 200);
    } finally {
      await app.close();
    }
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
