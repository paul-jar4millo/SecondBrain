// Synthetic approval data; never connects to the real vault.
import { createRequire } from "node:module";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createApplication } from "../../service/index.mjs";
import { browserExecutable } from "./browser-executable.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const dir = await mkdtemp(path.join(tmpdir(), "sb-approval-ui-"));
const vault = path.join(dir, "vault");
await mkdir(path.join(vault, "00-Inbox"), { recursive: true });
await writeFile(path.join(vault, "Home.md"), "# Test sintético\n");
const app = await createApplication({
  vaultRoot: vault,
  dataDirectory: path.join(dir, "data"),
  auth: false,
});
app.server.listen(0, "127.0.0.1");
await once(app.server, "listening");
const url = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
  args: ["--enable-webgl", "--ignore-gpu-blocklist"],
});
try {
  for (const [width, height] of [
    [1440, 900],
    [375, 812],
    [844, 390],
  ]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() =>
      localStorage.setItem("sb-refugio-calidad", "baja"),
    );
    await page.route("**/api/v1/aprobaciones", (route) =>
      route.fulfill({
        json: [
          {
            id: "test",
            actor: "agente:menta",
            estado: "pendiente",
            vence: Date.now() + 600000,
            operacion: { op: "pago", amount: 1234 },
          },
        ],
      }),
    );
    await page.route("**/api/v1/agentes/proyectos-lanzador", (route) =>
      route.fulfill({ json: ["proyecto-sintetico"] }),
    );
    let encargos = 0;
    await page.route("**/api/v1/agentes/espacios", (route) =>
      route.fulfill({
        json: {
          revision: 0,
          repositorios: ["proyecto-sintetico"],
          vinculos: { general: "proyecto-sintetico" },
        },
      }),
    );
    await page.route("**/api/v1/agentes/sesiones*", (route) => {
      if (route.request().method() === "POST") {
        encargos++;
        return route.fulfill({ status: 202, json: { id: "nueva" } });
      }
      return route.fulfill({
        json: [
          {
            id: "existente",
            motor: "codex",
            estado: "trabajando",
            copia: 0,
            proyecto: "proyecto-sintetico",
            ultimaAccion: "Revisando",
          },
        ],
      });
    });
    await page.goto(url + "/team", { waitUntil: "domcontentloaded" });
    await page
      .getByRole("heading", { name: "Solicitudes de aprobación" })
      .waitFor({ timeout: 30000 });
    assert.equal(await page.getByText("1234", { exact: true }).count(), 0);
    assert.equal(
      await page
        .getByRole("button", { name: "Aprobar", exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole("button", { name: "Revisar operación" }).click();
    assert.equal(await page.getByText("1234", { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByRole("button", { name: "Aprobar", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await page.screenshot({ path: path.join(dir, `aprobacion-${width}.png`) });
    assert.equal(encargos, 0);
    await page
      .locator(".conversation-agents button")
      .filter({ hasText: "Menta" })
      .click();
    await page
      .getByRole("button", { name: "Nueva conversación", exact: true })
      .click();
    await page
      .getByLabel("Mensaje para Menta", { exact: true })
      .fill("Revisa los datos sintéticos");
    await page.screenshot({ path: path.join(dir, `sesiones-${width}.png`) });
    const respuesta = page.waitForResponse(
      (response) =>
        response.url().includes("/api/v1/agentes/sesiones") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Abrir conversación", exact: true })
      .click();
    await respuesta;
    assert.equal(encargos, 1);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Capturas: ${dir}`);
} finally {
  await browser.close();
  await app.close();
}
