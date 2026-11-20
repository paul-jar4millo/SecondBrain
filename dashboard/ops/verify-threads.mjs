// Threads UI on desktop and a 375 px phone, with a synthetic launcher: no
// models and no personal vault. Screenshots go to $SB_VERIFY_SHOTS if set.
import { chromium } from "playwright";
import { createApplication } from "../../service/index.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { browserExecutable } from "./browser-executable.mjs";

const AT = "2026-11-20T10:00:00.000Z";
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), "timed out");
};
const THREAD = "thr_verify0000000001";
const thread = {
  id: THREAD,
  title: "Añade paginación a la API",
  kind: "repo",
  status: "running",
  autonomy: "auto-worktree",
  agent: { engine: "codex" },
  repo: {
    path: "/repos/demo",
    baseBranch: "main",
    branch: "sb/anade-paginacion-000001",
    worktree: "/wt/x",
  },
  workspace: null,
  parentId: null,
  flow: null,
  stageIndex: 0,
  counters: { turns: 1, reviewRounds: 0, subtasks: 0 },
  limits: { maxTurns: 40, maxReviewRounds: 3 },
  lastSeq: 3,
  closeMode: null,
  prUrl: null,
  createdAt: AT,
  updatedAt: AT,
};
const base = (id, turnId, status = "completed") => ({
  id,
  threadId: THREAD,
  turnId,
  seq: 1,
  status,
  agent: { engine: "codex" },
  createdAt: AT,
  updatedAt: AT,
});
const snapshot = {
  thread,
  lastSeq: 3,
  requests: [],
  items: [
    {
      ...base("itm_u1", null),
      kind: "user_message",
      text: "Añade paginación con cursor a GET /items",
      delivery: "send",
      attachments: [],
    },
    {
      ...base("itm_c1", "trn_t1"),
      kind: "command",
      command: "npm test",
      output: "ok 12 tests",
      exitCode: 0,
      updatedAt: "2026-11-20T10:00:42.000Z",
    },
    {
      ...base("itm_m1", "trn_t1", "in-progress"),
      kind: "assistant_message",
      text: "Estoy añadiendo",
    },
  ],
};
const diff = {
  files: [
    {
      path: "api/items.ts",
      change: "modify",
      additions: 2,
      deletions: 1,
      patch:
        "diff --git a/api/items.ts b/api/items.ts\n@@ -1,2 +1,3 @@\n-export const list = () => all();\n+export const list = (cursor?: string) =>\n+  page(cursor);\n ",
    },
  ],
};

