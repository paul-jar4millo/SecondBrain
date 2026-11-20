// Build both checkouts first. node ops/benchmark-refuge.mjs <baseline repo> [current repo]
// Uses Playwright with the same optional paths as verify-refuge.mjs. No real vault or models.
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

if (!process.argv[2])
  throw new Error(
    "Uso: node ops/benchmark-refuge.mjs <repo-base-compilado> [repo-actual]",
  );
const currentRoot = path.resolve(
  process.argv[3] || fileURLToPath(new URL("../../", import.meta.url)),
);
const baselineRoot = path.resolve(process.argv[2]);
const require = createRequire(
  process.env.PLAYWRIGHT_PACKAGE || import.meta.url,
);
const { chromium } = require("playwright");
const root = await mkdtemp(path.join(tmpdir(), "sb-room-benchmark-"));
const output = path.join(currentRoot, ".impeccable/review/room-benchmark.json");
const apps = [];
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.BROWSER_EXECUTABLE || undefined,
    args: [
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
    ],
  });
  const report = {
    conditions: {
      platform: process.platform,
      node: process.version,
      browser: browser.version(),
      renderer: "SwiftShader",
      viewport: "1280x720",
      deviceScaleFactor: 1,
      adaptiveResolution: true,
      quality: "media",
      reducedMotion: true,
    },
    samples: [],
  };
  for (const [name, repo] of [
    ["base", baselineRoot],
    ["actual", currentRoot],
  ]) {
    const { createApplication } = await import(
      pathToFileURL(path.join(repo, "service/index.mjs")).href
    );
    const vaultRoot = path.join(root, name);
    await mkdir(path.join(vaultRoot, "00-Inbox"), { recursive: true });
    await writeFile(path.join(vaultRoot, "Home.md"), "# Synthetic benchmark\n");
    const app = await createApplication({
      vaultRoot,
      dataDirectory: path.join(vaultRoot, ".data"),
      auth: false,
    });
    apps.push(app);
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      localStorage.setItem("sb-refugio-calidad", "media");
      localStorage.setItem("sb-room-tour-v1", "done");
    });
    const page = await context.newPage();
    await page.goto(
      `http://127.0.0.1:${app.server.address().port}/?demo&debug`,
    );
    await page.waitForFunction(
      () =>
        window.__refugio?.stats().loaded && window.__refugio.stats().frames > 5,
    );
    let previous = await page.evaluate(() => window.__refugio.positions());
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(1000);
      const next = await page.evaluate(() => window.__refugio.positions());
      const delta = Object.keys(previous).reduce(
        (sum, id) =>
          sum +
          Math.hypot(next[id].x - previous[id].x, next[id].z - previous[id].z),
        0,
      );
      previous = next;
      if (delta < 0.001) break;
    }
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const before = await page.evaluate(() => window.__refugio.stats().frames);
      const start = performance.now();
      await page.waitForTimeout(2500);
      const after = await page.evaluate(() => window.__refugio.stats());
      samples.push({
        fps: Number(
          (
            (after.frames - before) /
            ((performance.now() - start) / 1000)
          ).toFixed(2),
        ),
        calls: after.calls,
        triangles: after.triangles,
        textures: after.textures,
        quality: after.quality,
        pixelRatio: after.pixelRatio,
      });
    }
    report.samples.push({ name, samples });
    console.log(JSON.stringify({ name, samples }));
    await context.close();
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  for (const app of apps) await app.close();
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
}
