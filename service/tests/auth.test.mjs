import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Auth } from "../auth.mjs";

test("la credencial de la sala solo autentica conexiones loopback reales", () => {
  const auth = new Auth("unused", { roomToken: "room-test" });
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(
      auth.isRoomAgent({
        socket: { remoteAddress: address },
        headers: { authorization: "Bearer room-test" },
      }),
      true,
    );
  }
  assert.equal(
    auth.isRoomAgent({
      socket: { remoteAddress: "192.0.2.13" },
      headers: {
        authorization: "Bearer room-test",
        "x-forwarded-for": "127.0.0.1",
      },
    }),
    false,
  );
  assert.equal(
    auth.isRoomAgent({
      socket: { remoteAddress: "127.0.0.1" },
      headers: { authorization: "Bearer wrong" },
    }),
    false,
  );
});

test("agent credentials work only on loopback, ignore forwarded addresses and survive restarts", () =>
  fixture(async ({ directory, auth, request }) => {
    const token = await readFile(path.join(directory, "agent-token"), "utf8");
    const local = { ...request, headers: { authorization: `Bearer ${token}` } };
    assert.equal(auth.isAgent(local), true);
    assert.equal(auth.authenticated(local), true);
    assert.equal(
      auth.isAgent({
        ...local,
        socket: { remoteAddress: "192.0.2.13" },
        headers: { ...local.headers, "x-forwarded-for": "127.0.0.1" },
      }),
      false,
    );
    assert.equal(
      auth.isAgent({ ...local, headers: { authorization: "Bearer wrong" } }),
      false,
    );
    await new Auth(directory).init();
    assert.equal(
      await readFile(path.join(directory, "agent-token"), "utf8"),
      token,
    );
  }));

async function fixture(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), "sb-auth-"));
  const auth = new Auth(directory, { limit: 100 });
  const request = { socket: { remoteAddress: "127.0.0.1" }, headers: {} };
  const headers = new Map();
  const response = {
    getHeader: (k) => headers.get(k),
    setHeader: (k, v) => headers.set(k, v),
  };
  try {
    await auth.init();
    await fn({ directory, auth, request, response });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("creates a username/password owner without an installation token and refuses a second owner", () =>
  fixture(async ({ directory, auth, request, response }) => {
    await assert.rejects(readFile(path.join(directory, "bootstrap-token")), {
      code: "ENOENT",
    });
    await auth.setup(
      { username: " Owner ", password: "a-long-private-password" },
      request,
      response,
    );
    await assert.rejects(
      auth.setup(
        { username: "other", password: "another-long-password" },
        request,
        response,
      ),
      { status: 409 },
    );
    const restarted = new Auth(directory);
    await restarted.init();
    await restarted.login(
      { username: "OWNER", password: "a-long-private-password" },
      request,
      response,
    );
    await assert.rejects(
      restarted.login(
        { username: "other", password: "a-long-private-password" },
        request,
        response,
      ),
      { status: 401 },
    );
    await assert.rejects(
      restarted.login(
        { username: "owner", password: "wrong" },
        request,
        response,
      ),
      { status: 401 },
    );
  }));

test("rejects missing or invalid usernames and short passwords without creating an owner", () =>
  fixture(async ({ auth, request, response }) => {
    for (const body of [
      { password: "a-long-private-password" },
      { username: "..", password: "a-long-private-password" },
      { username: "owner", password: "short" },
    ]) {
      await assert.rejects(auth.setup(body, request, response), {
        status: 400,
      });
      assert.equal(auth.state.passwordHash, undefined);
    }
  }));

test("migrates a password-only owner to admin without changing password or sessions, and removes obsolete installation tokens", () =>
  fixture(async ({ directory, auth, request, response }) => {
    await auth.setup(
      { username: "owner", password: "a-long-private-password" },
      request,
      response,
    );
    const original = JSON.parse(
      await readFile(path.join(directory, "auth.json"), "utf8"),
    );
    delete original.username;
    await writeFile(
      path.join(directory, "auth.json"),
      JSON.stringify(original),
    );
    await writeFile(path.join(directory, "bootstrap-token"), "obsolete");
    const migrated = new Auth(directory);
    await migrated.init();
    assert.equal(migrated.state.passwordHash, original.passwordHash);
    assert.deepEqual(migrated.state.sessions, original.sessions);
    await migrated.login(
      { username: "admin", password: "a-long-private-password" },
      request,
      response,
    );
    await assert.rejects(readFile(path.join(directory, "bootstrap-token")), {
      code: "ENOENT",
    });
  }));

test("login attempts are limited per client behind the trusted proxy", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sb-rate-"));
  try {
    const auth = new Auth(directory, {
      trustedProxy: "192.0.2.13",
      limit: 2,
    });
    await auth.init();
    const from = (client, remote = "192.0.2.13") => ({
      socket: { remoteAddress: remote },
      headers: { "x-forwarded-for": client },
    });
    auth.rate(from("10.0.0.1"));
    auth.rate(from("10.0.0.1"));
    assert.throws(() => auth.rate(from("10.0.0.1")), /Demasiados intentos/);
    assert.doesNotThrow(() => auth.rate(from("10.0.0.2")));
    // Anyone else cannot pick an address to dodge the limit.
    const direct = (client) => from(client, "10.9.9.9");
    auth.rate(direct("1.1.1.1"));
    auth.rate(direct("2.2.2.2"));
    assert.throws(() => auth.rate(direct("3.3.3.3")), /Demasiados intentos/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revocar una sesión revoca también las credenciales que delegó a sus hijas y nietas", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "sb-auth-cap-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const auth = new Auth(directory);
  await auth.init();
  const request = (token) => ({
    socket: { remoteAddress: "127.0.0.1" },
    headers: { authorization: `Bearer ${token}` },
  });
  const parent = await auth.issueCapability({ sessionId: "padre" });
  const child = await auth.issueCapability({
    sessionId: "hija",
    parentSessionId: "padre",
    depth: 2,
  });
  const grandchild = await auth.issueCapability({
    sessionId: "nieta",
    parentSessionId: "hija",
    depth: 3,
  });
  const other = await auth.issueCapability({ sessionId: "ajena" });

  assert.equal(await auth.revokeCapability({ sessionId: "padre" }), true);
  for (const { token } of [parent, child, grandchild]) {
    assert.equal(auth.capabilityOf(request(token)), null);
  }
  assert.equal(auth.capabilityOf(request(other.token))?.sessionId, "ajena");

  const reloaded = new Auth(directory);
  await reloaded.init();
  assert.equal(reloaded.capabilityOf(request(child.token)), null);
  assert.equal(reloaded.capabilityOf(request(other.token))?.sessionId, "ajena");
});
