// npm run build first. Requires Playwright; an external installation can be used
// with PLAYWRIGHT_PACKAGE=<absolute package.json>. See browser-executable.mjs for
// the browser lookup. Only synthetic demo data and a temporary vault are used.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createApplication } from "../../service/index.mjs";
import { browserExecutable } from "./browser-executable.mjs";

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const root = await mkdtemp(path.join(tmpdir(), "sb-refugio-browser-"));
const output = fileURLToPath(
  new URL("../../.impeccable/review", import.meta.url),
);
await mkdir(output, { recursive: true });
await mkdir(path.join(root, "00-Inbox"));
await writeFile(path.join(root, "Home.md"), "# Synthetic browser test\n");
const app = await createApplication({
  vaultRoot: root,
  dataDirectory: path.join(root, ".data"),
  auth: false,
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
  args: ["--enable-webgl", "--ignore-gpu-blocklist", "--use-angle=swiftshader"],
});
const errors = [],
  report = {};
const newContext = async (options) => {
  const context = await browser.newContext(options);
  // Deterministic software-rendered checks; high quality is reviewed separately.
  await context.addInitScript(() => {
    if (!localStorage.getItem("sb-refugio-calidad"))
      localStorage.setItem("sb-refugio-calidad", "baja");
  });
  return context;
};
const ready = (page) =>
  page.waitForFunction(
    () =>
      !document.querySelector(".room-loading:not([hidden])") &&
      !!document.querySelector(".map-player")?.getAttribute("style"),
    null,
    { timeout: 30000 },
  );
const noOverflow = async (page) => {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth + 1,
    ),
    false,
  );
  for (const dialog of await page.locator("dialog[open]").all()) {
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.width <= page.viewportSize().width && bounds.x >= 0);
    assert.equal(
      await dialog.evaluate((el) => el.scrollWidth > el.clientWidth + 1),
      false,
    );
  }
};
// Must match `tools` in src/app/Workspace.tsx.
const TOOLS = [
  "Proyectos",
  "Threads",
  "Tareas",
  "Finanzas",
  "Maletín",
  "Ajustes",
];
// Visible HUD boxes that must never cover each other. Panels may cover the scene,
// not the dock; the dock must fit on screen.
const HUD = {
  side: ".room-team:not(.collapsed)",
  camera: ".room-camera",
  map: ".room-map",
  agent: "#agent-detail:not([hidden])",
  board: "#room-board:not([hidden])",
  interact: "#room-interact:not([hidden])",
  dock: ".world-shortcuts",
  header: ".world-header",
  zone: ".room-location",
  clock: ".room-clock",
  toggle: ".team-toggle",
  help: ".room-help-trigger",
  guide: "#room-guide:not([hidden])",
  joystick: ".room-joystick",
};
const overlaps = (page, extra = {}) =>
  page.evaluate(
    (selectors) => {
      const boxes = {};
      for (const [name, selector] of Object.entries(selectors)) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const style = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (
          !r.width ||
          style.display === "none" ||
          style.visibility === "hidden"
        )
          continue;
        boxes[name] = r;
      }
      const hits = [];
      const names = Object.keys(boxes);
      for (let i = 0; i < names.length; i++)
        for (let j = i + 1; j < names.length; j++) {
          const a = boxes[names[i]],
            b = boxes[names[j]];
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left),
            h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 1 && h > 1) hits.push(`${names[i]} × ${names[j]}`);
        }
      const dockCut = [...document.querySelectorAll(".world-shortcuts a")]
        .filter((a) => getComputedStyle(a).display !== "none")
        .filter((a) => {
          const r = a.getBoundingClientRect();
          return (
            r.right > innerWidth + 1 ||
            r.left < -1 ||
            r.bottom > innerHeight + 1
          );
        })
        .map((a) => a.textContent.trim());
      return { hits, dockCut };
    },
    { ...HUD, ...extra },
  );