const dir = await mkdtemp(path.join(tmpdir(), "sb-threads-ui-"));
await mkdir(path.join(dir, "00-Inbox"));
await writeFile(path.join(dir, "Home.md"), "# Synthetic test\n");
const app = await createApplication({
  vaultRoot: dir,
  dataDirectory: path.join(dir, ".data"),
  auth: false,
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});
const shots = process.env.SB_VERIFY_SHOTS;
try {
  for (const width of [1440, 375]) {
    const context = await browser.newContext({
      viewport: { width, height: 860 },
      ...(width < 700 ? { isMobile: true, hasTouch: true } : {}),
    });
    // EventSource double: records the URL and lets the test push messages.
    await context.addInitScript(() => {
      localStorage.setItem("sb-room-tour-v1", "done");
      window.__sources = [];
      window.EventSource = class {
        constructor(url) {
          this.url = String(url);
          this.closed = false;
          window.__sources.push(this);
          setTimeout(() => this.onopen?.({}), 0);
        }
        close() {
          this.closed = true;
        }
      };
      window.__push = (match, data) => {
        for (const s of window.__sources)
          if (!s.closed && s.url.includes(match))
            s.onmessage?.({ data: JSON.stringify(data) });
      };
    });
    const sent = [],
      answers = [],
      closes = [],
      errors = [];
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (value, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      switch (url.pathname) {
        case "/api/v1/threads":
          return json({ threads: [thread], globalSeq: 3 });
        case "/api/v1/bandeja":
          return json({ entries: [] });
        case "/api/v1/threads/detalle":
          return json(snapshot);
        case "/api/v1/threads/diff":
          return json(diff);
        case "/api/v1/threads/mensajes":
          sent.push(request.postDataJSON());
          return json({ delivery: "steer" }, 202);
        case "/api/v1/threads/responder":
          answers.push(request.postDataJSON());
          return json({ request: {} });
        case "/api/v1/threads/cerrar":
          closes.push(request.postDataJSON());
          return json({ thread: { ...thread, status: "done" } });
        case "/api/v1/agentes/modelos-lanzador":
          return json({ codex: [{ id: "gpt-6.2", nombre: "GPT 6.2" }] });
        case "/api/v1/agentes/proyectos-lanzador":
          return json(["demo"]);
      }
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/threads/${THREAD}`, {
      waitUntil: "networkidle",
    });
    await page
      .getByRole("heading", { name: thread.title })
      .waitFor()
      .catch(async (e) => {
        if (shots)
          await page.screenshot({
            path: path.join(shots, `fail-${width}.png`),
          });
        throw e;
      });
    await page.waitForFunction(() =>
      window.__sources.some((s) => s.url.includes("/threads/flujo")),
    );
    const streamUrl = await page.evaluate(
      () => window.__sources.find((s) => s.url.includes("/threads/flujo")).url,
    );
    assert.match(streamUrl, /after=3$/);
    // A delta streams into the open message.
    await page.evaluate(
      (id) =>
        window.__push("/threads/flujo", {
          type: "item.delta",
          threadId: id,
          itemId: "itm_m1",
          field: "text",
          delta: " el cursor.",
          afterSeq: 3,
        }),
      THREAD,
    );
    await page.getByText("Estoy añadiendo el cursor.").waitFor();
    // A running turn offers steer and queue; Ctrl+Enter steers.
    await page.getByRole("textbox", { name: "Mensaje" }).fill("Usa base64");
    await page.getByRole("button", { name: "Redirigir" }).click();
    await until(() => sent.length);
    assert.deepEqual(sent[0], {
      id: THREAD,
      text: "Usa base64",
      mode: "steer",
    });
    // The turn ends and the agent asks.
    await page.evaluate((id) => {
      const ev = (seq, data) => ({
        type: "event",
        event: {
          threadId: id,
          seq,
          globalSeq: seq,
          at: "2026-11-20T10:01:00.000Z",
          ...data,
        },
      });
      window.__push(
        "/threads/flujo",
        ev(4, {
          type: "turn.completed",
          turnId: "trn_t1",
          outcome: "completed",
        }),
      );
      window.__push(
        "/threads/flujo",
        ev(5, { type: "thread.updated", patch: { status: "waiting-user" } }),
      );
      window.__push(
        "/threads/flujo",
        ev(6, {
          type: "request.opened",
          request: {
            id: "req_ask000001",
            threadId: id,
            turnId: null,
            kind: "question",
            title: "¿Tamaño de página por defecto?",
            body: "",
            options: [
              { id: "o1", label: "20" },
              { id: "o2", label: "50" },
            ],
            status: "open",
            answer: null,
            origin: null,
            createdAt: "2026-11-20T10:01:00.000Z",
            answeredAt: null,
          },
        }),
      );
    }, THREAD);
    await page.getByText("¿Tamaño de página por defecto?").waitFor();
    await page.getByText("Espera tu respuesta").first().waitFor();
    const work = page.getByRole("button", { name: /Trabajó 42 s/ });
    assert.equal(await work.getAttribute("aria-expanded"), "true");
    await page.getByRole("button", { name: "50", exact: true }).click();
    await until(() => answers.length);
    assert.deepEqual(answers[0], {
      id: THREAD,
      requestId: "req_ask000001",
      answer: { optionId: "o2" },
    });
    // Diff panel: inline on desktop, a sheet on the phone.
    if (width < 700)
      await page
        .getByRole("button", { name: "Cambios", exact: true })
        .first()
        .click();
    await page.getByText("api/items.ts").first().waitFor();
    if (shots)
      await page.screenshot({ path: path.join(shots, `threads-${width}.png`) });
    if (width < 700)
      await page
        .getByRole("button", { name: "Cambios", exact: true })
        .first()
        .click();
    // Close by PR.
    await page.getByRole("button", { name: "Cerrar thread" }).click();
    await page.getByRole("button", { name: "Abrir PR" }).click();
    await page
      .getByRole("button", { name: "Abrir PR" })
      .waitFor({ state: "detached" });
    await until(() => closes.length);
    assert.equal(closes[0].mode, "pr");
    // Touch targets and no horizontal scroll.
    const small = await page.evaluate(() =>
      [...document.querySelectorAll(".thread-detail button, .thread-detail a")]
        .filter((el) => el.offsetParent !== null)
        .map((el) => [
          el.textContent?.trim(),
          el.getBoundingClientRect().height,
        ])
        .filter(([, h]) => h < 44),
    );
    if (width < 700) assert.deepEqual(small, []);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      "no horizontal scroll",
    );
    // The list on the phone: one column, back to it from the thread.
    if (width < 700) {
      await page.getByRole("link", { name: "Volver a la lista" }).click();
      await page.getByRole("button", { name: "Nuevo thread" }).click();
      await page.getByRole("dialog", { name: "Nuevo thread" }).waitFor();
      if (shots)
        await page.screenshot({
          path: path.join(shots, `threads-new-${width}.png`),
        });
    }
    assert.deepEqual(errors, []);
    console.log(
      `${width}: stream, steer, pregunta, diff, cierre y objetivos táctiles correctos`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
