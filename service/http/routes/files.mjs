import { open } from "node:fs/promises";
import { body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
import { downloadHeaders } from "../../shared-files.mjs";
import { pipeline } from "node:stream/promises";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const fileRoutes = (ctx, req) => {
  const { actorOf, auth, logger, shared } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /files": async () => {
      return send(response, 200, {
        files: await shared.list(),
        trash: await shared.list({ trashed: true }),
      });
    },
    "GET /files/download": async () => {
      const { entry, file } = await shared.find(query.get("id"));
      // Open before writing the head: a vanished file is a clean 404, not a crash.
      const handle = await open(file, "r").catch((e) => {
        if (e.code === "ENOENT")
          throw new Failure("Archivo no encontrado.", 404);
        throw e;
      });
      response.writeHead(200, downloadHeaders(entry));
      try {
        await pipeline(handle.createReadStream({ autoClose: true }), response);
      } catch (e) {
        // Headers are already out: the best left is to cut the connection.
        logger({
          event: "http.stream",
          requestId: response.getHeader("X-Request-Id"),
          type: e.name || "Error",
          message: String(e.message ?? e),
        });
        response.destroy();
      }
      return;
    },
    "GET /files/chunk": async () => {
      /**
       * @param {string} name
       * @param {number} fallback
       * @param {number} min
       * @param {number} max
       */
      const integer = (name, fallback, min, max) => {
        const raw = query.get(name);
        if (raw === null || raw === "") return fallback;
        const n = Number(raw);
        if (!Number.isSafeInteger(n) || n < min || n > max)
          throw new Failure(
            `«${name}» debe ser un entero entre ${min} y ${max}.`,
          );
        return n;
      };
      const length = integer("length", 262144, 1, 1024 * 1024);
      const offset = integer("offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const part = await shared.chunk(query.get("id"), offset, length);
      return send(response, 200, {
        ...part.entry,
        offset: part.offset,
        bytes: part.bytes,
        next:
          part.offset + part.bytes < part.entry.size
            ? part.offset + part.bytes
            : null,
        base64: part.buffer.toString("base64"),
      });
    },
    "POST /files": async () => {
      const input = await body(request);
      const room = auth.isRoomAgent(request);
      if (room && input.area !== "de-agentes")
        throw new Failure("Las agentes solo pueden subir a «de-agentes».", 403);
      const entry = await shared.put({
        area: input.area,
        name: input.name,
        note: input.note,
        actor: actorOf(request),
        buffer: Buffer.from(input.content, input.encoding),
      });
      return send(response, 201, entry);
    },
    "POST /files/raw": async () => {
      if (auth.isRoomAgent(request) && query.get("area") !== "de-agentes")
        throw new Failure("Las agentes solo pueden subir a «de-agentes».", 403);
      const entry = await shared.putStream({
        area: query.get("area"),
        name: query.get("name"),
        note: query.get("note"),
        actor: actorOf(request),
        stream: request,
      });
      return send(response, 201, entry);
    },
    "POST /files/trash": async () => {
      const { id } = await body(request);
      return send(
        response,
        200,
        await shared.trash(id, {
          onlyArea: auth.isRoomAgent(request) ? "de-agentes" : undefined,
        }),
      );
    },
    "POST /files/restore": async () => {
      return send(
        response,
        200,
        await shared.restore((await body(request)).id),
      );
    },
    "POST /files/pin": async () => {
      const { id, pinned } = await body(request);
      return send(response, 200, await shared.pin(id, pinned));
    },
  };
};
