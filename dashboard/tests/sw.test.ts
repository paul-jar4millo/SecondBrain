import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

function buildSynthetic(withFonts: boolean) {
  const root = mkdtempSync(join(tmpdir(), "precache-"));
  const dist = join(root, "dist");
  for (const d of ["assets", "models/sala", "portraits", "ops"])
    mkdirSync(join(root, d === "ops" ? d : "dist/" + d), { recursive: true });
  if (withFonts) mkdirSync(join(dist, "fonts"));
  for (const f of [
    "index.html",
    "icon.svg",
    "icon-192.png",
    "icon-512.png",
    "manifest.webmanifest",
    "assets/app.js",
    "models/sala/sala.glb",
    "portraits/a.png",
    ...(withFonts ? ["fonts/fredoka.woff2", "fonts/readme.txt"] : []),
  ])
    writeFileSync(join(dist, f), "x");
  writeFileSync(join(dist, "sw.js"), "const CACHE = 'second-brain-shell-dev'");
  copyFileSync("ops/precache.mjs", join(root, "ops/precache.mjs"));
  execFileSync(process.execPath, [join(root, "ops/precache.mjs")]);
  return JSON.parse(
    readFileSync(join(dist, "precache.json"), "utf8"),
  ) as string[];
}

it("precaches woff2 fonts and tolerates a missing fonts folder", () => {
  const urls = buildSynthetic(true);
  expect(urls).toContain("/fonts/fredoka.woff2");
  expect(urls).not.toContain("/fonts/readme.txt");
  expect(buildSynthetic(false).some((u) => u.startsWith("/fonts/"))).toBe(
    false,
  );
});

it("precaches from the network, not from copies the browser cached by HTTP", async () => {
  const handlers: Record<string, (event: unknown) => void> = {};
  const fetched: Request[] = [];
  const fakeFetch = async (input: RequestInfo, init?: RequestInit) => {
    if (String(input).endsWith("/precache.json"))
      return new Response(
        JSON.stringify(["/index.html", "/models/sala/sala.glb"]),
      );
    throw new Error("unexpected fetch " + String(input) + JSON.stringify(init));
  };
  const caches = {
    open: async () => ({
      addAll: async (requests: (Request | string)[]) => {
        for (const r of requests)
          fetched.push(typeof r === "string" ? new Request("http://x" + r) : r);
      },
    }),
  };
  const self = {
    addEventListener: (name: string, fn: (event: unknown) => void) =>
      (handlers[name] = fn),
    skipWaiting: async () => {},
  };
  new Function(
    "self",
    "fetch",
    "caches",
    "location",
    "Request",
    readFileSync("public/sw.js", "utf8"),
  )(
    self,
    fakeFetch,
    caches,
    { origin: "http://x" },
    class extends Request {
      constructor(url: string, init?: RequestInit) {
        super(new URL(url, "http://x"), init);
      }
    },
  );
  let done: Promise<unknown> = Promise.resolve();
  handlers.install({ waitUntil: (p: Promise<unknown>) => (done = p) });
  await done;
  expect(fetched.map((r) => r.cache)).toEqual(["reload", "reload"]);
});
