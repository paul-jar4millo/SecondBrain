import { readdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const files = await readdir(new URL("../dist/assets", import.meta.url));
const models = await readdir(new URL("../dist/models/sala", import.meta.url));
const portraits = await readdir(new URL("../dist/portraits", import.meta.url));
// Fonts folder may be absent in minimal builds.
const fonts = await readdir(new URL("../dist/fonts", import.meta.url)).catch(
  () => [],
);
const urls = [
  "/index.html",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
  ...models
    .filter((f) => /\.(glb|json)$/.test(f))
    .map((f) => "/models/sala/" + f),
  ...fonts.filter((f) => /\.woff2$/.test(f)).map((f) => "/fonts/" + f),
  ...files.map((f) => "/assets/" + f),
  ...portraits.filter((f) => /\.png$/.test(f)).map((f) => "/portraits/" + f),
];
await writeFile(
  new URL("../dist/precache.json", import.meta.url),
  JSON.stringify(urls),
);
// Hash contents, not names: art and fonts keep stable URLs across releases.
const hash = createHash("sha256");
for (const url of urls)
  hash
    .update(url)
    .update(await readFile(new URL("../dist" + url, import.meta.url)));
const version = hash.digest("hex").slice(0, 12);
const path = new URL("../dist/sw.js", import.meta.url);
const source = await readFile(path, "utf8");
await writeFile(
  path,
  source.replace(
    /const CACHE\s*=\s*['"][^'"]+['"]/,
    `const CACHE='second-brain-shell-${version}'`,
  ),
);
