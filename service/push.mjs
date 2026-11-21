// Web push (phase C2): VAPID (RFC 8292) and aes128gcm payloads (RFC 8291)
// with node:crypto, so no push library is needed. The keys live in the
// service's data directory, readable only by the service.
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** @param {Buffer | Uint8Array} bytes */
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
/** @param {string} text */
const fromB64url = (text) => Buffer.from(text, "base64url");

/**
 * @typedef {{ endpoint: string, keys: { p256dh: string, auth: string }, contact: string, createdAt: string }} PushSubscription
 * @typedef {{ publicKey: string, privateKey: import("node:crypto").JsonWebKey }} VapidKeys
 */

/** Generates a P-256 key pair; the public key is the raw uncompressed point. */
export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([
    Buffer.from([4]),
    fromB64url(String(jwk.x)),
    fromB64url(String(jwk.y)),
  ]);
  return /** @type {VapidKeys} */ ({
    publicKey: b64url(raw),
    privateKey: privateKey.export({ format: "jwk" }),
  });
}

/**
 * The VAPID Authorization header for one push service.
 * @param {VapidKeys} keys
 * @param {string} endpoint
 * @param {string} contact mailto: or https: URL
 * @param {number} nowSeconds
 */
export function vapidHeader(keys, endpoint, contact, nowSeconds) {
  const header = b64url(
    Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = b64url(
    Buffer.from(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: nowSeconds + 12 * 3600,
        sub: contact,
      }),
    ),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey({ key: keys.privateKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/**
 * Encrypts one payload for a subscription (a single aes128gcm record).
 * @param {{ p256dh: string, auth: string }} target
 * @param {Buffer} plaintext
 * @param {{ salt?: Buffer, ecdh?: import("node:crypto").ECDH }} [fixed] for tests
 */
export function encryptPayload(target, plaintext, fixed = {}) {
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  const ecdh = fixed.ecdh ?? createECDH("prime256v1");
  if (!fixed.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      authSecret,
      Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
      32,
    ),
  );
  const salt = fixed.salt ?? randomBytes(16);
  const cek = Buffer.from(
    hkdfSync(
      "sha256",
      ikm,
      salt,
      Buffer.from("Content-Encoding: aes128gcm\0"),
      16,
    ),
  );
  const nonce = Buffer.from(
    hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** Accepts only what a browser's PushSubscription.toJSON() produces. */
export function validSubscription(/** @type {any} */ value) {
  if (!value || typeof value !== "object") return null;
  const { endpoint, keys } = value;
  if (typeof endpoint !== "string" || endpoint.length > 1024) return null;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (typeof p256dh !== "string" || fromB64url(p256dh).length !== 65)
    return null;
  if (typeof auth !== "string" || fromB64url(auth).length !== 16) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

/**
 * @param {{
 *   directory: string,
 *   fetch?: typeof fetch,
 *   now?: () => Date,
 * }} options
 */
export async function createPush({
  directory,
  fetch: send = fetch,
  now = () => new Date(),
}) {
  const keysFile = path.join(directory, "vapid.json");
  const subsFile = path.join(directory, "subscriptions.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  /** @type {VapidKeys} */
  let keys;
  try {
    keys = JSON.parse(await readFile(keysFile, "utf8"));
  } catch {
    keys = generateVapidKeys();
    await writeFile(keysFile, JSON.stringify(keys), { mode: 0o600 });
  }
  /** @type {PushSubscription[]} */
  let subscriptions = [];
  try {
    subscriptions = JSON.parse(await readFile(subsFile, "utf8"));
  } catch {
    // None yet.
  }
  let writing = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(subscriptions);
    writing = writing
      .then(async () => {
        await writeFile(`${subsFile}.tmp`, snapshot, { mode: 0o600 });
        await rename(`${subsFile}.tmp`, subsFile);
      })
      .catch(() => undefined);
    return writing;
  };

  return {
    publicKey: () => keys.publicKey,
    count: () => subscriptions.length,

    /**
     * @param {{ endpoint: string, keys: { p256dh: string, auth: string } }} subscription
     * @param {string} contact the app's origin, sent to the push service
     */
    async subscribe(subscription, contact) {
      subscriptions = [
        ...subscriptions.filter((s) => s.endpoint !== subscription.endpoint),
        { ...subscription, contact, createdAt: now().toISOString() },
      ].slice(-10);
      await save();
    },

    /** @param {string} endpoint */
    async unsubscribe(endpoint) {
      const before = subscriptions.length;
      subscriptions = subscriptions.filter((s) => s.endpoint !== endpoint);
      if (subscriptions.length !== before) await save();
    },

    /**
     * Sends one message to every subscription; gone ones are dropped.
     * @param {{ title: string, body: string, url: string, tag?: string }} message
     */
    async send(message) {
      const payload = Buffer.from(JSON.stringify(message));
      const gone = new Set();
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            const response = await send(subscription.endpoint, {
              method: "POST",
              headers: {
                authorization: vapidHeader(
                  keys,
                  subscription.endpoint,
                  subscription.contact,
                  Math.floor(now().getTime() / 1000),
                ),
                "content-encoding": "aes128gcm",
                "content-type": "application/octet-stream",
                ttl: String(24 * 3600),
                urgency: "high",
              },
              body: encryptPayload(subscription.keys, payload),
              redirect: "error",
              signal: AbortSignal.timeout(15_000),
            });
            if (response.status === 404 || response.status === 410)
              gone.add(subscription.endpoint);
          } catch {
            // The push service is unreachable; try again on the next notice.
          }
        }),
      );
      if (gone.size) {
        subscriptions = subscriptions.filter((s) => !gone.has(s.endpoint));
        await save();
      }
      return { sent: subscriptions.length, dropped: gone.size };
    },

    flush: () => writing,
  };
}
