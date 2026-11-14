import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createApplication } from "../index.mjs";
import { createBrainMcp } from "../../mcp/index.mjs";

async function start() {
  const temp = await mkdtemp(path.join(tmpdir(), "sb-shared-"));
  const root = path.join(temp, "vault"),
    data = path.join(temp, "data");
  await mkdir(path.join(root, "00-Inbox"), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Home\n");
  const tokenFile = path.join(temp, "room-token");
  await writeFile(tokenFile, "room-test-token");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: data,
    auth: true,
    agentes: { tokenFile },
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const owner = {
    authorization: `Bearer ${(await readFile(path.join(data, "agent-token"), "utf8")).trim()}`,
    "content-type": "application/json",
  };
  const room = {
    authorization: "Bearer room-test-token",
    "content-type": "application/json",
  };
  return {
    temp,
    app,
    baseUrl,
    owner,
    room,
    stop: async () => {
      await app.close();
      await rm(temp, { recursive: true, force: true });
    },
  };
}

test("Ana sube en bruto, la agente descarga y solo puede quitar lo suyo", async () => {
  const t = await start();
  try {
    const raw = await fetch(
      t.baseUrl +
        "/files/raw?area=para-agentes&name=" +
        encodeURIComponent("../Guía final.pdf"),
      {
        method: "POST",
        headers: { authorization: t.owner.authorization },
        body: Buffer.from("%PDF-contenido"),
      },
    );
    assert.equal(raw.status, 201);
    const uploaded = await raw.json();
    assert.equal(uploaded.name, "Guía final.pdf");
    assert.equal(uploaded.size, 14);
    assert.match(uploaded.sha256, /^[a-f0-9]{64}$/);

    const listed = await (
      await fetch(t.baseUrl + "/files", { headers: t.room })
    ).json();
    assert.equal(listed.files.length, 1);

    const download = await fetch(
      t.baseUrl + "/files/download?id=" + uploaded.id,
      { headers: t.room },
    );
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /^attachment/);
    assert.equal(await download.text(), "%PDF-contenido");

    // Agents cannot write to the owner's folder nor remove their files.
    const bad = await fetch(t.baseUrl + "/files", {
      method: "POST",
      headers: t.room,
      body: JSON.stringify({
        area: "para-agentes",
        name: "x.txt",
        encoding: "utf8",
        content: "x",
      }),
    });
    assert.equal(bad.status, 403);
    const forbidden = await fetch(t.baseUrl + "/files/trash", {
      method: "POST",
      headers: t.room,
      body: JSON.stringify({ id: uploaded.id }),
    });
    assert.equal(forbidden.status, 403);
    // Pinning is the owner's only.
    assert.equal(
      (
        await fetch(t.baseUrl + "/files/pin", {
          method: "POST",
          headers: t.room,
          body: JSON.stringify({ id: uploaded.id, pinned: true }),
        })
      ).status,
      403,
    );
  } finally {
    await t.stop();
  }
});

test("admite cualquier tipo de archivo y siempre lo descarga como adjunto", async () => {
  const t = await start();
  try {
    const long = "a".repeat(200) + ".blend";
    const cases = [
      ["programa.exe", "programa.exe", "application/octet-stream"],
      ["modelo.blend", "modelo.blend", "application/octet-stream"],
      ["sin-extension", "sin-extension", "application/octet-stream"],
      [".env", ".env", "application/octet-stream"],
      ["constructor", "constructor", "application/octet-stream"],
      ["x.constructor", "x.constructor", "application/octet-stream"],
      ["script.py", "script.py", "text/plain"],
      ["pagina.html", "pagina.html", "text/html"],
      [long, "a".repeat(114) + ".blend", "application/octet-stream"],
    ];
    const content = Buffer.from([0, 255, 1, 254]);
    for (const [name, stored, mime] of cases) {
      const response = await fetch(
        t.baseUrl +
          "/files/raw?area=para-agentes&name=" +
          encodeURIComponent(name),
        {
          method: "POST",
          headers: { authorization: t.owner.authorization },
          body: content,
        },
      );
      assert.equal(response.status, 201, name);
      const entry = await response.json();
      assert.equal(entry.name, stored);
      assert.equal(entry.mime, mime, name);

      const download = await fetch(
        t.baseUrl + "/files/download?id=" + entry.id,
        { headers: t.room },
      );
      assert.equal(
        download.headers.get("content-type"),
        "application/octet-stream",
      );
      assert.match(download.headers.get("content-disposition"), /^attachment/);
      assert.match(download.headers.get("content-security-policy"), /sandbox/);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), content);
    }
  } finally {
    await t.stop();
  }
});

