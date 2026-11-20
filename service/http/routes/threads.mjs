// Threads (ADR 0010): the owner's API, relayed to the launcher, and the two
// agent routes behind thread_ask_user. Each thread gets its own sbcap_
// credential, bound to the thread id and revoked when the thread ends.
import { once } from "node:events";
import { body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
import { ENGINE_ACTOR, intersectList } from "../../agent-profiles.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

export const THREAD_ID = /^thr_[0-9A-Za-z_-]{6,64}$/;
export const THREAD_REQUEST_ID = /^req_[0-9A-Za-z_-]{6,64}$/;

const STATUS_ES = /** @type {Record<string, string>} */ ({
  open: "pendiente",
  answered: "respondida",
  cancelled: "cancelada",
  expired: "vencida",
});

/**
 * A thread request in the shape the usuario_* MCP tools already read.
 * @param {any} request
 */
export function asSolicitud(request) {
  return {
    id: request.id,
    threadId: request.threadId,
    kind: request.kind,
    title: request.title,
    prompt: request.body,
    options: request.options ?? [],
    fields: request.fields ?? [],
    status: STATUS_ES[request.status] ?? request.status,
    answer: request.answer,
    origin: request.origin,
    createdAt: request.createdAt,
    answeredAt: request.answeredAt,
  };
}

/**
 * Waits for an answer by polling the launcher, at most `timeout` ms.
 * @param {{ request: (id: string, requestId: string) => Promise<any> }} threads
 * @param {string} threadId
 * @param {string} requestId
 * @param {number} timeout
 */
export async function waitThreadRequest(threads, threadId, requestId, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const { request } = await threads.request(threadId, requestId);
    if (request.status !== "open" || Date.now() >= end) return request;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(1000, Math.max(0, end - Date.now()))),
    );
  }
}

/** @type {RouteModule} */
export const threadRoutes = (ctx, req) => {
  const { auth, lanzador, options, resolveServerProfile } = ctx;
  const { callerCap, consulta: query, request, response } = req;
  const threads = lanzador?.threads;

  const ownerOnly = () => {
    if (auth.isAgent(request))
      throw new Failure("Los threads solo se manejan desde la app.", 403);
  };
  const agentThread = () => {
    const id = callerCap?.sessionId;
    if (typeof id !== "string" || !THREAD_ID.test(id))
      throw new Failure("Tu credencial no pertenece a un thread.", 403);
    return id;
  };

  /**
   * Relays a launcher SSE stream untouched; either side closing ends both.
   * @param {string | null} id
   */
  const relay = async (id) => {
    ownerOnly();
    const origin = new AbortController();
    const cut = () => origin.abort();
    response.on("close", cut);
    const header = request.headers["last-event-id"];
    const upstream = await threads.stream(id, {
      after: query.get("after"),
      lastEventId: Array.isArray(header) ? header[0] : header,
      signal: origin.signal,
    });
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders?.();
    const watch = setInterval(() => {
      if (!auth.authenticated(request)) origin.abort();
    }, 20_000);
    watch.unref();
    try {
      for await (const chunk of upstream.body ?? []) {
        if (response.destroyed) break;
        if (!response.write(chunk)) await once(response, "drain");
      }
    } catch {
      /* either side closed */
    } finally {
      clearInterval(watch);
      response.off("close", cut);
      origin.abort();
      response.end();
    }
  };

  /** Credential for the thread's MCP servers, narrowed by operator policy. */
  const mintCapability = async (/** @type {string} */ engine) => {
    const profile = await resolveServerProfile("ejecucion");
    if (options.operatorToolPolicy?.allowedOperations)
      profile.allowedOperations = intersectList(
        profile.allowedOperations,
        options.operatorToolPolicy.allowedOperations,
      );
    if (options.operatorToolPolicy?.allowedMcps)
      profile.allowedMcps = intersectList(
        profile.allowedMcps,
        options.operatorToolPolicy.allowedMcps,
      );
    const actor = ENGINE_ACTOR[engine] || null;
    return auth.issueCapability({
      memberId: actor || engine,
      actor,
      profileId: profile.id,
      allowedMcps: profile.allowedMcps,
      allowedOperations: profile.allowedOperations,
      allowedEffectCategories: profile.allowedEffectCategories,
      allowBilledApi: false,
      canDelegateBeyondSelf: false,
      depth: 1,
      maxDepth: 1,
    });
  };

  return {
    "GET /threads": async () => {
      ownerOnly();
      const filters = new URLSearchParams();
      for (const key of ["status", "parent", "archived"]) {
        const value = query.get(key);
        if (value) filters.set(key, value);
      }
      return send(response, 200, await threads.list(filters));
    },
    "POST /threads": async () => {
      ownerOnly();
      const data = await body(request);
      if (
        data.agent?.engine === "deepseek" &&
        process.env.SB_ALLOW_BILLED_DEEPSEEK !== "1"
      )
        throw new Failure(
          "DeepSeek bloqueado por la política de gasto sin autorización explícita de gasto.",
          403,
        );
      const minted = await mintCapability(data.agent?.engine);
      let result;
      try {
        result = await threads.create({
          ...data,
          capabilityToken: minted.token,
        });
        await auth.bindCapabilitySession(minted.record.id, result.thread.id, {
          rebind: true,
        });
      } catch (error) {
        await auth.revokeCapability({ tokenId: minted.record.id });
        throw error;
      }
      return send(response, 201, result);
    },
    "GET /threads/detalle": async () => {
      ownerOnly();
      return send(response, 200, await threads.snapshot(query.get("id")));
    },
    "GET /threads/flujo": async () => relay(query.get("id") ?? ""),
    "GET /threads/feed": async () => relay(null),
    "POST /threads/mensajes": async () => {
      ownerOnly();
      const { id, ...data } = await body(request);
      return send(response, 202, await threads.send(id, data));
    },
    "POST /threads/interrumpir": async () => {
      ownerOnly();
      const { id } = await body(request);
      return send(response, 200, await threads.interrupt(id));
    },
    "POST /threads/responder": async () => {
      ownerOnly();
      const { id, requestId, answer } = await body(request);
      return send(
        response,
        200,
        await threads.answer(id, requestId, { answer, origin: "app" }),
      );
    },
    "POST /threads/cerrar": async () => {
      ownerOnly();
      const { id, ...data } = await body(request);
      const result = await threads.close(id, data);
      if (data.mode !== "pr") await auth.revokeCapability({ sessionId: id });
      return send(response, 200, result);
    },
    "POST /threads/archivar": async () => {
      ownerOnly();
      const { id } = await body(request);
      const result = await threads.archive(id);
      await auth.revokeCapability({ sessionId: id });
      return send(response, 200, result);
    },
    "GET /threads/diff": async () => {
      ownerOnly();
      return send(
        response,
        200,
        await threads.diff(query.get("id"), query.get("turnId") || undefined),
      );
    },
    "GET /bandeja": async () => {
      ownerOnly();
      return send(response, 200, await threads.inbox());
    },
    "POST /threads/agente/preguntar": async () => {
      const data = await body(request);
      const result = await threads.ask(agentThread(), data);
      return send(response, 201, {
        ok: true,
        solicitud: asSolicitud(result.request),
      });
    },
    "GET /threads/agente/solicitud": async () => {
      const result = await threads.request(agentThread(), query.get("id"));
      return send(response, 200, { solicitud: asSolicitud(result.request) });
    },
  };
};
