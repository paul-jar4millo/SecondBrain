// Remote MCP: OAuth 2.1 authorization server (dynamic client registration,
// PKCE S256, rotating refresh tokens) plus the Streamable HTTP /mcp endpoint.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { atenderMcp } from "../mcp/http.mjs";

/** @import { OutgoingHttpHeaders, ServerResponse } from "node:http" */
/** @import { HttpRequest } from "./types.d.ts" */

/** @typedef {{ nombre: string, redirect_uris: string[], creado: string }} OAuthClient */
/** @typedef {{ clienteId: string, tipo: "access" | "refresh", expira: number }} OAuthToken */
/** @typedef {{ clienteId: string, redirect_uri: string, challenge: string, expira: number }} OAuthCode */

/** @param {string} v */
const digest = (v) => createHash("sha256").update(v).digest("hex");
const ACCESS_MS = 3600_000;
const REFRESH_MS = 60 * 86400_000;
const CODE_MS = 600_000;
/** @param {unknown} v */
const esc = (v) =>
  String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** @param {string} u */
const redirectSeguro = (u) => {
  try {
    const url = new URL(u);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/**
 * @param {{
 *   directory: string,
 *   auth: import("./auth.mjs").Auth,
 *   Failure: typeof import("./vault.mjs").Failure,
 *   baseUrl: () => string,
 *   now?: () => number,
 *   onChange?: () => void,
 * }} options
 */
export async function crearMcpRemoto({
  directory,
  auth,
  Failure,
  baseUrl,
  now = Date.now,
  onChange = () => {},
}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "oauth.json");
  /** @type {{ clients: Record<string, OAuthClient>, tokens: Record<string, OAuthToken> }} */
  let state = { clients: {}, tokens: {} };
  try {
    state = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  /** @type {Map<string, OAuthCode>} */
  const codes = new Map();
  /** @type {Map<string, number[]>} */
  const rates = new Map();
  let serial = Promise.resolve();
  const persist = () => {
    serial = serial.then(async () => {
      await writeFile(file + ".tmp", JSON.stringify(state), { mode: 0o600 });
      await rename(file + ".tmp", file);
    });
    return serial;
  };
  /**
   * @param {string} clave
   * @param {number} max
   */
  function limite(clave, max, ventana = 60_000) {
    const t = now();
    const lista = (rates.get(clave) || []).filter((x) => x > t - ventana);
    if (lista.length >= max)
      throw new Failure("Demasiadas peticiones. Espera un minuto.", 429);
    lista.push(t);
    rates.set(clave, lista);
  }
  /** @param {HttpRequest} request */
  const issuer = (request) =>
    `${auth.secure(request) ? "https" : "http"}://${request.headers.host}`;
  /**
   * @param {ServerResponse} response
   * @param {number} status
   * @param {unknown} value
   * @param {OutgoingHttpHeaders} [headers]
   */
  function json(response, status, value, headers = {}) {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(JSON.stringify(value));
    return true;
  }
  /** @param {HttpRequest} request */
  async function leer(request, limiteBytes = 65536) {
    /** @type {Buffer[]} */
    const partes = [];
    let total = 0;
    for await (const parte of request) {
      total += parte.length;
      if (total > limiteBytes)
        throw new Failure("Petición demasiado grande.", 413);
      partes.push(parte);
    }
    return Buffer.concat(partes).toString("utf8");
  }
  /** @param {HttpRequest} request */
  const formulario = async (request) =>
    Object.fromEntries(new URLSearchParams(await leer(request)));
  /** @param {string} clienteId */
  function emitir(clienteId) {
    const acceso = randomBytes(32).toString("hex");
    const refresco = randomBytes(32).toString("hex");
    const t = now();
    for (const [k, v] of Object.entries(state.tokens))
      if (v.expira < t) delete state.tokens[k];
    state.tokens[digest(acceso)] = {
      clienteId,
      tipo: "access",
      expira: t + ACCESS_MS,
    };
    state.tokens[digest(refresco)] = {
      clienteId,
      tipo: "refresh",
      expira: t + REFRESH_MS,
    };
    return {
      access_token: acceso,
      token_type: "Bearer",
      expires_in: ACCESS_MS / 1000,
      refresh_token: refresco,
    };
  }
  /** @param {HttpRequest} request */
  function cliente(request) {
    const cabecera = request.headers.authorization || "";
    if (!cabecera.startsWith("Bearer ")) return null;
    const token = state.tokens[digest(cabecera.slice(7))];
    if (!token || token.tipo !== "access" || token.expira < now()) return null;
    const c = state.clients[token.clienteId];
    return c ? { id: token.clienteId, ...c } : null;
  }
  /** @param {Record<string, string>} p */
  function paginaLogin(p, error = "", pedirCodigo = false) {
    const ocultos = ["client_id", "redirect_uri", "state", "code_challenge"]
      .map(
        (n) => `<input type="hidden" name="${n}" value="${esc(p[n] || "")}">`,
      )
      .join("");
    return `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar SecondBrain</title>
<style>body{font:16px system-ui;max-width:380px;margin:12vh auto;padding:0 16px}input,button{display:block;width:100%;box-sizing:border-box;margin:8px 0;padding:10px;font:inherit}.e{color:#b00020}</style>
<h1>Conectar SecondBrain</h1><p><b>${esc(p.cliente_nombre || "Un cliente MCP")}</b> pide acceso a tu vault.</p>${error ? `<p class="e" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/oauth/authorize">${ocultos}<input name="username" autocomplete="username" placeholder="Usuario" required>
<input name="password" type="password" autocomplete="current-password" placeholder="Contraseña" required>${pedirCodigo ? '<input name="code" inputmode="numeric" autocomplete="one-time-code" placeholder="Código de verificación" required>' : ""}
<button>Permitir acceso</button></form></html>`;
  }
  /**
   * @param {ServerResponse} response
   * @param {number} status
   * @param {string} contenido
   */
  function html(response, status, contenido) {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://localhost:* http://127.0.0.1:*; frame-ancestors 'none'",
    });
    response.end(contenido);
    return true;
  }
  /** @param {Record<string, string>} p */
  function validarAutorizacion(p) {
    const c = state.clients[p.client_id];
    if (!c) throw new Failure("Cliente desconocido.", 400);
    if (!c.redirect_uris.includes(p.redirect_uri))
      throw new Failure("redirect_uri no registrado.", 400);
    if (p.response_type !== undefined && p.response_type !== "code")
      throw new Failure("response_type no admitido.", 400);
    if (!/^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || ""))
      throw new Failure("Se requiere PKCE con S256.", 400);
    return c;
  }
  /**
   * @param {ServerResponse} response
   * @param {string} uri
   * @param {Record<string, string>} params
   */
  function redirigir(response, uri, params) {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params))
      if (v) url.searchParams.set(k, v);
    response.writeHead(302, {
      Location: url.toString(),
      "Cache-Control": "no-store",
    });
    response.end();
    return true;
  }

  return {
    /**
     * Returns true when the request belonged to OAuth / MCP and was answered.
     * @param {HttpRequest} request
     * @param {ServerResponse} response
     * @param {string} pathname
     */
    async manejar(request, response, pathname) {
      const metodo = request.method;
      const base = issuer(request);
      if (
        pathname === "/.well-known/oauth-protected-resource" ||
        pathname === "/.well-known/oauth-protected-resource/mcp"
      )
        return json(response, 200, {
          resource: `${base}/mcp`,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
        });
      if (pathname === "/.well-known/oauth-authorization-server")
        return json(response, 200, {
          issuer: base,
          authorization_endpoint: `${base}/oauth/authorize`,
          token_endpoint: `${base}/oauth/token`,
          registration_endpoint: `${base}/oauth/register`,
          revocation_endpoint: `${base}/oauth/revoke`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (pathname === "/oauth/register" && metodo === "POST") {
        limite("registro:" + auth.client(request), 10);
        let datos;
        try {
          datos = JSON.parse(await leer(request));
        } catch {
          throw new Failure("JSON inválido.", 400);
        }
        const uris = datos?.redirect_uris;
        if (
          !Array.isArray(uris) ||
          !uris.length ||
          uris.length > 5 ||
          !uris.every((u) => typeof u === "string" && redirectSeguro(u))
        )
          return json(response, 400, { error: "invalid_redirect_uri" });
        if (Object.keys(state.clients).length >= 25)
          throw new Failure("Demasiados clientes registrados.", 429);
        const id = randomBytes(16).toString("hex");
        const nombre =
          String(datos.client_name || "Cliente MCP")
            .replace(/[^\p{L}\p{N} ._-]/gu, "")
            .slice(0, 40) || "Cliente MCP";
        state.clients[id] = {
          nombre,
          redirect_uris: uris,
          creado: new Date(now()).toISOString(),
        };
        await persist();
        onChange();
        return json(response, 201, {
          client_id: id,
          client_name: nombre,
          redirect_uris: uris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        });
      }
      if (pathname === "/oauth/authorize" && metodo === "GET") {
        const p = Object.fromEntries(
          new URL(request.url, "http://x").searchParams,
        );
        const c = validarAutorizacion(p);
        return html(
          response,
          200,
          paginaLogin({ ...p, cliente_nombre: c.nombre }),
        );
      }
      if (pathname === "/oauth/authorize" && metodo === "POST") {
        const p = await formulario(request);
        const c = validarAutorizacion(p);
        const contexto = { ...p, cliente_nombre: c.nombre };
        let resultado;
        try {
          resultado = await auth.verifyCredentials(
            { username: p.username, password: p.password, code: p.code },
            request,
          );
        } catch (e) {
          if (e.status === 401 || e.statusCode === 401)
            return html(
              response,
              401,
              paginaLogin(contexto, e.message, !!p.code),
            );
          throw e;
        }
        if (resultado.requiresCode)
          return html(response, 200, paginaLogin(contexto, "", true));
        const codigo = randomBytes(32).toString("hex");
        codes.set(digest(codigo), {
          clienteId: p.client_id,
          redirect_uri: p.redirect_uri,
          challenge: p.code_challenge,
          expira: now() + CODE_MS,
        });
        return redirigir(response, p.redirect_uri, {
          code: codigo,
          state: p.state,
        });
      }
      if (pathname === "/oauth/token" && metodo === "POST") {
        limite("token:" + auth.client(request), 30);
        const p = await formulario(request);
        if (!state.clients[p.client_id])
          return json(response, 401, { error: "invalid_client" });
        if (p.grant_type === "authorization_code") {
          const clave = digest(p.code || "");
          const entrada = codes.get(clave);
          codes.delete(clave);
          if (
            !entrada ||
            entrada.expira < now() ||
            entrada.clienteId !== p.client_id ||
            entrada.redirect_uri !== p.redirect_uri
          )
            return json(response, 400, { error: "invalid_grant" });
          const calculado = createHash("sha256")
            .update(p.code_verifier || "")
            .digest("base64url");
          if (
            calculado.length !== entrada.challenge.length ||
            !timingSafeEqual(
              Buffer.from(calculado),
              Buffer.from(entrada.challenge),
            )
          )
            return json(response, 400, { error: "invalid_grant" });
          const tokens = emitir(p.client_id);
          await persist();
          return json(response, 200, tokens);
        }
        if (p.grant_type === "refresh_token") {
          const clave = digest(p.refresh_token || "");
          const t = state.tokens[clave];
          if (
            !t ||
            t.tipo !== "refresh" ||
            t.expira < now() ||
            t.clienteId !== p.client_id
          )
            return json(response, 400, { error: "invalid_grant" });
          delete state.tokens[clave];
          const tokens = emitir(p.client_id);
          await persist();
          return json(response, 200, tokens);
        }
        return json(response, 400, { error: "unsupported_grant_type" });
      }
      if (pathname === "/oauth/revoke" && metodo === "POST") {
        const p = await formulario(request);
        const clave = digest(p.token || "");
        if (state.tokens[clave]) {
          delete state.tokens[clave];
          await persist();
        }
        return json(response, 200, {});
      }
      if (pathname === "/mcp") {
        const c = cliente(request);
        if (!c)
          return json(
            response,
            401,
            { error: "invalid_token" },
            {
              "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
            },
          );
        limite("mcp:" + c.id, 120);
        if (!["POST", "GET", "DELETE"].includes(metodo))
          throw new Failure("Método no permitido.", 405);
        let cuerpo;
        if (metodo === "POST") {
          try {
            cuerpo = JSON.parse(await leer(request, 4 * 1024 * 1024));
          } catch {
            throw new Failure("JSON inválido.", 400);
          }
        }
        const etiqueta =
          c.nombre
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 30) || "remoto";
        await atenderMcp(request, response, cuerpo, {
          baseUrl: baseUrl(),
          token: auth.agentToken,
          cliente: etiqueta,
        });
        return true;
      }
      return false;
    },
    listar() {
      return Object.entries(state.clients).map(([id, c]) => ({
        id,
        nombre: c.nombre,
        creado: c.creado,
      }));
    },
    /** @param {string} id */
    async revocar(id) {
      if (!state.clients[id]) throw new Failure("Cliente no encontrado.", 404);
      delete state.clients[id];
      for (const [k, v] of Object.entries(state.tokens))
        if (v.clienteId === id) delete state.tokens[k];
      await persist();
      onChange();
    },
  };
}
