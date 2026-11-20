import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createApplication } from "../index.mjs";

const password = "una-contrasena-muy-larga";

async function withApp(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "sb-mcpr-vault-"));
  const runtime = await mkdtemp(path.join(tmpdir(), "sb-mcpr-data-"));
  for (const d of ["00-Inbox", "02-Areas", "99-Meta"])
    await mkdir(path.join(root, d), { recursive: true });
  await writeFile(path.join(root, "Home.md"), "# Mi vault\n");
  await writeFile(path.join(root, "AGENTS.md"), "# Reglas\n");
  const app = await createApplication({
    vaultRoot: root,
    dataDirectory: runtime,
    authLimit: 1000,
    auth: true,
  });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = "http://127.0.0.1:" + app.server.address().port;
  try {
    await fn({ base, root, runtime });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
    await rm(runtime, { recursive: true, force: true });
  }
}

async function createOwner(base) {
  const csrfRes = await fetch(base + "/api/v1/auth/csrf");
  const cookie = csrfRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const { token } = await csrfRes.json();
  const r = await fetch(base + "/api/v1/auth/setup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-TOKEN": token,
    },
    body: JSON.stringify({ username: "owner", password }),
  });
  assert.equal(r.status, 200);
}

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
};

async function registrar(base, name = "Claude móvil") {
  const r = await fetch(base + "/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    }),
  });
  assert.equal(r.status, 201);
  return (await r.json()).client_id;
}

async function autorizar(base, clientId, challenge, pass = password) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "abc",
  });
  const page = await fetch(base + "/oauth/authorize?" + params);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Claude móvil/);
  return fetch(base + "/oauth/authorize", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      state: "abc",
      code_challenge: challenge,
      username: "owner",
      password: pass,
    }),
  });
}

const token = (base, data) =>
  fetch(base + "/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });

async function mcp(base, accessToken, method, params, id = 1) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + accessToken,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function connect(base) {
  await createOwner(base);
  const clientId = await registrar(base);
  const { verifier, challenge } = pkce();
  const res = await autorizar(base, clientId, challenge);
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get("location"));
  assert.equal(target.searchParams.get("state"), "abc");
  const code = target.searchParams.get("code");
  const t = await token(base, {
    grant_type: "authorization_code",
    client_id: clientId,
    code,
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_verifier: verifier,
  });
  assert.equal(t.status, 200);
  return { clientId, tokens: await t.json(), code, verifier };
}

test("el handshake OAuth con PKCE entrega tokens y el MCP remoto responde con las mismas herramientas", () =>
  withApp(async ({ base }) => {
    const sin = await fetch(base + "/mcp", { method: "POST", body: "{}" });
    assert.equal(sin.status, 401);
    assert.match(sin.headers.get("www-authenticate"), /resource_metadata=/);
    const meta = await (
      await fetch(base + "/.well-known/oauth-authorization-server")
    ).json();
    assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
    const { tokens, code, clientId, verifier } = await connect(base);
    const lista = await mcp(base, tokens.access_token, "tools/list", {});
    assert.equal(lista.status, 200);
    const names = lista.body.result.tools.map((t) => t.name);
    assert.ok(names.includes("brain_context") && names.includes("brain_write"));
    // El código es de un solo uso.
    const otra = await token(base, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: verifier,
    });
    assert.equal(otra.status, 400);
  }));

test("rechaza contraseña incorrecta, verifier incorrecto y redirect no registrado", () =>
  withApp(async ({ base }) => {
    await createOwner(base);
    const clientId = await registrar(base);
    const { challenge } = pkce();
    const mala = await autorizar(
      base,
      clientId,
      challenge,
      "otra-contrasena-larga",
    );
    assert.equal(mala.status, 401);
    const bien = await autorizar(base, clientId, challenge);
    const code = new URL(bien.headers.get("location")).searchParams.get("code");
    const r = await token(base, {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      code_verifier: randomBytes(32).toString("base64url"),
    });
    assert.equal(r.status, 400);
    const ajeno = await fetch(
      base +
        "/oauth/authorize?" +
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: "https://evil.example/cb",
          response_type: "code",
          code_challenge: challenge,
        }),
    );
    assert.equal(ajeno.status, 400);
    const registry = await fetch(base + "/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }),
    });
    assert.equal(registry.status, 400);
  }));

test("brain_write por HTTP exige el hash actual, el cliente queda atribuido y revocar da 401", () =>
  withApp(async ({ base, root }) => {
    const { tokens, clientId } = await connect(base);
    const llamar = (name, args) =>
      mcp(
        base,
        tokens.access_token,
        "tools/call",
        { name, arguments: args },
        7,
      );
    const read = await llamar("brain_read", { path: "Home.md" });
    const note = JSON.parse(read.body.result.content[0].text);
    const mala = await llamar("brain_write", {
      path: "Home.md",
      content: "# Nuevo\n",
      expectedHash: "0".repeat(64),
    });
    assert.equal(mala.body.result.isError, true);
    assert.equal(
      await readFile(path.join(root, "Home.md"), "utf8"),
      "# Mi vault\n",
    );
    const buena = await llamar("brain_write", {
      path: "Home.md",
      content: "# Nuevo\n",
      expectedHash: note.hash,
    });
    assert.notEqual(buena.body.result.isError, true);
    assert.equal(
      await readFile(path.join(root, "Home.md"), "utf8"),
      "# Nuevo\n",
    );
    // Refresh rota el token: el anterior deja de servir.
    const created = await (
      await token(base, {
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
    ).json();
    assert.ok(created.access_token);
    const reuso = await token(base, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
    assert.equal(reuso.status, 400);
    // Revocar el cliente corta el acceso.
    const csrfRes = await fetch(base + "/api/v1/auth/csrf");
    assert.ok(csrfRes.ok);
    const revocado = await fetch(base + "/oauth/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: created.access_token }),
    });
    assert.equal(revocado.status, 200);
    assert.equal(
      (await mcp(base, created.access_token, "tools/list", {})).status,
      401,
    );
  }));
