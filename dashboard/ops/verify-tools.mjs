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
const response =
  "# Hallazgos verificados\n\nUna entrega **sintética** para comprobar lectura, selección y exportación.\n\n- Próximo paso documentado.\n- Material disponible para la siguiente fase.\n\n```js\nconst ejemplo = '<script>no se ejecuta</script>';\n```\n" +
  "Texto de lectura con suficiente extensión para comprobar desplazamiento. ".repeat(
    100,
  );
const job = {
  jobId: "j1",
  estado: "listo",
  project: "p1",
  instruction: "Investigar una idea de ejemplo",
  respuesta: response,
  inicio: date + "T12:00:00Z",
  fin: date + "T12:01:00Z",
  configuracion: { modelo: "modelo-de-prueba" },
};
const agentData = {
  conectado: true,
  agentes: ["ambar", "menta", "lira", "marina"].map((id) => ({
    id,
    ocupada: false,
    proveedor: {
      ambar: "claude",
      menta: "chatgpt",
      lira: "gemini",
      marina: "deepseek",
    }[id],
    configuracion:
      id === "menta" ? { modelo: "codex-test", esfuerzo: "high" } : {},
    historial: id === "ambar" ? [job] : [],
    ultimo:
      id === "ambar"
        ? job
        : id === "marina"
          ? { estado: "error", error: "Ejemplo de fallo recuperable" }
          : null,
    contextos: {},
    ventanas: { "5h": { usado: 25 } },
  })),
};
const flow = {
  id: "f1",
  project: "p1",
  instruction: "Preparar una solución para revisar",
  estado: "esperando",
  indice: 1,
  inicio: date + "T12:00:00Z",
  pasos: ["Investigar", "Planificar", "Programar", "Revisar"].map(
    (nombre, i) => ({
      agente: ["ambar", "menta", "marina", "ambar"][i],
      nombre,
      zona: "terrace",
      estado: i === 0 ? "listo" : "pendiente",
      ...(i === 0 ? { ...job, nombre, agente: "ambar" } : {}),
    }),
  ),
  relevos: [
    {
      id: "r1",
      de: "ambar",
      para: "menta",
      texto: "Ámbar entregó el material a Menta",
      paso: 0,
      jobId: "j1",
    },
  ],
};
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
  if (p === "/api/v1/agentes/espacios")
    return json({ revision: 0, repositorios: [], vinculos: {} });
  if (p === "/api/v1/agentes/modelos-lanzador") return json({});
  if (p === "/api/v1/finance/overview") return json(finance);
  if (p === "/api/v1/agentes") {
    if (agentReadDelay)
      await new Promise((resolve) => setTimeout(resolve, agentReadDelay));
    return connected
      ? json(agentData)
      : route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Servicio de ejemplo desconectado" }),
        });
  }
  if (p === "/api/v1/agentes/sesiones")
    return connected
      ? json([
          {
            id: "s1",
            motor: "codex",
            copia: 0,
            estado: "trabajando",
            proyecto: "p1",
            ultimaAccion: "Editando archivos",
          },
        ])
      : route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Servicio de ejemplo desconectado" }),
        });
  if (p === "/api/v1/agentes/equipo")
    return json({ flujos: [flow], eventos: [] });
  if (p === "/api/v1/agentes/modelos")
    return json({
      configuracion: { modelo: "codex-test", esfuerzo: "high" },
      modelos: [
        {
          model: "codex-test",
          displayName: "Modelo de prueba",
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
      ],
    });
  if (p.startsWith("/api/v1/agentes/") && route.request().method() === "POST") {
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
    await page
      .locator(".conversation-heading h2", { hasText: "Ámbar" })
      .waitFor();
    await noOverflow(page);
    await page.screenshot({ path: path.join(output, `profile-${width}.png`) });
    assert.equal(await page.locator("dialog[open]").count(), 1);
    assert.equal(writes.length, 0);
    await page
      .getByRole("button", { name: "Abrir conversación", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "p1");
    assert.equal(writes.length, 0);
    for (const [label, heading] of [
      ["Equipo", "Equipo"],
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
      if (label === "Equipo") {
        await page.locator(".team-character-card").first().waitFor();
        assert.equal(await page.locator(".team-character-card").count(), 4);
        assert.equal(
          await page.getByRole("button", { name: "Nuevo flujo" }).count(),
          0,
        );
        await noOverflow(page);
        await page.screenshot({
          path: path.join(output, `team-${width}.png`),
        });
      }
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
        assert.equal(
          await page
            .locator(".conversation-context > label select")
            .inputValue(),
          "p1",
        );
        await page
          .getByRole("button", { name: "Abrir conversación", exact: true })
          .waitFor();
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
    .getByRole("link", { name: "Equipo", exact: true })
    .click();
  // An observed live session must survive a failed read of the launcher.
  await page
    .locator(".team-character-card small", { hasText: "Editando archivos" })
    .waitFor();
  agentReadDelay = 0;
  connected = false;
  await page.getByRole("button", { name: "Actualizar", exact: true }).click();
  await page.getByText(/Servicio de ejemplo desconectado/).waitFor();
  assert.equal(
    await page
      .locator(".team-character-card small", { hasText: "Editando archivos" })
      .count(),
    1,
  );
  report.disconnectionPreservesSessions = true;
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
  await fallback
    .locator(".conversation-heading h2", { hasText: "Ámbar" })
    .waitFor();
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
        inspectors: document.querySelectorAll(".agent-inspector").length,
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
