// Browser checks use only a disposable synthetic vault. No provider calls.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { createApplication } from "../../service/index.mjs";
import { browserExecutable } from "./browser-executable.mjs";

const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const root = await mkdtemp(path.join(tmpdir(), "sb-dashboards-"));
await mkdir(path.join(root, "00-Inbox"));
await mkdir(path.join(root, "01-Proyectos"));
await writeFile(path.join(root, "Home.md"), "# Synthetic browser vault\n");
await writeFile(
  path.join(root, "01-Proyectos/Proyecto-Mundo-Hipotetico.md"),
  "---\ntype: proyecto\nstatus: active\n---\n# Mundo Hipotético\n\n- [ ] Tarea sintética del canal\n",
);
const app = await createApplication({
  vaultRoot: root,
  dataDirectory: path.join(root, ".data"),
  auth: false,
});
await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});
const errors = [];
try {
  const output = fileURLToPath(
    new URL("../../.impeccable/review", import.meta.url),
  );
  await mkdir(output, { recursive: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 950 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${app.server.address().port}/projects`);
    const fixed = page.locator(".project-panel-link");
    await fixed.waitFor();
    await page.locator(".project-card h3").waitFor();
    assert.equal(await fixed.count(), 1);
    assert.equal(await page.locator(".project-channel").count(), 0);
    assert.equal(
      await fixed.getAttribute("href"),
      "/projects/mundo-hipotetico",
    );
    await page.screenshot({
      path: path.join(output, `project-dashboards-${name}.png`),
      fullPage: true,
    });
    await page.locator(".project-card h3").click();
    await page.getByRole("link", { name: "Abrir panel", exact: true }).click();
    await page
      .getByRole("heading", { name: "Mundo Hipotético", exact: true })
      .waitFor();
    assert.equal(new URL(page.url()).pathname, "/projects/mundo-hipotetico");
    // With no channel package the existing panel must explain its state, not crash.
    await page
      .locator(".mundo-panel #main")
      .getByText(/paquete|publicar/i)
      .first()
      .waitFor();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await page.goto(`http://127.0.0.1:${app.server.address().port}/projects`);
    await page.locator(".project-panel-link").click();
    await page
      .getByRole("heading", { name: "Mundo Hipotético", exact: true })
      .waitFor();
    await context.close();
    console.log(
      `${name}: panel fijo, acceso desde proyecto y ruta directa correctos`,
    );
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await app.close();
  await rm(root, { recursive: true, force: true });
}
