// Production bundle, temporary vault, intercepted synthetic records. No live models/data.
import { chromium } from "playwright";
import { createApplication } from "../../service/index.mjs";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = await mkdtemp(path.join(tmpdir(), "sb-workspaces-"));
const output = fileURLToPath(
  new URL("../../.impeccable/review/workspaces/", import.meta.url),
);
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "00-Inbox"));
await writeFile(path.join(root, "Home.md"), "# Synthetic workspace test\n");
const app = await createApplication({
  vaultRoot: root,
  dataDirectory: path.join(root, ".data"),
  auth: false,
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.BROWSER_EXECUTABLE ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    ].find(existsSync),
});
const day = new Date().toLocaleDateString("en-CA", {
  timeZone: "America/Mexico_City",
});
const shift = (days) =>
  new Date(Date.parse(day + "T12:00:00Z") + days * 864e5)
    .toISOString()
    .slice(0, 10);
const item = (kind, id, title, extra = {}) => ({
  kind,
  id,
  title,
  version: 1,
  status: "active",
  createdAt: day + "T12:00:00Z",
  updatedAt: day + "T12:00:00Z",
  ...extra,
});
const records = [
  item("project", "p1", "Respaldos del laboratorio y manual", {
    area: "Proyecto personal",
    date: shift(30),
  }),
  item("project", "p2", "Cerrar el semestre", { area: "Estudio" }),
  item("project", "p3", "Un proyecto sin tareas", { area: "Personal" }),
  item("project", "p4", "Mudanza", { area: "Casa", status: "paused" }),
  item("task", "t1", "Automatizar el timer y definir la retención", {
    projectId: "p1",
    status: "pending",
    date: shift(2),
  }),
  item("task", "t2", "**Probar una restauración real** y documentarla", {
    projectId: "p1",
    status: "pending",
    date: shift(-3),
  }),
  item("task", "t3", 'Mencionar "backups" en el CV ([[Reglas-de-precision]])', {
    projectId: "p1",
    status: "waiting",
  }),
  item("task", "t4", "Elegir destino → [[Pendientes-por-confirmar]]", {
    projectId: "p1",
    status: "pending",
    priority: true,
  }),
  item("task", "t5", "Hacer el inventario de equipos", {
    projectId: "p1",
    status: "done",
  }),
  item("task", "t6", "Revisar la entrega final", {
    projectId: "p2",
    status: "pending",
    date: day,
  }),
];
const card = (id, name, last4, balanceMinor, limitMinor, payMinor, days) => ({
  id,
  name,
  last4,
  limitMinor,
  balanceMinor,
  availableMinor: limitMinor - balanceMinor,
  usedPct: balanceMinor / limitMinor,
  payMinor,
  dueDate: shift(days),
  cutDate: shift(days - 20),
  daysToDue: days,
  daysToCut: Math.max(0, days - 20),
  dueEstimated: id === "c2",
  cycleChargesMinor: Math.round(balanceMinor / 2),
  asOf: shift(-3),
  ageDays: 3,
  stale: id === "c3",
  cutPassed: false,
});
const cards = [
  card("c1", "Tarjeta azul", "1111", 320000, 1500000, 180000, 12),
  card("c2", "Tarjeta verde", "2222", 299700, 1200000, 299700, 16),
  card("c3", "Tarjeta tienda", "3333", 192671, 1010000, 147000, 24),
];
const finance = {
  configured: true,
  reconciledAt: shift(-3),
  expiresAt: shift(4),
  expired: false,
  incomeMonthlyMinor: 1800000,
  totals: {
    limitMinor: 3710000,
    usedMinor: 812371,
    availableMinor: 2897629,
    usedPct: 0.22,
    payMinor: 626700,
    cycleChargesMinor: 400000,
  },
  flow: {
    inflows: [
      {
        id: "i1",
        label: "Entrada de ejemplo",
        kind: "income",
        amountMinor: 830000,
        recurring: true,
      },
    ],
    inflowsMinor: 830000,
    payMinor: 626700,
    afterPayMinor: 203300,
    installmentsMonthlyMinor: 128670,
    fixedMinor: 50000,
    commitmentsMinor: 178670,
    marginMinor: 24630,
  },
  cards,
  transactions: [
    ["tx1", shift(-1), "c1", "Tienda de ejemplo", "Súper", 84500, "charge"],
    ["tx2", shift(-2), "c2", "Pago de tarjeta", undefined, 120000, "payment"],
    ["tx3", shift(-4), "c3", "Cafetería", "Comida", 8900, "charge"],
    ["tx4", shift(-5), "c1", "Gasolinera", "Transporte", 65000, "charge"],
  ].map(([id, date, c, desc, category, amountMinor, type]) => ({
    id,
    date,
    card: c,
    cardName: cards.find((x) => x.id === c).name,
    desc,
    category,
    amountMinor,
    type,
    status: "posted",
  })),
  categories: [
    { category: "Súper", amountMinor: 184500, pctOfIncome: 0.1 },
    { category: "Transporte", amountMinor: 95000, pctOfIncome: 0.05 },
    { category: "Comida", amountMinor: 48900, pctOfIncome: 0.03 },
  ],
  upcoming: [
    {
      date: shift(12),
      type: "due",
      label: "Fecha límite Tarjeta azul",
      amountMinor: 180000,
      estimated: false,
    },
    {
      date: shift(16),
      type: "due",
      label: "Fecha límite Tarjeta verde",
      amountMinor: 299700,
      estimated: true,
    },
    { date: shift(4), type: "cut", label: "Corte Tarjeta tienda" },
  ],
  alerts: [
    {
      level: "warning",
      code: "stale",
      text: "El saldo de Tarjeta tienda tiene 3 días.",
    },
    { level: "info", code: "cut", text: "Corte de Tarjeta tienda en 4 días." },
  ],
  installments: [
    {
      id: "m1",
      label: "Compra a meses",
      months: 12,
      paid: 4,
      left: 8,
      monthlyMinor: 128670,
      remainingMinor: 1029360,
      done: false,
    },
  ],
  installmentsRemainingMinor: 1029360,
  commitments: [
    {
      id: "f1",
      label: "Suscripción",
      amountMinor: 50000,
      cardName: "Tarjeta azul",
    },
  ],
  questions: [],
};
const sessions = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    motor: "claude",
    estado: "terminada",
    espacioId: "p1",
    encargo: "Revisar el plan de respaldos y proponer la retención",
    creada: shift(-1) + "T12:00:00Z",
    resultado: "Propuesta **sintética** de retención.",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    motor: "claude",
    estado: "terminada",
    espacioId: "p1",
    encargo: "Inventario de discos",
    creada: shift(-4) + "T12:00:00Z",
    resultado: "Inventario sintético.",
  },
];
const uploads = [];
const financeOps = [];
const starts = [];
async function fixture(route) {
  const request = route.request();
  const url = new URL(request.url()),
    p = url.pathname;
  const json = (value, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(value),
    });
  if (p === "/api/v1/items") return json(records);
  if (p === "/api/v1/finance/overview") return json(finance);
  if (p === "/api/v1/finance/ops") {
    financeOps.push(request.postDataJSON());
    return json({ overview: finance });
  }
  if (p === "/api/v1/files/raw") {
    const name = url.searchParams.get("name");
    uploads.push({ name, note: url.searchParams.get("note") });
    return json({ id: "file-" + uploads.length, name }, 201);
  }
  if (p === "/api/v1/files")
    return json({
      files: [{ size: 240 * 1024 * 1024, id: "x", area: "para-agentes" }],
      trash: [],
    });
  if (p === "/api/v1/vault/status")
    return json({ root: "/vault", documents: 128, issues: [] });
  if (p === "/api/v1/agentes/espacios")
    return json({ revision: 0, repositorios: ["codigo"], vinculos: {} });
  if (p === "/api/v1/agentes/modelos-lanzador")
    return json({
      claude: [
        { id: "opus", nombre: "Opus", esfuerzos: ["high", "xhigh"] },
        { id: "haiku", nombre: "Haiku" },
      ],
      codex: [{ id: "codex-a", nombre: "Modelo A" }],
    });
  if (p === "/api/v1/agentes/sesiones") {
    if (request.method() === "POST") {
      starts.push(request.postDataJSON());
      return json({ id: "33333333-3333-4333-8333-333333333333" });
    }
    return json(sessions);
  }
  if (p === "/api/v1/agentes/equipo") return json({ flujos: [], eventos: [] });
  if (p === "/api/v1/aprobaciones") return json([]);
  return route.fallback();
}
const shots = async (page, name, width) => {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(output, `${name}-${width}.png`) });
  const overflow = await page.evaluate(() =>
    [document.documentElement, document.querySelector(".tool-base")]
      .filter((e) => e && e.getBoundingClientRect().width)
      .filter((e) => e.scrollWidth > e.clientWidth + 1)
      .map((e) => e.className),
  );
  assert.deepEqual(overflow, [], `${name} at ${width} overflows`);
};
const errors = [];
try {
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [390, 844],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    await context.addInitScript(() => {
      localStorage.setItem("sb-room-tour-v1", "done");
      localStorage.setItem("sb-refugio-calidad", "baja");
    });
    await context.route("**/api/v1/**", fixture);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));

    // Projects and Tasks create from the corner, without a phrase bar.
    await page.goto(origin + "/projects");
    await page.getByRole("heading", { name: "Proyectos", level: 1 }).waitFor();
    assert.equal(await page.locator(".tool-base .prompt-bar").count(), 0);
    await shots(page, "proyectos", width);
    await page.getByRole("button", { name: "Nuevo proyecto" }).click();
    await page.getByRole("dialog").last().waitFor();
    await shots(page, "proyectos-nuevo", width);
    await page.keyboard.press("Escape");

    await page.goto(origin + "/tasks");
    await page.getByRole("heading", { name: "Tareas", level: 1 }).waitFor();
    assert.equal(await page.locator(".tool-base .prompt-bar").count(), 0);
    await page
      .getByText("Probar una restauración real y documentarla")
      .waitFor();
    assert.equal(await page.getByText("**Probar").count(), 0);
    await page.getByRole("button", { name: "Nueva tarea" }).waitFor();
    await shots(page, "tareas", width);

    // Project detail: next step, later tasks and a usable side panel.
    await page.goto(origin + "/projects/p1");
    await page.locator(".project-next-step .task-row").waitFor();
    await page.locator(".project-side").getByLabel("Estado").waitFor();
    assert.equal(await page.locator(".project-task-list .task-row").count(), 3);
    await shots(page, "proyecto", width);
    await page.getByRole("button", { name: "Nueva tarea" }).click();
    await page.getByRole("dialog").last().waitFor();
    await shots(page, "proyecto-nueva-tarea", width);
    await page.keyboard.press("Escape");

    // Equipo: new conversation and an existing one, at full height.
    await page.goto(origin + "/team?project=p1&agent=ambar&chat=new");
    await page.locator(".conversation-heading h2").waitFor();
    assert.equal(await page.locator(".team-character-card").count(), 4);
    await page.getByLabel("Razonamiento").waitFor();
    await shots(page, "equipo-nueva", width);
    await page.goto(
      origin + "/team?project=p1&agent=ambar&chat=" + sessions[0].id,
    );
    await page.locator(".conversation-transcript").waitFor();
    await shots(page, "equipo-conversacion", width);

    // Finance: captures and a balance reach the agent's composer, unsent.
    await page.goto(origin + "/finance");
    await page.getByRole("heading", { name: "Finanzas", level: 1 }).waitFor();
    await page.getByRole("heading", { name: "Próximo pago" }).waitFor();
    await shots(page, "finanzas", width);
    await page.locator("#financial-cards").scrollIntoViewIfNeeded();
    await shots(page, "finanzas-tarjetas", width);
    await page.locator("#financial-movements").scrollIntoViewIfNeeded();
    await shots(page, "finanzas-movimientos", width);
    await page.getByRole("button", { name: "Actualizar con agente" }).click();
    await page
      .getByRole("dialog", { name: "Actualizar con una agente" })
      .waitFor();
    await shots(page, "finanzas-agente-vacio", width);
    const pixel = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    );
    await page.getByLabel("Elegir capturas del banco").setInputFiles([
      { name: "estado.png", mimeType: "image/png", buffer: pixel },
      { name: "movimientos.pdf", mimeType: "application/pdf", buffer: pixel },
    ]);
    await page.getByRole("textbox", { name: /Tarjeta azul/ }).fill("3200.50");
    await page.getByLabel("Indicaciones").fill("El pago ya salió");
    await shots(page, "finanzas-agente", width);
    uploads.length = 0;
    financeOps.length = 0;
    starts.length = 0;
    await page.getByRole("button", { name: "Subir y pasar con Ámbar" }).click();
    const composer = page.getByRole("textbox", { name: "Mensaje para Ámbar" });
    await composer.waitFor();
    const brief = await composer.inputValue();
    assert.ok(brief.includes("- estado.png (id: file-1)"));
    assert.ok(brief.includes("- Tarjeta azul: 3200.50"));
    assert.ok(brief.includes("Indicaciones: El pago ya salió"));
    assert.deepEqual(
      uploads.map((u) => u.name),
      ["estado.png", "movimientos.pdf"],
    );
    assert.deepEqual(financeOps, [
      { op: "card-set", card: "c1", balance: "3200.50" },
    ]);
    assert.equal(starts.length, 0, "no model starts until the owner sends");
    assert.ok(page.url().includes("project=general"));
    await shots(page, "equipo-finanzas", width);
    await composer.fill("");

    // Settings: one section at a time, with options that persist.
    await page.goto(origin + "/settings");
    await page.getByRole("heading", { name: "Ajustes", level: 1 }).waitFor();
    await page.getByLabel("Abrir al iniciar").selectOption("/projects");
    await page.getByRole("switch", { name: /Ocultar importes/ }).check();
    await shots(page, "ajustes-general", width);
    await page.getByRole("button", { name: "Equipo", exact: true }).click();
    await page.getByLabel("Modelo de Ámbar").selectOption("opus");
    await shots(page, "ajustes-equipo", width);
    await page.getByRole("button", { name: "Datos", exact: true }).click();
    await page.getByText("de 2 GB en uso").waitFor();
    await shots(page, "ajustes-datos", width);
    await page.getByRole("button", { name: "Seguridad", exact: true }).click();
    await shots(page, "ajustes-seguridad", width);
    await page.getByRole("button", { name: "Acerca de", exact: true }).click();
    await shots(page, "ajustes-acerca", width);
    assert.equal(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("sb-modelo-claude") || "{}").modelo,
      ),
      "opus",
    );
    // The start preference opens the chosen tool on the next load.
    await page.goto(origin + "/");
    await page.waitForURL("**/projects");
    await page.evaluate(() => localStorage.removeItem("sb-hide-money"));
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log("verify-workspaces: OK");
} finally {
  await browser.close();
  await new Promise((r) => app.server.close(r));
  await app.close?.();
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
