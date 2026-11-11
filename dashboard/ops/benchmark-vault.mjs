// node ops/benchmark-vault.mjs <baseline repo>; only a generated 5,000-note vault.
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import http from "node:http";
import assert from "node:assert/strict";
const currentRoot = fileURLToPath(new URL("../../", import.meta.url));
if (!process.argv[2])
  throw new Error("Indica el checkout base para la comparación.");
const root = await mkdtemp(path.join(tmpdir(), "sb-5000-"));
const results = [];
try {
  await mkdir(path.join(root, "00-Inbox"));
  await mkdir(path.join(root, "03-Recursos"));
  await writeFile(path.join(root, "Home.md"), "# Benchmark sintético\n");
  for (let start = 0; start < 4999; start += 50)
    await Promise.all(
      Array.from({ length: Math.min(50, 4999 - start) }, (_, offset) => {
        const i = start + offset;
        return writeFile(
          path.join(root, "03-Recursos", `Nota-${i}.md`),
          `---\ntype: nota\ntitle: Nota ${i}\n---\n\n${"Texto sintético privado. ".repeat(50)}\n- [ ] Tarea ${i}\n`,
        );
      }),
    );
  for (const [name, repo] of [
    ["base", path.resolve(process.argv[2])],
    ["actual", currentRoot],
  ]) {
    const { createApplication } = await import(
      pathToFileURL(path.join(repo, "service/index.mjs"))
    );
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: path.join(root, ".data-" + name),
      auth: false,
      agentes: { url: "", brainToken: "synthetic" },
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const samples = [];
      let etag;
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const sample = await new Promise((resolve, reject) => {
          http
            .get(
              {
                hostname: "127.0.0.1",
                port: app.server.address().port,
                path: "/api/v1/items",
                headers: {
                  "Accept-Encoding": "gzip",
                  ...(i === 2 && etag ? { "If-None-Match": etag } : {}),
                },
              },
              (response) => {
                let bytes = 0;
                response.on("data", (chunk) => (bytes += chunk.length));
                response.on("end", () =>
                  resolve({
                    status: response.statusCode,
                    bytes,
                    encoding:
                      response.headers["content-encoding"] || "identity",
                    etag: response.headers.etag,
                    ms: Number((performance.now() - start).toFixed(1)),
                  }),
                );
              },
            )
            .on("error", reject);
        });
        etag = sample.etag;
        samples.push(sample);
      }
      const result = { name, notes: 5000, samples, cache: app.vault.metrics };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      await app.close();
    }
  }
  const output = path.join(
    currentRoot,
    ".impeccable/review/vault-benchmark.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      { node: process.version, platform: process.platform, results },
      null,
      2,
    ),
  );
} finally {
  assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(root, { recursive: true, force: true });
}
