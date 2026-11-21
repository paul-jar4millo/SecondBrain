// Production bundle, temporary vault, intercepted synthetic records. No live models/data.
import { chromium } from "playwright";
import { createApplication } from "../../service/index.mjs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { browserExecutable } from "./browser-executable.mjs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(path.join(tmpdir(), "sb-tools-"));
const output = fileURLToPath(
  new URL("../../.impeccable/review/tools/", import.meta.url),
);
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "00-Inbox"));
await writeFile(path.join(root, "Home.md"), "# Synthetic tools test\n");
const app = await createApplication({
  vaultRoot: root,
  dataDirectory: path.join(root, ".data"),
  auth: false,
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});
const errors = [],
  writes = [],
  report = {};
const date = new Date().toLocaleDateString("en-CA", {
  timeZone: "America/Mexico_City",
});
const item = (kind, id, title, extra = {}) => ({
  kind,
  id,
  title,
  version: 1,
  status: "active",
  createdAt: date + "T12:00:00Z",
  updatedAt: date + "T12:00:00Z",
  ...extra,
});
const records = [
  item("project", "p1", "Un espacio para mis ideas", {
    area: "Personal",
    date,
  }),
  item("project", "p2", "Cerrar el semestre", { area: "Estudio" }),
  item("project", "p3", "Un proyecto sin tareas", { area: "Personal" }),
  item("task", "t1", "Darle forma a la próxima semana", {
    projectId: "p1",
    priority: true,
    date,
    plannedDate: date,
    status: "pending",
  }),
  item("task", "t2", "Revisar el borrador de la entrega", {
    projectId: "p2",
    date,
    status: "done",
  }),
  item("event", "e1", "Sesión de estudio", {
    date,
    time: "17:00",
    duration: 60,
    timezone: "America/Mexico_City",
  }),
];
const finance = {
  configured: true,
  reconciledAt: date,
  expiresAt: "2099-01-01",
  expired: false,
  incomeMonthlyMinor: 60000,
  totals: {
    limitMinor: 100000,
    usedMinor: 20000,
    availableMinor: 80000,
    usedPct: 0.2,
    payMinor: 30000,
    cycleChargesMinor: 15000,
  },
  flow: {
    inflows: [],
    inflowsMinor: 60000,
    payMinor: 30000,
    afterPayMinor: 30000,
    installmentsMonthlyMinor: 5000,
    fixedMinor: 10000,
    commitmentsMinor: 15000,
    marginMinor: 15000,
  },
  cards: [
    {
      id: "c1",
      name: "Tarjeta de ejemplo",
      limitMinor: 100000,
      balanceMinor: 20000,
      availableMinor: 80000,
      usedPct: 0.2,
      payMinor: 30000,
      dueDate: date,
      cutDate: date,
      dueEstimated: false,
      cycleChargesMinor: 15000,
      stale: false,
      cutPassed: false,
    },
  ],
  transactions: [
    {
      id: "tx1",
      date,
      card: "c1",
      cardName: "Tarjeta de ejemplo",
      desc: "Material de estudio",
      category: "Educación",
      amountMinor: 15000,
      type: "charge",
      status: "posted",
    },
  ],
  categories: [{ category: "Educación", amountMinor: 15000 }],
  upcoming: [
    {
      date,
      type: "due",
      label: "Tarjeta de ejemplo",
      amountMinor: 30000,
      estimated: false,
    },
  ],
  alerts: [],
  installments: [],
  commitments: [],
  questions: [],
};
let connected = true;
let agentReadDelay = 0;
async function fixture(route) {
  const url = new URL(route.request().url()),
    p = url.pathname;
  const json = (value) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  if (p === "/api/v1/items") return json(records);
  if (p === "/api/v1/agents/workspaces")
    return json({
      revision: 0,
      repositories: ["demo"],
      links: { p1: "demo" },
    });
  if (p === "/api/v1/agents/projects") return json(["demo"]);
  if (p === "/api/v1/inbox") return json({ entries: [] });
  if (p === "/api/v1/approvals") return json([]);
  if (p === "/api/v1/agents/models") return json({});
  if (p === "/api/v1/finance/overview") return json(finance);
  if (p === "/api/v1/files/raw" && route.request().method() === "POST")
    return json({ id: "synthetic-statement", name: "estado.pdf" });
  if (p === "/api/v1/threads" && route.request().method() === "GET") {
    if (agentReadDelay)
      await new Promise((resolve) => setTimeout(resolve, agentReadDelay));
    return connected
      ? json({
          threads: [
            {
              id: "thr_verify0000000001",
              title: "Editando archivos",
              agent: { engine: "codex" },
              status: "running",
              createdAt: date,
            },
          ],
        })
      : route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Servicio de ejemplo desconectado" }),
        });
  }
  if (p === "/api/v1/threads" && route.request().method() === "POST") {
    writes.push({ path: p, body: route.request().postDataJSON() });
    return json({});
  }
  return route.fallback();
}
async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    document.querySelector(".tool-base")?.scrollTo(0, 0);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
  });
}
async function noOverflow(page) {
  const overflow = await page.evaluate(() =>
    [
      document.documentElement,
      document.querySelector(".tool-base"),
      document.querySelector(".agent-inspector"),
    ]
      .filter((e) => e && e.getBoundingClientRect().width)
      .map((e) => ({
        class: e.className,
        client: e.clientWidth,
        scroll: e.scrollWidth,
      }))
      .filter((e) => e.scroll > e.client + 1),
  );
  if (overflow.length) {
    console.log(
      page.url(),
      await page.locator(".tool-base").evaluate((base) =>
        [...base.querySelectorAll("*")]
          .filter(
            (e) =>
              e.getBoundingClientRect().right >
              base.getBoundingClientRect().right + 1,
          )
          .slice(0, 12)
          .map((e) => ({
            tag: e.tagName,
            class: e.className,
            width: e.getBoundingClientRect().width,
            right: e.getBoundingClientRect().right,
          })),
      ),
    );
    await page.screenshot({
      path: path.join(output, "overflow-diagnostic.png"),
    });
  }
  assert.deepEqual(overflow, []);
}
try {
  const context = await browser.newContext({
    reducedMotion: "reduce",
    permissions: ["clipboard-read", "clipboard-write"],
  });
  await context.addInitScript(() => {
    localStorage.setItem("sb-room-tour-v1", "done");
    localStorage.setItem("sb-refugio-calidad", "baja");
  });
  await context.route("**/api/v1/**", fixture);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [width, height] of [
    [1440, 900],
    [1280, 720],
    [1024, 768],
    [375, 812],
    [844, 390],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(origin + "/projects?debug");
    await page.locator(".project-card").first().waitFor();
    await settle(page);
    await noOverflow(page);
    assert.equal(await page.locator(".project-card").count(), 3);
    const columns = await page.locator(".project-grid").evaluate((grid) => {
      const boxes = [...grid.children].map((e) => e.getBoundingClientRect());
      const firstY = Math.min(...boxes.map((b) => b.y));
      return boxes.filter((b) => b.y < firstY + 1).length;
    });
    assert.ok(
      columns <= 3,
      `Project grid has ${columns} columns; maximum is three.`,
    );
    assert.match(
      await page
        .locator(".project-card")
        .filter({ hasText: "Un proyecto sin tareas" })
        .innerText(),
      /Sin tareas definidas/,
    );
    await page.screenshot({ path: path.join(output, `projects-${width}.png`) });
    const head = page
      .getByRole("button", { name: "Consultar a Ámbar para este proyecto" })
      .first();
    await head.click();
    const draft = page.getByRole("dialog", { name: "Nuevo thread" });
    await draft
      .getByRole("option", { name: "demo" })
      .waitFor({ state: "attached" });
    assert.equal(
      await draft.getByLabel("Agente", { exact: true }).inputValue(),
      "claude",
    );
    assert.equal(
      await draft.getByLabel("Proyecto", { exact: true }).inputValue(),
      "demo",
    );
    await noOverflow(page);
    await page.screenshot({
      path: path.join(output, "draft-" + width + ".png"),
    });
    assert.equal(writes.length, 0);
    await draft.getByRole("button", { name: "Cancelar" }).click();
    for (const [label, heading] of [
      ["Threads", "Threads"],
      ["Tareas", "Tareas"],
      ["Finanzas", "Finanzas"],
      ["Ajustes", "Ajustes"],
    ]) {
      await page
        .locator(".tool-tabs")
        .getByRole("link", { name: label, exact: true })
        .click();
      await page
        .locator(".tool-heading h1")
        .filter({ hasText: heading })
        .waitFor();
      await settle(page);
      await noOverflow(page);
      await page.screenshot({
        path: path.join(output, `${label.toLowerCase()}-${width}.png`),
      });
      if (label === "Finanzas") {
        await page.getByRole("button", { name: "Ocultar importes" }).click();
        assert.equal(
          await page
            .locator(".tool-content")
            .getByText("$600.00", { exact: false })
            .count(),
          0,
        );
        assert.equal(await page.locator(".tool-content [role=img]").count(), 0);
        await page.getByRole("button", { name: "Mostrar importes" }).click();
        if (width === 375) {
          await page
            .getByRole("button", { name: "Actualizar con agente" })
            .click();
          const update = page.getByRole("dialog", {
            name: "Actualizar con una agente",
          });
          await update.getByLabel("Elegir capturas del banco").setInputFiles({
            name: "estado.pdf",
            mimeType: "application/pdf",
            buffer: Buffer.from("%PDF-1.4"),
          });
          await update.getByText("Menta", { exact: true }).click();
          await update
            .getByRole("button", { name: "Subir y pasar con Menta" })
            .click();
          await draft.getByRole("textbox", { name: "Tarea" }).waitFor();
          assert.match(
            await draft.getByRole("textbox", { name: "Tarea" }).inputValue(),
            /estado\.pdf \(id: synthetic-statement\)/,
          );
          assert.equal(
            await draft.getByLabel("Agente", { exact: true }).inputValue(),
            "codex",
          );
          assert.equal(
            await draft.getByLabel("Proyecto", { exact: true }).inputValue(),
            "",
          );
          await draft.getByRole("button", { name: "Cancelar" }).click();
          assert.equal(writes.length, 0);
        }
      }
      if (label === "Hoy") {
        const targets = await page
          .locator(".project-line .portrait-button")
          .evaluateAll((nodes) =>
            nodes.map((node) => ({
              width: node.getBoundingClientRect().width,
              height: node.getBoundingClientRect().height,
            })),
          );
        assert.ok(targets.length > 0);
        assert.ok(
          targets.every((t) => t.width >= 44 && t.height >= 44),
          JSON.stringify(targets),
        );
      }
      if (label === "Tareas") {
        await page
          .getByRole("button", {
            name: "Consultar equipo: Darle forma a la próxima semana",
          })
          .click();
        await noOverflow(page);
        await page
          .getByRole("button", { name: "Consultar a Lira para esta tarea" })
          .click();
        await draft
          .getByRole("option", { name: "demo" })
          .waitFor({ state: "attached" });
        assert.equal(
          await draft.getByLabel("Proyecto", { exact: true }).inputValue(),
          "demo",
        );
        assert.equal(
          await draft.getByLabel("Agente", { exact: true }).inputValue(),
          "agy",
        );
        assert.match(
          await draft.getByRole("textbox", { name: "Tarea" }).inputValue(),
          /Darle forma/,
        );
        await draft.getByRole("button", { name: "Cancelar" }).click();
        assert.equal(writes.length, 0);
      }
    }
  }
  report.viewports = ["1440×900", "1280×720", "1024×768", "375×812", "844×390"];
  const originalRecords = [...records];
  records.splice(
    0,
    records.length,
    ...Array.from({ length: 30 }, (_, index) =>
      item(
        "project",
        `many-${index}`,
        index === 0
          ? "Organizar las entregas de estudio, reunir las referencias y preparar con calma un proyecto de varias etapas para el próximo semestre"
          : `Proyecto de prueba ${index + 1}`,
        { area: "Ejemplos" },
      ),
    ),
  );
  await page.goto(origin + "/projects");
  await page.waitForFunction(
    () => document.querySelectorAll(".project-card").length === 30,
  );
  await settle(page);
  await noOverflow(page);
  records.splice(0, records.length);
  await page.reload();
  await page.waitForFunction(
    () =>
      !document.querySelector(".project-card") &&
      !!document.querySelector(".project-channel"),
  );
  await settle(page);
  await noOverflow(page);
  records.splice(0, records.length, ...originalRecords);
  // A slow read must finish before the subsequent disconnected-cache assertion.
  agentReadDelay = 1500;
  await page.reload();
  await page.waitForFunction(
    () => document.querySelectorAll(".project-card").length === 3,
  );
  report.longTitlesManyAndEmptyProjects = true;
  // At 200% zoom, a 1440px desktop has the layout width of 720 CSS px.
  await page.setViewportSize({ width: 720, height: 450 });
  await page
    .locator(".tool-tabs")
    .getByRole("link", { name: "Proyectos", exact: true })
    .click();
  await settle(page);
  await noOverflow(page);
  await page.screenshot({ path: path.join(output, "zoom-200.png") });
  await page
    .locator(".tool-tabs")
    .getByRole("link", { name: "Threads", exact: true })
    .click();
  await page.getByRole("link", { name: /Editando archivos/ }).waitFor();
  agentReadDelay = 0;
  connected = false;
  await page
    .getByText(/Servicio de ejemplo desconectado/)
    .waitFor({ timeout: 30_000 });
  assert.equal(
    await page.getByRole("link", { name: /Editando archivos/ }).count(),
    1,
  );
  report.disconnectionPreservesThreads = true;
  const noGl = await browser.newContext();
  await noGl.route("**/api/v1/**", fixture);
  await noGl.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return /webgl/i.test(type) ? null : original.call(this, type, ...args);
    };
  });
  const fallback = await noGl.newPage();
  fallback.on("pageerror", (e) => errors.push(e.message));
  await fallback.goto(origin + "/projects");
  await fallback.locator(".project-card").first().waitFor();
  await fallback
    .getByRole("button", { name: "Consultar a Ámbar para este proyecto" })
    .first()
    .click();
  await fallback.getByRole("dialog", { name: "Nuevo thread" }).waitFor();
  report.withoutWebGL = true;
  assert.equal(writes.length, 0);
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(
      { ...report, readOnlyBrowsingPosts: writes.length, errors },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(report));
} catch (error) {
  const active = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => !p.isClosed());
  if (active) {
    console.error(
      await active.evaluate(() => ({
        path: location.href,
        focus: document.activeElement?.outerHTML.slice(0, 200),
        dialogs: document.querySelectorAll("dialog[open]").length,
      })),
    );
    await active.screenshot({
      path: path.join(output, "failure-diagnostic.png"),
    });
  }
  throw error;
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