test("el servidor da tiempo a subir archivos grandes con una conexión lenta", async () => {
  const t = await start();
  try {
    assert.equal(t.app.server.requestTimeout, 30 * 60 * 1000);
    assert.ok(t.app.server.headersTimeout <= 60_000);
  } finally {
    await t.stop();
  }
});

test("rechaza nombres inválidos, vacíos y carpetas desconocidas", async () => {
  const t = await start();
  try {
    for (const name of ["", ".", "..", "../", "???"]) {
      const response = await fetch(
        t.baseUrl +
          "/files/raw?area=de-agentes&name=" +
          encodeURIComponent(name),
        {
          method: "POST",
          headers: { authorization: t.owner.authorization },
          body: Buffer.from("x"),
        },
      );
      assert.equal(response.status, 400, name);
    }
    const empty = await fetch(
      t.baseUrl + "/files/raw?area=de-agentes&name=a.txt",
      {
        method: "POST",
        headers: { authorization: t.owner.authorization },
        body: Buffer.alloc(0),
      },
    );
    assert.equal(empty.status, 400);
    const area = await fetch(
      t.baseUrl + "/files/raw?area=../vault&name=a.txt",
      {
        method: "POST",
        headers: { authorization: t.owner.authorization },
        body: Buffer.from("x"),
      },
    );
    assert.equal(area.status, 400);
    const list = await (
      await fetch(t.baseUrl + "/files", { headers: t.owner })
    ).json();
    assert.equal(list.files.length, 0);
  } finally {
    await t.stop();
  }
});

test("las herramientas MCP entregan, descargan en trozos y respetan la papelera", async () => {
  const t = await start();
  try {
    const server = createBrainMcp({
      baseUrl: t.baseUrl,
      token: "room-test-token",
      actor: "lira",
    });
    const client = new Client({ name: "test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    const call = async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args });
      const text = result.content.map((c) => c.text).join("");
      return {
        error: result.isError,
        value: result.isError ? text : JSON.parse(text),
      };
    };

    const text = await call("files_put", {
      name: "informe.md",
      content: "# Hola ñ",
      note: "borrador",
    });
    assert.equal(text.error, undefined);
    assert.equal(text.value.actor, "agente:lira");
    const binary = Buffer.alloc(300_000, 7);
    const big = await call("files_put", {
      name: "datos.zip",
      content: binary.toString("base64"),
      encoding: "base64",
    });

    const got = await call("files_get", { id: text.value.id });
    assert.equal(got.value.text, "# Hola ñ");

    const first = await call("files_get", {
      id: big.value.id,
      length: 200_000,
    });
    assert.equal(first.value.next, 200_000);
    const second = await call("files_get", {
      id: big.value.id,
      offset: first.value.next,
      length: 200_000,
    });
    assert.equal(second.value.next, null);
    assert.deepEqual(
      Buffer.concat([
        Buffer.from(first.value.base64, "base64"),
        Buffer.from(second.value.base64, "base64"),
      ]),
      binary,
    );

    assert.equal((await call("files_list")).value.length, 2);
    assert.equal(
      (await call("files_trash", { id: text.value.id })).error,
      undefined,
    );
    assert.equal((await call("files_list")).value.length, 1);
    assert.equal((await call("files_get", { id: text.value.id })).error, true);

    // The owner restores it from the trash.
    const restored = await fetch(t.baseUrl + "/files/restore", {
      method: "POST",
      headers: t.owner,
      body: JSON.stringify({ id: text.value.id }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await call("files_list")).value.length, 2);
    await client.close();
  } finally {
    await t.stop();
  }
});
