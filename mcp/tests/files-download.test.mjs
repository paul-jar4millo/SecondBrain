import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "../../service/index.mjs";
import { createBrainMcp } from "../index.mjs";

const NINE_MB = 9 * 1024 * 1024;

async function start() {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-files-download-"));
  const root = path.join(temp, "vault");
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Home\n");
  const tokenFile = path.join(temp, "room-token");
  await writeFile(tokenFile, "room-test-token");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: path.join(temp, "data"),
    auth: true,
    agentes: { tokenFile },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const owner = (
    await readFile(path.join(temp, "data", "agent-token"), "utf8")
  ).trim();
  const upload = async (name, buffer) => {
    const response = await fetch(
      `${baseUrl}/files/raw?area=para-agentes&name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner}`,
          "content-type": "application/octet-stream",
        },
        body: buffer,
      },
    );
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  return {
    temp,
    baseUrl,
    tokenFile,
    upload,
    stop: async () => {
      await app.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

async function connect(options) {
  const server = createBrainMcp({ token: "room-test-token", ...options });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((c) => c.text).join("");
    return {
      error: Boolean(result.isError),
      text,
      value: result.isError ? null : JSON.parse(text),
    };
  };
  return { client, call };
}

test("files_download guarda en disco un archivo grande sin pasarlo por el contexto", async () => {
  const t = await start();
  try {
    const bytes = Buffer.alloc(NINE_MB, 7);
    const entry = await t.upload("universidad.zip", bytes);
    const { client, call } = await connect({
      baseUrl: t.baseUrl,
      descargasLocales: true,
      carpetaBase: t.temp,
    });

    const saved = await call("files_download", { id: entry.id });
    assert.equal(saved.error, false, saved.text);
    assert.equal(saved.value.path, path.join(t.temp, "maletin", entry.name));
    assert.equal(saved.value.size, NINE_MB);
    assert.equal(saved.value.sha256, entry.sha256);
    assert.deepEqual(await readFile(saved.value.path), bytes);
    // The answer reaches the model: it must stay tiny whatever the file weighs.
    assert.ok(saved.text.length < 1000, `respuesta de ${saved.text.length}`);
    assert.deepEqual(await readdir(path.dirname(saved.value.path)), [
      entry.name,
    ]);

    const again = await call("files_download", { id: entry.id });
    assert.equal(again.error, false, again.text);
    assert.equal(again.value.path, saved.value.path);

    const elsewhere = path.join(t.temp, "otra", "copia.zip");
    const chosen = await call("files_download", {
      id: entry.id,
      destino: elsewhere,
    });
    assert.equal(chosen.value.path, elsewhere);
    assert.deepEqual(await readFile(elsewhere), bytes);

    const folder = await call("files_download", {
      id: entry.id,
      destino: path.join(t.temp, "otra"),
    });
    assert.equal(folder.value.path, path.join(t.temp, "otra", entry.name));

    await writeFile(elsewhere, "contenido ajeno");
    const clash = await call("files_download", {
      id: entry.id,
      destino: elsewhere,
    });
    assert.equal(clash.error, true);
    assert.match(clash.text, /ya existe/);
    assert.equal(await readFile(elsewhere, "utf8"), "contenido ajeno");

    const missing = await call("files_download", { id: "no-existe" });
    assert.equal(missing.error, true);
    await client.close();
  } finally {
    await t.stop();
  }
});

test("files_get rechaza lo que no cabe en el contexto y orienta a files_download", async () => {
  const t = await start();
  try {
    const big = await t.upload("universidad.zip", Buffer.alloc(NINE_MB, 7));
    const limit = await t.upload(
      "limite.bin",
      Buffer.alloc(8 * 1024 * 1024, 1),
    );
    const { client, call } = await connect({
      baseUrl: t.baseUrl,
      descargasLocales: true,
      carpetaBase: t.temp,
    });

    const refused = await call("files_get", { id: big.id });
    assert.equal(refused.error, true);
    assert.match(refused.text, /files_download/);
    assert.doesNotMatch(refused.text, /BwcHBwcH/);
    // Skipping ahead must not get around the limit.
    const skipped = await call("files_get", { id: big.id, offset: 1048576 });
    assert.equal(skipped.error, true);

    const allowed = await call("files_get", { id: limit.id, length: 1024 });
    assert.equal(allowed.error, false, allowed.text);
    assert.equal(allowed.value.bytes, 1024);
    await client.close();
  } finally {
    await t.stop();
  }
});

test("el MCP remoto no ofrece files_download: escribiría en el servidor", async () => {
  const t = await start();
  try {
    const { client } = await connect({ baseUrl: t.baseUrl });
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.ok(names.includes("files_get"));
    assert.ok(!names.includes("files_download"));
    assert.ok(!names.includes("files_upload"));
    await client.close();
  } finally {
    await t.stop();
  }
});

test("files_upload sube desde disco lo que files_put no puede, sin pasar por el contexto", async () => {
  const t = await start();
  try {
    const big = Buffer.alloc(NINE_MB + 1024, 9);
    const source = path.join(t.temp, "video universidad.mp4");
    await writeFile(source, big);
    const { client, call } = await connect({
      baseUrl: t.baseUrl,
      descargasLocales: true,
      carpetaBase: t.temp,
    });

    const sent = await call("files_upload", { ruta: source });
    assert.equal(sent.error, false, sent.text);
    assert.equal(sent.value.area, "de-agentes");
    assert.equal(sent.value.size, big.length);
    assert.equal(
      sent.value.sha256,
      createHash("sha256").update(big).digest("hex"),
    );
    assert.ok(sent.text.length < 1000, `respuesta de ${sent.text.length}`);

    const missing = await call("files_upload", {
      ruta: path.join(t.temp, "no-existe.mp4"),
    });
    assert.equal(missing.error, true);
    await client.close();
  } finally {
    await t.stop();
  }
});

test("la credencial de sala solo sube por streaming a de-agentes", async () => {
  const t = await start();
  try {
    const raw = (area) =>
      fetch(`${t.baseUrl}/files/raw?area=${area}&name=nota.bin`, {
        method: "POST",
        headers: {
          authorization: "Bearer room-test-token",
          "content-type": "application/octet-stream",
        },
        body: Buffer.from("hola"),
      });
    assert.equal((await raw("para-agentes")).status, 403);
    assert.equal((await raw("de-agentes")).status, 201);
  } finally {
    await t.stop();
  }
});

test("una descarga corrupta o incompleta no deja archivo", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-files-corrupt-"));
  const good = Buffer.from("contenido esperado");
  const server = http.createServer((request, response) => {
    if (request.url.startsWith("/files/download")) {
      response.writeHead(200);
      response.end("contenido alterado!");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        files: [
          {
            id: "abc",
            name: "dato.bin",
            size: good.length,
            sha256: createHash("sha256").update(good).digest("hex"),
            mime: "application/octet-stream",
          },
        ],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { client, call } = await connect({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      descargasLocales: true,
      carpetaBase: temp,
    });
    const result = await call("files_download", { id: "abc" });
    assert.equal(result.error, true);
    assert.match(result.text, /no coincide/);
    assert.deepEqual(await readdir(path.join(temp, "maletin")), []);
    await client.close();
  } finally {
    await new Promise((r) => server.close(r));
    await rm(temp, { recursive: true, force: true });
  }
});

test("la CLI de las agentes descarga en su carpeta de trabajo", async () => {
  const t = await start();
  try {
    const entry = await t.upload("material.zip", Buffer.alloc(1024, 3));
    const cli = fileURLToPath(new URL("../brain-cli.mjs", import.meta.url));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [cli, "files_download", JSON.stringify({ id: entry.id })],
      {
        cwd: t.temp,
        env: {
          ...process.env,
          SB_BRAIN_URL: t.baseUrl,
          SB_BRAIN_TOKEN_FILE: t.tokenFile,
        },
        timeout: 15000,
      },
    );
    const saved = JSON.parse(stdout);
    assert.equal(path.basename(saved.path), "material.zip");
    assert.equal((await readFile(saved.path)).length, 1024);
  } finally {
    await t.stop();
  }
});
