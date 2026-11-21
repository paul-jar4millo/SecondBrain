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
    await page.route("**/api/v1/approvals", (route) =>
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
    await page.goto(url + "/finance", { waitUntil: "domcontentloaded" });
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
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Capturas: ${dir}`);
} finally {
  await browser.close();
  await app.close();
}
