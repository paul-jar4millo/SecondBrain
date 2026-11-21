import test from "node:test";
import assert from "node:assert/strict";
import {
  createDecipheriv,
  createECDH,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createPush,
  encryptPayload,
  validSubscription,
  vapidHeader,
} from "../push.mjs";

/** A browser's side: its key pair and auth secret. */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    keys: {
      p256dh: ecdh.getPublicKey().toString("base64url"),
      auth: auth.toString("base64url"),
    },
    /** Decrypts as RFC 8291 describes, from the receiving end. */
    open(/** @type {Buffer} */ message) {
      const salt = message.subarray(0, 16);
      assert.equal(message.readUInt32BE(16), 4096);
      const idlen = message.readUInt8(20);
      const asPublic = message.subarray(21, 21 + idlen);
      const body = message.subarray(21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const ikm = Buffer.from(
        hkdfSync(
          "sha256",
          shared,
          auth,
          Buffer.concat([
            Buffer.from("WebPush: info\0"),
            ecdh.getPublicKey(),
            asPublic,
          ]),
          32,
        ),
      );
      const key = (/** @type {string} */ info, /** @type {number} */ n) =>
        Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from(info), n));
      const decipher = createDecipheriv(
        "aes-128-gcm",
        key("Content-Encoding: aes128gcm\0", 16),
        key("Content-Encoding: nonce\0", 12),
      );
      decipher.setAuthTag(body.subarray(-16));
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, -16)),
        decipher.final(),
      ]);
      assert.equal(plain.at(-1), 2, "last record delimiter");
      return plain.subarray(0, -1).toString();
    },
  };
}

test("a payload decrypts on the browser's side", () => {
  const ua = browser();
  const sealed = encryptPayload(ua.keys, Buffer.from('{"title":"Hola"}'));
  assert.equal(ua.open(sealed), '{"title":"Hola"}');
});

test("the VAPID token is signed by the advertised key", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const push = await createPush({ directory: dir });
  const keys = JSON.parse(await readFile(path.join(dir, "vapid.json"), "utf8"));
  if (process.platform !== "win32")
    assert.equal((await stat(path.join(dir, "vapid.json"))).mode & 0o077, 0);
  const header = vapidHeader(
    keys,
    "https://push.example.net/send/abc",
    "https://app.example.org",
    1_800_000_000,
  );
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  assert.equal(k, push.publicKey());
  const [h, c, s] = token.split(".");
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(claims, {
    aud: "https://push.example.net",
    exp: 1_800_000_000 + 12 * 3600,
    sub: "https://app.example.org",
  });
  const raw = Buffer.from(k, "base64url");
  const publicKey = createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
    format: "jwk",
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${h}.${c}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url"),
    ),
  );
});

test("sending reaches every subscription and drops the gone ones", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "sb-push-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = browser();
  const b = browser();
  /** @type {Array<{ url: string, init: any }>} */
  const calls = [];
  const push = await createPush({
    directory: dir,
    fetch: /** @type {any} */ (
      async (/** @type {string} */ url, /** @type {any} */ init) => {
        calls.push({ url, init });
        return new Response(null, { status: url.endsWith("/b") ? 410 : 201 });
      }
    ),
  });
  await push.subscribe(
    { endpoint: "https://push.example.net/a", keys: a.keys },
    "https://app.example.org",
  );
  await push.subscribe(
    { endpoint: "https://push.example.net/b", keys: b.keys },
    "https://app.example.org",
  );
  const result = await push.send({
    title: "Slug",
    body: "Listo para revisar",
    url: "/threads/thr_abc1234567",
  });
  assert.deepEqual(result, { sent: 1, dropped: 1 });
  const first = calls.find((c) => c.url.endsWith("/a"));
  assert.equal(first?.init.headers["content-encoding"], "aes128gcm");
  assert.deepEqual(JSON.parse(a.open(first?.init.body)), {
    title: "Slug",
    body: "Listo para revisar",
    url: "/threads/thr_abc1234567",
  });
  await push.flush();
  const again = await createPush({ directory: dir });
  assert.equal(again.count(), 1);
  assert.equal(again.publicKey(), push.publicKey());
});

test("only browser subscriptions over https are accepted", () => {
  const { keys } = browser();
  assert.ok(
    validSubscription({ endpoint: "https://push.example.net/x", keys }),
  );
  assert.equal(
    validSubscription({ endpoint: "http://push.example.net/x", keys }),
    null,
  );
  assert.equal(
    validSubscription({
      endpoint: "https://push.example.net/x",
      keys: { ...keys, auth: "corto" },
    }),
    null,
  );
});
