import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createApplication } from "../index.mjs";
import { totp } from "../auth.mjs";
import { fixture } from "./helpers/vault-fixture.mjs";

test("fresh authentication protects a real file-backed API; CSRF, TOTP, recovery, external updates and static routes work", () =>
  fixture(async ({ root, write }) => {
    await write("00-Inbox/Existente.md", "# Ya estaba aquí\nSin importar.");
    const runtime = await mkdtemp(path.join(tmpdir(), "sb-auth-"));
    const staticRoot = path.join(runtime, "dist");
    await mkdir(staticRoot);
    await writeFile(path.join(staticRoot, "index.html"), "<h1>App</h1>");
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: runtime,
      staticRoot,
      authLimit: 100,
      auth: true,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + app.server.address().port;
    const jar = new Map();
    async function request(
      route,
      method = "GET",
      data,
      expected = 200,
      csrf = true,
    ) {
      let token;
      if (method !== "GET" && csrf)
        token = (await request("/api/v1/auth/csrf")).token;
      const response = await fetch(base + route, {
        method,
        headers: {
          "Content-Type": "application/json",
          Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; "),
          ...(token ? { "X-CSRF-TOKEN": token } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      });
      for (const cookie of response.headers.getSetCookie()) {
        const first = cookie.split(";")[0];
        const i = first.indexOf("=");
        jar.set(first.slice(0, i), first.slice(i + 1));
      }
      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = text;
      }
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    }
    try {
      await request("/api/v1/items", "GET", undefined, 401);
      await request("/api/v1/mutations", "POST", {}, 400, false);
      const password = "a-unique-long-password";
      await request(
        "/api/v1/auth/setup",
        "POST",
        { username: "..", password },
        400,
      );
      await request("/api/v1/auth/setup", "POST", {
        username: "owner",
        password,
      });
      const loaded = await request("/api/v1/items");
      assert.ok(loaded.some((i) => i.title === "Ya estaba aquí"));
      const status = await request("/api/v1/vault/status");
      assert.equal(status.root, root);
      assert.equal(status.documents, 2);
      const note = loaded.find((i) => i.title === "Ya estaba aquí");
      await request("/api/v1/mutations", "POST", {
        mutationId: randomUUID(),
        baseVersion: note.version,
        entity: { ...note, body: "Escrito desde la app" },
      });
      assert.match(
        await readFile(path.join(root, note.vaultPath), "utf8"),
        /Escrito desde la app/,
      );
      await write(
        note.vaultPath,
        (await readFile(path.join(root, note.vaultPath), "utf8")).replace(
          "Escrito desde la app",
          "Editado en Obsidian",
        ),
      );
      assert.equal(
        (await request("/api/v1/items")).find((i) => i.id === note.id).body,
        undefined,
      );
      assert.match(
        (
          await request(
            "/api/v1/vault/note?path=" + encodeURIComponent(note.vaultPath),
          )
        ).content,
        /Editado en Obsidian/,
      );
      const controller = new AbortController();
      const stream = await fetch(base + "/api/v1/events", {
        headers: { Cookie: [...jar].map(([k, v]) => k + "=" + v).join("; ") },
        signal: controller.signal,
      });
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      await reader.read();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        await write(
          note.vaultPath,
          (await readFile(path.join(root, note.vaultPath), "utf8")) +
            "\nCambio para notificar.",
        );
        let message = "";
        while (!message.includes("data: changed")) {
          const chunk = await reader.read();
          assert.ok(!chunk.done);
          message += new TextDecoder().decode(chunk.value);
        }
        assert.match(message, /data: changed/);
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
      const setup = await request("/api/v1/auth/totp/start", "POST", {});
      const recovery = await request("/api/v1/auth/totp/enable", "POST", {
        code: totp(setup.key),
      });
      assert.equal(recovery.codes.length, 8);
      await request("/api/v1/auth/logout", "POST", {}, 204);
      assert.equal(
        (
          await request("/api/v1/auth/login", "POST", {
            username: "owner",
            password,
          })
        ).requiresCode,
        true,
      );
      await request("/api/v1/items", "GET", undefined, 401);
      await request("/api/v1/auth/login", "POST", {
        username: "owner",
        password,
        code: recovery.codes[0],
      });
      await request("/api/v1/auth/logout", "POST", {}, 204);
      await request(
        "/api/v1/auth/login",
        "POST",
        { username: "owner", password, code: recovery.codes[0] },
        401,
      );
      await request("/api/v1/auth/login", "POST", {
        username: "owner",
        password,
        code: totp(setup.key),
      });
      assert.match(await request("/notes/anything"), /App/);
      await request("/api/v1/not-there", "GET", undefined, 404);
    } finally {
      await app.close();
      await rm(runtime, { recursive: true, force: true });
    }
  }));

test("keeps credentials and sessions across Node restarts, and persists logout revocation", () =>
  fixture(async ({ root }) => {
    const { Auth } = await import("../auth.mjs");
    const directory = path.join(root, ".auth");
    const first = new Auth(directory);
    await first.init();
    const values = new Map();
    const response = {
      getHeader: (key) => values.get(key),
      setHeader: (key, value) => values.set(key, value),
    };
    const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
    await first.setup(
      {
        password: "a-password-for-restarts",
        username: "owner",
      },
      request,
      response,
    );
    const cookie = values
      .get("Set-Cookie")
      .find((s) => s.startsWith("sb.session="))
      .split(";")[0];
    const second = new Auth(directory);
    await second.init();
    const authenticated = { ...request, headers: { cookie } };
    assert.ok(second.authenticated(authenticated));
    await second.logout(authenticated, response);
    const third = new Auth(directory);
    await third.init();
    assert.equal(third.authenticated(authenticated), false);
  }));

test("a malformed request target gets a 400 and the server stays up", () =>
  fixture(async ({ root }) => {
    const app = await createApplication({
      vaultRoot: root,
      dataDirectory: path.join(root, ".data"),
      auth: false,
    });
    await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
    try {
      const { port } = app.server.address();
      const reply = await new Promise((resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () =>
          socket.write(
            "GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
          ),
        );
        let text = "";
        socket.on("data", (d) => (text += d));
        socket.on("end", () => resolve(text));
        socket.on("error", reject);
      });
      assert.match(reply, /^HTTP\/1\.1 400/);
      const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      assert.equal(health.status, 200);
    } finally {
      await app.close();
    }
  }));
