import {
  readFile,
  writeFile,
  mkdir,
  rename,
  chmod,
  rm,
} from "node:fs/promises";
import path from "node:path";
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { Failure } from "./vault.mjs";

/** @import { ServerResponse } from "node:http" */
/** @import { AuthOptions, AuthState, Capability, CapabilityOptions, Credentials, HttpRequest } from "./types.d.ts" */

const scrypt = promisify(scryptCallback);
/** @param {string} value */
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** @param {unknown} value */
const username = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";
/**
 * @param {unknown} a
 * @param {unknown} b
 */
const equal = (a, b) =>
  timingSafeEqual(
    Buffer.from(digest(String(a))),
    Buffer.from(digest(String(b))),
  );
/**
 * @param {HttpRequest} request
 * @returns {Record<string, string>}
 */
export function cookies(request) {
  return Object.fromEntries(
    (request.headers.cookie || "")
      .split(";")
      .map((part) => {
        const i = part.indexOf("=");
        return i < 0 ? [] : [part.slice(0, i).trim(), part.slice(i + 1).trim()];
      })
      .filter((x) => x.length),
  );
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** @param {Uint8Array} bytes */
function base32(bytes) {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return (bits.match(/.{1,5}/g) || [])
    .map((x) => alphabet[parseInt(x.padEnd(5, "0"), 2)])
    .join("");
}
/** @param {string} key */
function decode(key) {
  let bits = "";
  for (const c of key) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  return Buffer.from((bits.match(/.{8}/g) || []).map((x) => parseInt(x, 2)));
}
/** @param {string} secret */
export function totp(secret, step = Math.floor(Date.now() / 30000)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", decode(secret)).update(counter).digest();
  const offset = h[h.length - 1] & 15;
  return ((h.readUInt32BE(offset) & 0x7fffffff) % 1e6)
    .toString()
    .padStart(6, "0");
}
export class Auth {
  /**
   * @param {string} directory
   * @param {AuthOptions} [options]
   */
  constructor(
    directory,
    {
      production = false,
      trustedProxy = "",
      limit = 10,
      enabled = true,
      roomToken,
    } = {},
  ) {
    this.directory = directory;
    this.production = production;
    this.enabled = enabled;
    this.trustedProxy = trustedProxy;
    this.limit = limit;
    this.roomToken = roomToken;
    /** @type {Map<string | undefined, number[]>} */
    this.rates = new Map();
    /** @type {Map<string, Capability>} */
    this.capabilities = new Map();
    this.capSerial = Promise.resolve();
    this.serial = Promise.resolve();
    this.file = path.join(directory, "auth.json");
    this.capFile = path.join(directory, "capabilities.json");
    // Loaded by init(), which callers await before using the instance.
    /** @type {AuthState} */
    this.state = /** @type {any} */ (undefined);
    /** @type {string} */
    this.agentToken = /** @type {any} */ (undefined);
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      /** @type {AuthState} */
      const state = JSON.parse(await readFile(this.file, "utf8"));
      this.state = state;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      /** @type {AuthState} */
      const initialState = {
        sessions: {},
        csrfSecret: randomBytes(32).toString("hex"),
      };
      this.state = initialState;
      await this.persist();
    }
    try {
      /** @type {{ capabilities?: Record<string, Capability> }} */
      const capState = JSON.parse(await readFile(this.capFile, "utf8"));
      for (const [digestKey, rec] of Object.entries(
        capState?.capabilities || {},
      )) {
        if (rec && digestKey) this.capabilities.set(digestKey, rec);
      }
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (this.state.passwordHash && !this.state.username) {
      this.state.username = "admin";
      await this.persist();
    }
    await rm(path.join(this.directory, "bootstrap-token"), { force: true });
    const agentFile = path.join(this.directory, "agent-token");
    try {
      this.agentToken = await readFile(agentFile, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      this.agentToken = randomBytes(32).toString("hex");
      await writeFile(agentFile, this.agentToken, { mode: 0o600, flag: "wx" });
    }
  }
  async persist() {
    const temp = this.file + ".tmp";
    await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
    await rename(temp, this.file);
  }
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
  async lock(fn) {
    const previous = this.serial;
    /** @type {() => void} */
    let release = () => {};
    this.serial = new Promise((r) => (release = () => r(undefined)));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  /** @param {HttpRequest} request */
  secure(request) {
    const remote = request.socket.remoteAddress?.replace("::ffff:", "");
    return (
      !!request.socket.encrypted ||
      (remote === this.trustedProxy &&
        request.headers["x-forwarded-proto"] === "https")
    );
  }
  /**
   * @param {ServerResponse} response
   * @param {HttpRequest} request
   * @param {string} name
   * @param {string} value
   */
  cookie(response, request, name, value, maxAge = 14 * 86400) {
    if (this.production && !this.secure(request))
      throw new Failure(
        "El acceso privado requiere HTTPS a través del proxy configurado.",
        400,
      );
    const cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure(request) ? "; Secure" : ""}`;
    const prior =
      /** @type {string | string[] | undefined} */ (
        response.getHeader("Set-Cookie")
      ) || [];
    response.setHeader("Set-Cookie", [...prior, cookie]);
  }
  async persistCapabilities() {
    if (!this.capFile) return;
    const temp = `${this.capFile}.${process.pid}.tmp`;
    await writeFile(
      temp,
      JSON.stringify({ capabilities: Object.fromEntries(this.capabilities) }),
      { mode: 0o600 },
    );
    await rename(temp, this.capFile);
  }
  /**
   * @template T
   * @param {() => T | Promise<T>} fn
   */
  async capLock(fn) {
    const prev = this.capSerial;
    /** @type {() => void} */
    let release = () => {};
    this.capSerial = new Promise((r) => (release = () => r(undefined)));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  /** @param {CapabilityOptions} [options] */
  async issueCapability({
    sessionId = null,
    parentSessionId = null,
    workOrderId = null,
    memberId = null,
    actor = null,
    actors = [],
    profileId = "investigacion",
    allowedMcps = ["secondbrain"],
    allowedOperations = ["vault.read", "vault.search", "file.read", "user.ask"],
    allowedEffectCategories = [],
    allowBilledApi = false,
    canDelegateBeyondSelf = false,
    depth = 1,
    maxDepth = 2,
    ttlMs = 14 * 86400000,
  } = {}) {
    return this.capLock(async () => {
      const rawToken = `sbcap_${randomBytes(24).toString("hex")}`;
      const tokenDigest = digest(rawToken);
      const now = Date.now();
      /** @type {Capability} */
      const record = {
        id: randomUUID(),
        digest: tokenDigest,
        kind: "session_capability",
        sessionId,
        parentSessionId,
        workOrderId,
        memberId,
        actor,
        actors: [...new Set((actors || []).map(String))],
        profileId: String(profileId),
        allowedMcps: [...new Set((allowedMcps || []).map(String))],
        allowedOperations: [...new Set((allowedOperations || []).map(String))],
        allowedEffectCategories: [
          ...new Set((allowedEffectCategories || []).map(String)),
        ],
        allowBilledApi: Boolean(allowBilledApi),
        allowExternalWriteSecrets: false,
        canDelegateBeyondSelf: Boolean(canDelegateBeyondSelf),
        depth: Number(depth) || 1,
        maxDepth: Number(maxDepth) || 2,
        createdAt: new Date(now).toISOString(),
        expiresAt: Number(ttlMs) > 0 ? now + Number(ttlMs) : null,
        revoked: false,
      };
      this.capabilities.set(tokenDigest, record);
      await this.persistCapabilities();
      return { token: rawToken, record: structuredClone(record) };
    });
  }
  /**
   * @param {string} tokenId
   * @param {string} sessionId
   * @param {{ rebind?: boolean }} [options]
   */
  async bindCapabilitySession(tokenId, sessionId, { rebind = false } = {}) {
    return this.capLock(async () => {
      for (const [k, rec] of this.capabilities.entries()) {
        if (rec.id === tokenId) {
          if (!rebind && rec.sessionId && rec.sessionId !== sessionId) {
            throw new Failure("Credencial ya vinculada a otra sesión.", 409);
          }
          const next = { ...rec, sessionId };
          this.capabilities.set(k, next);
          await this.persistCapabilities();
          return structuredClone(next);
        }
      }
      return null;
    });
  }
  /** @param {{ tokenId?: string | null, sessionId?: string | null }} [options] */
  async revokeCapability({ tokenId = null, sessionId = null } = {}) {
    return this.capLock(async () => {
      let changed = false;
      // Revoking a session also revokes the credentials it delegated to its
      // children (and theirs), so a removed parent leaves no live descendants.
      const revokedSessions = new Set();
      let grew = true;
      while (grew) {
        grew = false;
        for (const [k, rec] of this.capabilities.entries()) {
          if (rec.revoked) continue;
          if (
            (tokenId && rec.id === tokenId) ||
            (sessionId && rec.sessionId === sessionId) ||
            (rec.parentSessionId && revokedSessions.has(rec.parentSessionId))
          ) {
            this.capabilities.set(k, { ...rec, revoked: true });
            if (rec.sessionId) revokedSessions.add(rec.sessionId);
            changed = true;
            grew = true;
          }
        }
      }
      if (changed) await this.persistCapabilities();
      return changed;
    });
  }
  /** @param {HttpRequest} request */
  capabilityOf(request) {
    const remote = request.socket?.remoteAddress?.replace("::ffff:", "");
    if (!["127.0.0.1", "::1"].includes(remote ?? "")) return null;
    const header = request.headers?.authorization || "";
    if (!header.startsWith("Bearer ")) return null;
    const raw = header.slice(7);
    if (!raw.startsWith("sbcap_")) return null;
    const rec = this.capabilities.get(digest(raw));
    if (!rec || rec.revoked) return null;
    if (rec.expiresAt && rec.expiresAt <= Date.now()) return null;
    return rec;
  }
  /** @param {HttpRequest} request */
  isSupervisor(request) {
    if (this.capabilityOf(request)) return false;
    const remote = request.socket?.remoteAddress?.replace("::ffff:", "");
    if (!["127.0.0.1", "::1"].includes(remote ?? "")) return false;
    if (
      this.agentToken &&
      equal(request.headers?.authorization || "", `Bearer ${this.agentToken}`)
    ) {
      return true;
    }
    return !this.isAgent(request) && this.authenticated(request);
  }
  /** @param {HttpRequest} request */
  isAgent(request) {
    const remote = request.socket.remoteAddress?.replace("::ffff:", "");
    return (
      ["127.0.0.1", "::1"].includes(remote ?? "") &&
      ((!!this.agentToken &&
        equal(
          request.headers.authorization || "",
          `Bearer ${this.agentToken}`,
        )) ||
        this.isRoomAgent(request))
    );
  }
  /** @param {HttpRequest} request */
  isRoomAgent(request) {
    const remote = request.socket.remoteAddress?.replace("::ffff:", "");
    if (!["127.0.0.1", "::1"].includes(remote ?? "")) return false;
    if (this.capabilityOf(request)) return true;
    return (
      !!this.roomToken &&
      equal(request.headers.authorization || "", `Bearer ${this.roomToken}`)
    );
  }
  /** @param {HttpRequest} request */
  authenticated(request) {
    if (this.isAgent(request)) return true;
    if (!this.enabled) return true;
    const token = cookies(request)["sb.session"];
    const session = token && this.state.sessions[digest(token)];
    return !!session && session.expires > Date.now();
  }
  /**
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  csrf(request, response) {
    let seed = cookies(request)["sb.csrf"];
    if (!/^[a-f0-9]{48}$/.test(seed || "")) {
      seed = randomBytes(24).toString("hex");
      this.cookie(response, request, "sb.csrf", seed);
    }
    return {
      token: createHmac("sha256", this.state.csrfSecret)
        .update(seed)
        .digest("hex"),
    };
  }
  /** @param {HttpRequest} request */
  checkCsrf(request) {
    const seed = cookies(request)["sb.csrf"];
    const expected =
      seed &&
      createHmac("sha256", this.state.csrfSecret).update(seed).digest("hex");
    if (!seed || !equal(expected, request.headers["x-csrf-token"] || ""))
      throw Object.assign(
        new Failure(
          "La sesión de seguridad cambió. Recarga para volver a intentar.",
          400,
        ),
        { code: "csrf" },
      );
    const origin = request.headers.origin;
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        throw new Failure("Origen inválido.", 403);
      }
      if (host !== request.headers.host)
        throw new Failure("Origen no permitido.", 403);
    }
  }
  /**
   * Behind the trusted proxy every request shares its address; it appends the client's.
   * @param {HttpRequest} request
   */
  client(request) {
    const remote = request.socket.remoteAddress?.replace("::ffff:", "");
    if (remote && remote === this.trustedProxy) {
      const forwarded = String(request.headers["x-forwarded-for"] || "")
        .split(",")
        .at(-1)
        ?.trim();
      if (forwarded) return forwarded;
    }
    return remote;
  }
  prune() {
    const now = Date.now();
    for (const [key, times] of this.rates) {
      const live = times.filter((t) => t > now - 60000);
      if (live.length) this.rates.set(key, live);
      else this.rates.delete(key);
    }
  }
  /** @param {HttpRequest} request */
  rate(request) {
    const key = this.client(request);
    const now = Date.now();
    const times = (this.rates.get(key) || []).filter((t) => t > now - 60000);
    if (times.length >= this.limit)
      throw new Failure("Demasiados intentos. Espera un minuto.", 429);
    times.push(now);
    this.rates.set(key, times);
  }
  /**
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  async session(request, response) {
    const token = randomBytes(32).toString("hex");
    for (const [key, s] of Object.entries(this.state.sessions))
      if (s.expires < Date.now()) delete this.state.sessions[key];
    this.state.sessions[digest(token)] = {
      expires: Date.now() + 14 * 86400000,
    };
    this.cookie(response, request, "sb.session", token);
    await this.persist();
  }
  /**
   * @param {Credentials} body
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  async setup(body, request, response) {
    return this.lock(async () => {
      this.rate(request);
      if (this.state.passwordHash)
        throw new Failure("El espacio ya tiene propietario.", 409);
      const owner = username(body.username);
      if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(owner))
        throw new Failure(
          "El usuario debe tener entre 3 y 64 caracteres: letras, números, punto, guion o guion bajo.",
        );
      if (
        typeof body.password !== "string" ||
        body.password.length < 12 ||
        body.password.length > 512
      )
        throw new Failure(
          "La contraseña debe tener entre 12 y 512 caracteres.",
        );
      const salt = randomBytes(16).toString("hex");
      const key = await scrypt(body.password, salt, 64);
      this.state.username = owner;
      this.state.passwordHash = key.toString("hex");
      this.state.salt = salt;
      await this.session(request, response);
      return { ok: true };
    });
  }
  /**
   * Checks owner credentials (and TOTP when enabled) without opening a session.
   * @param {Credentials} body
   */
  async check(body) {
    const state = this.state;
    if (
      !state.passwordHash ||
      typeof body.password !== "string" ||
      body.password.length > 512
    )
      throw new Failure("Usuario o contraseña incorrectos.", 401);
    // passwordHash and salt are always written together by setup().
    const key = await scrypt(
      body.password,
      /** @type {string} */ (state.salt),
      64,
    );
    if (
      !equal(key.toString("hex"), state.passwordHash) ||
      !equal(username(body.username), state.username)
    )
      throw new Failure("Usuario o contraseña incorrectos.", 401);
    if (state.totpSecret) {
      if (!body.code) return { requiresCode: true };
      const code = String(body.code).replace(/\s/g, "");
      if (code.includes("-")) {
        const index = state.recoveryDigests?.indexOf(digest(code)) ?? -1;
        if (index < 0)
          throw new Failure("Código de recuperación incorrecto.", 401);
        state.recoveryDigests?.splice(index, 1);
        await this.persist();
      } else {
        const secret = state.totpSecret;
        const step = Math.floor(Date.now() / 30000);
        const matched = [-1, 0, 1]
          .map((offset) => step + offset)
          .find(
            (candidate) =>
              candidate > (state.lastTotpStep ?? -1) &&
              equal(totp(secret, candidate), code),
          );
        if (matched === undefined)
          throw new Failure("Código de verificación incorrecto.", 401);
        state.lastTotpStep = matched;
        await this.persist();
      }
    }
    return { ok: true };
  }
  /**
   * @param {Credentials} body
   * @param {HttpRequest} request
   */
  async verifyCredentials(body, request) {
    return this.lock(async () => {
      this.rate(request);
      return this.check(body);
    });
  }
  /**
   * @param {Credentials} body
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  async login(body, request, response) {
    return this.lock(async () => {
      this.rate(request);
      const result = await this.check(body);
      if (!result.ok) return result;
      await this.session(request, response);
      return { ok: true };
    });
  }
  /**
   * @param {HttpRequest} request
   * @param {ServerResponse} response
   */
  async logout(request, response) {
    return this.lock(async () => {
      const token = cookies(request)["sb.session"];
      if (token) delete this.state.sessions[digest(token)];
      this.cookie(response, request, "sb.session", "", 0);
      await this.persist();
    });
  }
  async startTotp() {
    return this.lock(async () => {
      if (this.state.totpSecret)
        throw new Failure("La verificación en dos pasos ya está activada.");
      this.state.pendingTotpSecret ||= base32(randomBytes(20));
      await this.persist();
      return { key: this.state.pendingTotpSecret };
    });
  }
  /** @param {unknown} code */
  async enableTotp(code) {
    return this.lock(async () => {
      const pending = this.state.pendingTotpSecret;
      if (
        !pending ||
        ![-1, 0, 1].some((offset) =>
          equal(
            totp(pending, Math.floor(Date.now() / 30000) + offset),
            String(code || ""),
          ),
        )
      )
        throw new Failure("Código de verificación incorrecto.");
      const codes = Array.from(
        { length: 8 },
        () =>
          randomBytes(4).toString("hex") + "-" + randomBytes(4).toString("hex"),
      );
      this.state.totpSecret = this.state.pendingTotpSecret;
      delete this.state.pendingTotpSecret;
      this.state.recoveryDigests = codes.map(digest);
      await this.persist();
      return { codes };
    });
  }
}
