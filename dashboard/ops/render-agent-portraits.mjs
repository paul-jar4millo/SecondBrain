// Offline portraits of the original refuge characters. No remote imagery or model calls.
// Run against Vite: node ops/render-agent-portraits.mjs [http://127.0.0.1:5173]
import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const origin = process.argv[2] || "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../public/portraits/", import.meta.url));
await mkdir(output, { recursive: true });
const executablePath =
  process.env.BROWSER_EXECUTABLE ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({
    viewport: { width: 320, height: 320 },
    deviceScaleFactor: 1,
  });
  await page.route("**/__portraits", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><body style="margin:0;background:transparent"></body></html>',
    }),
  );
  await page.goto(`${origin}/__portraits`);
  await page.evaluate(async () => {
    const THREE = await import("/node_modules/three/build/three.module.js");
    const { AGENT_SPECS, createCharacter } =
      await import("/src/features/room/room-characters.js");
    const renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setSize(320, 320);
    renderer.setClearColor(0x000000, 0);
    document.body.append(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 2));
    const light = new THREE.DirectionalLight(0xdceaff, 2.5);
    light.position.set(-3, 5, 4);
    scene.add(light);
    const camera = new THREE.OrthographicCamera(
      -0.41,
      0.41,
      0.41,
      -0.41,
      0.01,
      20,
    );
    camera.position.set(0.12, 1.35, 4);
    camera.lookAt(0, 1.28, 0);
    const figures = [];
    for (const spec of AGENT_SPECS) {
      const person = await createCharacter(spec);
      person.raiz.visible = false;
      person.animar(0, "quieta");
      scene.add(person.raiz);
      figures.push(person);
    }
    window.renderPortrait = (id) => {
      figures.forEach((p) => {
        p.raiz.visible = p.spec.id === id;
      });
      renderer.render(scene, camera);
    };
  });
  for (const id of ["ambar", "menta", "lira", "marina"]) {
    await page.evaluate((id) => window.renderPortrait(id), id);
    await page
      .locator("canvas")
      .screenshot({ path: `${output}/${id}.png`, omitBackground: true });
    console.log(`Portrait: ${id}`);
  }
} finally {
  await browser.close();
}
