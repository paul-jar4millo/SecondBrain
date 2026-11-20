import { body, relayArtifactDownload, send } from "../io.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentConversationRoutes = (ctx, req) => {
  const { bridges, lanzador: launcher } = ctx;
  const { consulta: query, request, response } = req;
  return {
    "GET /agentes/conversacion/artefactos/descargar": async () => {
      const upstream = await launcher.descargarArtefacto(
        query.get("id"),
        query.get("artifactId"),
      );
      await relayArtifactDownload(response, upstream);
      return;
    },
    "POST /agentes/conversacion/responder": async () =>
      send(response, 200, await launcher.responder(await body(request))),
    "GET /agentes/conversacion/cola": async () =>
      send(response, 200, await launcher.colaConversacion(query.get("id"))),
    "POST /agentes/conversacion/mensajes": async () => {
      const payload = await body(request);
      const sent = await launcher.enviarMensajeConversacion(payload);
      const link = bridges.linkOf(payload.id);
      if (link) {
        bridges.bridge(payload.id, link.workOrderId, link.fallbackMemberId);
      }
      return send(response, 200, sent);
    },
    "POST /agentes/conversacion/cola/cancelar": async () =>
      send(
        response,
        200,
        await launcher.cancelarColaConversacion(await body(request)),
      ),
  };
};