const stats = (page) => page.evaluate(() => window.__refugio.stats());
const frames = async (page) => (await stats(page)).frames || 0;
// REFUGIO_PARTES=escritorio,layouts,... runs a subset so CI can shard the scenes
// across machines; without it every scene runs.
const partes = (
  process.env.REFUGIO_PARTES ||
  "escritorio,descarga,layouts,movil,privado,sinwebgl"
).split(",");
const parte = (name) => partes.includes(name);
try {
  if (parte("escritorio")) {
    const context = await newContext({
      viewport: { width: 1440, height: 950 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => {
      errors.push(e.message);
      console.error("Browser:", e.message);
    });
    await page.goto(url + "/?demo&debug");
    // Meshopt needs WASM compilation under the same CSP as the production scene.
    await page.evaluate(async () => {
      await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      const blob = URL.createObjectURL(new Blob(["synthetic-texture"]));
      try {
        if ((await (await fetch(blob)).text()) !== "synthetic-texture")
          throw new Error("No se pudo leer una textura blob.");
      } finally {
        URL.revokeObjectURL(blob);
      }
    });
    console.log("Refugio: esperando carga 3D");
    await ready(page);
    console.log("Refugio: mundo cargado");
    await page.screenshot({ path: path.join(output, "mundo-util-start.png") });
    assert.equal(await page.locator("[data-agent]").count(), 4);
    assert.equal(await page.locator(".sidebar").count(), 0);
    assert.equal(await page.locator('img[src*="furina"]').count(), 0);
    report.renderer = await stats(page);
    await page.evaluate(() => {
      window.testCanvas = document.querySelector("canvas");
    });
    const position = () => page.locator(".map-player").getAttribute("style");

    // Phase 3: learn by playing, create through the real UI and read the update.
    assert.match(await page.locator("#room-guide-text").innerText(), /1 de 3/);
    assert.equal(await page.locator(".map-agent").count(), 4);
    await page.locator("canvas").focus();
    await page.keyboard.down("KeyD");
    await page.waitForFunction(
      () =>
        !document
          .querySelector("#room-guide-text")
          .textContent.includes("1 de 3"),
    );
    await page.keyboard.up("KeyD");
    await page.waitForFunction(() =>
      document.querySelector("#room-guide-text").textContent.includes("3 de 3"),
    );
    // The Library is the zone that summarizes tasks; the Terrace summarizes the team.
    const librarySays = (title, lines) =>
      page.waitForFunction(
        ([t, l]) =>
          document.querySelector("#room-quick-title").textContent === t &&
          document.querySelector("#room-quick-lines").textContent.includes(l),
        [title, lines],
        { timeout: 60000 },
      );
    // Marina can stand at (0.9, -6.1); actors take priority over a nearby zone.
    await page.evaluate(() => window.__refugio.walkTo(-1.2, -7.8));
    await librarySays("4 tareas pendientes", "3 para hoy");
    await page.getByRole("button", { name: "Crear", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Escribe qué quieres crear" })
      .fill("tarea Verificar tablero hoy");
    await page
      .getByRole("textbox", { name: "Escribe qué quieres crear" })
      .press("Enter");
    await page.locator("dialog[open]").waitFor({ state: "hidden" });
    await librarySays("5 tareas pendientes", "4 para hoy");
    report.worldDataUpdates = true;

    // Proximity and E: the Terrace opens Threads.
    await page.evaluate(() => window.__refugio.walkTo(0.25, 3.75));
    await page.waitForFunction(
      () =>
        document.querySelector("#room-quick-action")?.textContent ===
        "E · Threads en la Terraza",
      undefined,
      // Match the Library's allowance for software WebGL on slower CI runners.
      { timeout: 60000 },
    );
    console.log("Refugio: proximidad lista");
    await page.locator("canvas").focus();
    await page.keyboard.press("KeyE");
    await page.waitForURL(/\/threads$/);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("sb-room-tour-v1")),
      "done",
    );
    console.log("Refugio: herramienta abierta");
    assert.ok(await page.locator("dialog .tool-heading h1").innerText());
    console.log("Refugio: título comprobado");
    // The world keeps its last frame under a tool dialog instead of drawing.
    const underTool = await frames(page);
    await page.waitForTimeout(500);
    assert.equal(await frames(page), underTool);
    console.log("Refugio: render pausado");
    report.renderPausedUnderTools = true;
    await page.keyboard.press("Escape");
    await page.waitForURL(/\/$/);
    console.log("Refugio: herramienta cerrada");
    await page.waitForTimeout(200);
    await page.waitForFunction(
      (n) => window.__refugio.stats().frames > n,
      underTool,
      { polling: 100, timeout: 10000 },
    );
    report.proximityE = "E · Threads en la Terraza";

    // A click in empty air where the hidden Terrace sign hangs must not open Threads.
    const sign = await page.evaluate(() =>
      window.__refugio.project(0, 3.1, 2.2),
    );
    await page.mouse.click(sign.x, sign.y);
    await page.waitForTimeout(250);
    assert.equal(new URL(page.url()).pathname, "/");
    assert.equal(await page.locator("dialog[open]").count(), 0);
    report.hiddenSignsIgnored = true;

    // Click on free floor walks there; a click on the sea is refused with a cue.
    const before = await position();
    const floor = await page.evaluate(() => window.__refugio.project(-1, 0, 0));
    await page.mouse.move(floor.x, floor.y);
    await page.waitForFunction(
      () => window.__refugio.stats().cursor === "crosshair",
    );
    await page.mouse.click(floor.x, floor.y);
    assert.equal((await stats(page)).destination, true);
    await page.waitForFunction(
      (b) => document.querySelector(".map-player").getAttribute("style") !== b,
      before,
    );
    // The destination ring disappears on arrival.
    await page.waitForFunction(() => !window.__refugio.stats().destination);
    await page.waitForTimeout(300); // the minimap refreshes every 200 ms
    const sea = await page.evaluate(() => window.__refugio.project(0, 0, -40));
    await page.mouse.move(sea.x, sea.y);
    await page.waitForFunction(
      () => window.__refugio.stats().cursor === "not-allowed",
    );
    const settled = await position();
    await page.mouse.click(sea.x, sea.y);
    assert.equal((await stats(page)).blocked, true);
    await page.waitForTimeout(300);
    assert.equal(await position(), settled);
    // A click on the planning table walks to the closest free spot beside it.
    await page.waitForTimeout(800);
    const table = await page.evaluate(() =>
      window.__refugio.project(0, 0, 0.3),
    );
    await page.mouse.click(table.x, table.y);
    assert.equal((await stats(page)).destination, true);
    report.floorClick = { walks: true, seaRefused: true, furnitureSnaps: true };

    // Walk next to Marina (she waits at her desk with a failed delivery) and talk.
    // Wait until she stands still at her desk.
    await page.waitForFunction(
      () => {
        const agent = window.__refugio.positions().marina;
        return agent && !agent.moving;
      },
      null,
      { timeout: 60000 },
    );
    const marina = await page.evaluate(
      () => window.__refugio.positions().marina,
    );
    // Approach from behind her desk: the others work at the tables on the other side.
    await page.evaluate(
      ({ x, z }) => window.__refugio.walkTo(x, z - 1),
      marina,
    );
    await page.waitForFunction(() => !window.__refugio.positions().tu.moving);
    await page.waitForTimeout(250);
    await page.waitForFunction(
      () =>
        document.querySelector("#room-interact")?.textContent ===
        "E · Hablar con Marina",
      null,
      { timeout: 15000 },
    );
    await page.locator("canvas").focus();
    await page.keyboard.press("KeyE");
    const draft = page.getByRole("dialog", { name: "Nuevo thread" });
    assert.equal(
      await draft.getByLabel("Agente", { exact: true }).inputValue(),
      "deepseek",
    );
    assert.ok(await page.locator('[data-status="marina"]').innerText());
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    report.proximityAgent = "E · Hablar con Marina";

    const moved = await position();
    await page.locator("canvas").focus();
    await page.keyboard.down("KeyD");
    await page.waitForTimeout(900);
    await page.keyboard.up("KeyD");
    assert.notEqual(await position(), moved);
    report.keyboardMovement = true;
    for (const name of [
      "Acercar cámara",
      "Alejar cámara",
      "Girar a la izquierda",
      "Girar a la derecha",
      "Centrar cámara en ti",
    ])
      await page.getByRole("button", { name, exact: true }).click();

    // Help: Escape closes it, focus and aria-expanded come back.
    await page.locator("#room-help-button").click();
    assert.equal(
      await page.locator("#room-help-button").getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "room-help-close",
    );
    assert.equal(await page.locator("#room-volume").inputValue(), "0");
    await page.locator("#room-volume").evaluate((input) => {
      input.value = "25";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    assert.equal(
      await page.evaluate(() => localStorage.getItem("sb-room-volume")),
      "0.25",
    );
    assert.ok(!/cartel/i.test(await page.locator("#room-help").innerText()));
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#room-help").isHidden(), true);
    assert.equal(
      await page.locator("#room-help-button").getAttribute("aria-expanded"),
      "false",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "room-help-button",
    );
    await page.locator("#room-help-button").click();
    await page.locator("#room-guide-restart").click();
    assert.match(await page.locator("#room-guide-text").innerText(), /1 de 3/);
    await page.locator("#room-guide-skip").click();
    assert.equal(await page.locator("#room-guide").isHidden(), true);
    report.firstWalkAndSound = true;

    await page.locator(".team-toggle").click();
    await page
      .getByRole("button", { name: "Nuevo thread", exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
    report.overlayStack = {
      help: true,
      desk: true,
    };

    await page
      .getByRole("navigation", { name: "Herramientas del HUD" })
      .getByText("Tareas", { exact: true })
      .click();
    report.desktopTools = [];
    for (const label of TOOLS) {
      await page
        .getByRole("navigation", { name: "Cambiar herramienta" })
        .getByText(label, { exact: true })
        .click();
      await page.waitForTimeout(120);
      await noOverflow(page);
      assert.ok(await page.locator("dialog .tool-heading h1").innerText());
      assert.equal(
        await page.evaluate(
          () => window.testCanvas === document.querySelector("canvas"),
        ),
        true,
      );
      report.desktopTools.push(label);
    }
    await page.keyboard.press("Escape");
    await page.locator('[data-agent="ambar"]').click();
    assert.equal(
      await draft.getByLabel("Agente", { exact: true }).inputValue(),
      "claude",
    );
    await draft
      .getByRole("textbox", { name: "Tarea" })
      .fill("Borrador de prueba");
    await page.keyboard.press("Escape");
    await draft.waitFor({ state: "detached" });
    await page
      .getByRole("navigation", { name: "Herramientas del HUD" })
      .getByText("Tareas", { exact: true })
      .click();
    report.escapeFromTextarea = true;
    // The reference board belongs to each project.
    await page
      .getByRole("navigation", { name: "Cambiar herramienta" })
      .getByText("Proyectos", { exact: true })
      .click();
    await page
      .locator(".project-card-link", { hasText: "Un espacio para mis ideas" })
      .click();
    const referencias = page
      .locator(".work-tabs")
      .getByRole("button", { name: "Referencias", exact: true });
    await referencias.click();
    await referencias.and(page.locator('[aria-pressed="true"]')).waitFor();
    await page
      .getByRole("button", { name: "Explorar banco local", exact: true })
      .waitFor({ timeout: 15000 })
      .catch(async (e) => {
        await page.screenshot({
          path: path.join(output, "fail-referencias.png"),
        });
        throw e;
      });
    await page
      .getByRole("button", { name: "Explorar banco local", exact: true })
      .click();
    await page.locator(".reference-grid article").first().waitFor();
    const pinTitle = await page
      .locator(".reference-grid article h3")
      .first()
      .innerText();
    await page
      .locator(".reference-grid article")
      .first()
      .getByRole("button", { name: "Guardar referencia" })
      .click();
    await page
      .getByRole("button", { name: "Ver guardadas", exact: true })
      .click();
    await page.locator(".reference-grid h3", { hasText: pinTitle }).waitFor();
    await page
      .getByRole("button", { name: "Quitar del tablero", exact: true })
      .click();
    await page
      .getByText("Un lugar para tus referencias", { exact: true })
      .waitFor();
    await page.keyboard.press("Escape");
    report.assignmentsAndProjectBoard = true;
    await page.screenshot({ path: path.join(output, "desktop.png") });

    // A lost WebGL context pauses the world and recovers when the browser restores it.
    await page.evaluate(() => {
      window.testLose = document
        .querySelector("canvas")
        .getContext("webgl2")
        .getExtension("WEBGL_lose_context");
      window.testLose.loseContext();
    });
    await page
      .locator(".room-loading", { hasText: "pausó el mundo 3D" })
      .waitFor();
    assert.equal(await page.locator("#room-retry").isVisible(), true);
    await page.evaluate(() => window.testLose.restoreContext());
    await page.locator(".room-loading").waitFor({ state: "hidden" });
    const restored = await frames(page);
    await page.waitForFunction(
      (n) => window.__refugio.stats().frames > n + 5,
      restored,
    );
    report.contextLossRecovered = true;

    await page
      .getByRole("navigation", { name: "Herramientas del HUD" })
      .getByText("Tareas", { exact: true })
      .click();
    await page.screenshot({ path: path.join(output, "desktop-tools.png") });
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const cached = await page.evaluate(async () => {
      const names = (await caches.keys()).filter((n) =>
        n.startsWith("second-brain-shell-"),
      );
      const cache = await caches.open(names.at(-1));
      return (await cache.keys()).map((r) => new URL(r.url).pathname);
    });
    assert.ok(cached.includes("/models/sala/refugio.glb"));
    assert.ok(cached.includes("/models/sala/ambar.glb"));
    for (const id of ["ambar", "menta", "lira", "marina"])
      assert.ok(cached.includes(`/portraits/${id}.png`));
    assert.ok(!cached.some((p) => p.includes("furina")));
    await context.setOffline(true);
    await page.reload();
    await ready(page);
    report.offlineWorld = true;
    await context.setOffline(false);
    await context.close();
  }

  // A failed download shows real progress, then Reintentar loads the world.
  // The service worker would answer from its precache; this checks the network path.
  if (parte("descarga")) {
    const flaky = await newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const retryPage = await flaky.newPage();
    retryPage.on("pageerror", (e) => errors.push(e.message));
    let failures = 1;
    await retryPage.route("**/models/sala/refugio.glb", (route) =>
      failures-- > 0 ? route.abort() : route.continue(),
    );
    await retryPage.goto(url + "/?demo");
    await retryPage.locator("#room-retry").waitFor();
    await retryPage.locator("#room-retry").click();
    await ready(retryPage);
    report.retryAfterFailedDownload = true;
    await flaky.close();
  }

  // Layout: no HUD overlaps, the dock fits, the desk ends above the dock.
  if (parte("layouts")) {
    report.layouts = {};
    for (const [width, height, mobile] of [
      [1024, 768],
      [1280, 720],
      [1440, 900],
      [375, 812, true],
      [844, 390, true],
    ]) {
      const name = `${width}x${height}`;
      const layout = await newContext({
        viewport: { width, height },
        isMobile: !!mobile,
        hasTouch: !!mobile,
      });
      const view = await layout.newPage();
      view.on("pageerror", (e) => errors.push(e.message));
      await view.goto(url + "/?demo");
      await ready(view);
      await noOverflow(view);
      const base = await overlaps(view);
      if (mobile) {
        assert.equal(
          await view.locator(".team-collapse").getAttribute("aria-expanded"),
          "false",
        );
        await view.locator(".team-collapse").tap();
      }
      const team = await overlaps(view);
      // Overlap checks cover the preserved HUD; tool layouts are exercised by verify-tools.
      await view.screenshot({ path: path.join(output, `layout-${name}.png`) });
      report.layouts[name] = {
        base: base.hits,
        team: team.hits,
        dockCut: base.dockCut,
      };
      assert.deepEqual(base.hits, [], `${name}: ${base.hits}`);
      assert.deepEqual(team.hits, [], `${name} team: ${team.hits}`);
      assert.deepEqual(base.dockCut, [], `${name} dock: ${base.dockCut}`);
      await layout.close();
    }
  }

  if (parte("movil")) {
    const mobile = await newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const phone = await mobile.newPage();
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(url + "/?demo&debug");
    await ready(phone);
    await noOverflow(phone);
    assert.equal(
      await phone.getByRole("button", { name: "Crear", exact: true }).count(),
      1,
    );
    assert.equal(
      await phone.locator(".team-collapse").getAttribute("aria-expanded"),
      "false",
    );
    // Touch screens say "Tocar", never a key they do not have.
    await phone.waitForFunction(() =>
      /^Tocar · /.test(
        document.querySelector("#room-quick-action")?.textContent || "",
      ),
    );
    report.touchPrompt = await phone.locator("#room-interact").innerText();
    assert.ok(
      (await phone.locator("#room-interact").boundingBox()).height <= 64,
      "on a phone the zone prompt is one line, not a card over the scene",
    );
    await phone.screenshot({ path: path.join(output, "mobile.png") });
    const stick = await phone.locator("#room-joystick").boundingBox();
    const touch = await mobile.newCDPSession(phone);
    const origin = {
      x: stick.x + stick.width / 2,
      y: stick.y + stick.height / 2,
    };
    const beforeStick = await phone
      .locator(".map-player")
      .getAttribute("style");
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [origin],
    });
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: origin.x + 32, y: origin.y }],
    });
    await phone.waitForTimeout(500);
    await touch.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await phone.waitForFunction(
      (before) =>
        document.querySelector(".map-player").getAttribute("style") !== before,
      beforeStick,
    );
    await phone.waitForTimeout(300);
    const stopped = await phone.locator(".map-player").getAttribute("style");
    await phone.waitForTimeout(400);
    assert.equal(
      await phone.locator(".map-player").getAttribute("style"),
      stopped,
    );
    await touch.detach();
    report.touchJoystick = true;
    await phone
      .getByRole("navigation", { name: "Herramientas del HUD" })
      .getByText("Tareas", { exact: true })
      .click();
    report.mobileTools = [];
    for (const label of TOOLS) {
      await phone
        .getByRole("navigation", { name: "Cambiar herramienta" })
        .getByText(label, { exact: true })
        .click();
      await phone.waitForTimeout(100);
      await noOverflow(phone);
      report.mobileTools.push(label);
    }
    await phone.screenshot({ path: path.join(output, "mobile-tools.png") });
    await phone.keyboard.press("Escape");
    await phone.locator(".team-collapse").click();
    await phone.locator('[data-agent="menta"]').click();
    await noOverflow(phone);
    await phone.screenshot({ path: path.join(output, "mobile-agent.png") });
    // Rotating the phone switches the HUD live without reloading.
    await phone.setViewportSize({ width: 844, height: 390 });
    await phone.keyboard.press("Escape");
    await phone.keyboard.press("Escape");
    await phone.locator("dialog[open]").waitFor({ state: "detached" });
    await phone.waitForTimeout(200);
    const rotated = await overlaps(phone);
    assert.deepEqual(rotated.hits, [], `rotated: ${rotated.hits}`);
    assert.deepEqual(rotated.dockCut, []);
    await phone.screenshot({ path: path.join(output, "mobile-landscape.png") });
    report.rotation = true;
    await mobile.close();
  }

  // Real React/API bridge with a synthetic finance response, never the user's vault.
  if (parte("privado")) {
    const privateView = await newContext({
      viewport: { width: 1280, height: 720 },
      reducedMotion: "reduce",
    });
    await privateView.route("**/api/v1/threads", (route) =>
      route.fulfill({ json: { threads: [] } }),
    );
    await privateView.route("**/api/v1/finance/overview", (route) =>
      route.fulfill({
        json: {
          configured: true,
          expired: false,
          reconciledAt: "2026-11-07",
          expiresAt: "2026-11-08",
          totals: {
            limitMinor: 1000000,
            usedMinor: 123456,
            availableMinor: 876544,
            usedPct: 0.123456,
            payMinor: 123456,
            cycleChargesMinor: 0,
          },
          flow: {
            inflows: [],
            inflowsMinor: 500000,
            payMinor: 123456,
            afterPayMinor: 376544,
            installmentsMonthlyMinor: 0,
            fixedMinor: 0,
            commitmentsMinor: 0,
            marginMinor: 376544,
          },
          upcoming: [
            {
              date: "2026-11-10",
              type: "due",
              label: "Tarjeta sintética",
              amountMinor: 123456,
              estimated: false,
            },
          ],
          cards: [],
          transactions: [],
          alerts: [],
        },
      }),
    );
    const privatePage = await privateView.newPage();
    privatePage.on("pageerror", (e) => errors.push(e.message));
    await privatePage.goto(url + "/?debug");
    await ready(privatePage);
    await privatePage.evaluate(() => window.__refugio.walkTo(-8.75, 3.75));
    await privatePage.waitForFunction(() =>
      document
        .querySelector("#room-quick-lines")
        .textContent.includes("$1,234.56"),
    );
    await privatePage.locator("canvas").focus();
    await privatePage.keyboard.press("KeyE");
    await privatePage.waitForURL(/\/finance$/);
    await privatePage
      .getByRole("button", { name: "Ocultar importes", exact: true })
      .waitFor();
    const palette = () =>
      privatePage.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return [
          "--bg",
          "--ink",
          "--chart-income",
          "--chart-payments",
          "--chart-commitments",
          "--chart-remaining",
        ].map((name) => style.getPropertyValue(name).trim());
      });
    const lightPalette = await palette();
    await privatePage.emulateMedia({ colorScheme: "dark" });
    assert.deepEqual(await palette(), lightPalette);
    await privatePage.screenshot({
      path: path.join(output, "finance-dark-system.png"),
    });
    await privatePage.emulateMedia({ colorScheme: "light" });
    report.chartsFollowToolPalette = true;

    await privatePage
      .getByRole("button", { name: "Ocultar importes", exact: true })
      .click();
    await privatePage.waitForFunction(
      () =>
        document.querySelector("#room-quick-lines").textContent ===
        "Importes ocultos",
    );
    assert.equal(
      await privatePage.evaluate(() => localStorage.getItem("sb-hide-money")),
      "true",
    );
    await privatePage
      .getByRole("button", { name: "Mostrar importes", exact: true })
      .click();
    await privatePage.waitForFunction(() =>
      document
        .querySelector("#room-quick-lines")
        .textContent.includes("$1,234.56"),
    );
    await privatePage.keyboard.press("Escape");
    report.moneyPrivacyAcrossToolAndWorld = true;
    await privatePage.locator('[data-agent="marina"]').click();
    assert.equal(
      await privatePage
        .getByRole("dialog", { name: "Nuevo thread" })
        .getByLabel("Agente", { exact: true })
        .inputValue(),
      "deepseek",
    );
    report.agentPanelWithoutRunner = true;
    await privateView.close();
  }

  if (parte("sinwebgl")) {
    const fallback = await newContext();
    await fallback.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (/webgl/.test(type)) return null;
        return original.call(this, type, ...args);
      };
    });
    const withoutGL = await fallback.newPage();
    withoutGL.on("pageerror", (e) => errors.push(e.message));
    await withoutGL.goto(url + "/?demo");
    await withoutGL
      .getByText("No se pudo abrir el mundo 3D.", { exact: false })
      .waitFor();
    await withoutGL.locator('[data-agent="marina"]').click();
    assert.equal(
      await withoutGL
        .getByRole("dialog", { name: "Nuevo thread" })
        .getByLabel("Agente", { exact: true })
        .inputValue(),
      "deepseek",
    );
    report.noWebGLFallback = true;
    await fallback.close();
  }
  assert.deepEqual(errors, []);
  report.pageErrors = errors;
  await writeFile(
    path.join(output, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error);
  const page = browser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => !p.isClosed());
  if (page) {
    console.error(
      "Estado al fallar:",
      await page
        .evaluate(() => ({
          path: location.pathname,
          focus: document.activeElement?.outerHTML.slice(0, 300),
          prompt: document.querySelector("#room-interact")?.textContent,
          overlays: document.querySelector(".sala")?.dataset.overlays,
          input: window.__refugio?.lastInput,
          dialogs: document.querySelectorAll("dialog[open]").length,
          positions: window.__refugio?.positions(),
        }))
        .catch(() => null),
    );
    await page
      .screenshot({
        path: path.join(output, "refugio-failure.png"),
        timeout: 5000,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
