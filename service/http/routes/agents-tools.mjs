import { body, send } from "../io.mjs";
import { Failure } from "../../vault.mjs";
/** @import { RouteModule } from "../route-types.d.ts" */

/** @type {RouteModule} */
export const agentToolRoutes = (ctx, req) => {
  const { auth, lanzador, resolveServerProfile } = ctx;
  const { callerCap, consulta, request, response } = req;
  return {
    "GET /agentes/capacidades": async () =>
      send(response, 200, await lanzador.capacidades()),
    "GET /agentes/mi-capacidad": async () => {
      if (callerCap) {
        const { digest: _d, ...publicCap } = callerCap;
        return send(response, 200, { scoped: true, ...publicCap });
      }
      if (auth.isAgent(request)) {
        return send(response, 200, {
          scoped: false,
          unrestrictedLegacyRoom: true,
        });
      }
      return send(response, 200, { scoped: false, owner: true });
    },
    "POST /agentes/capacidades/token": async () => {
      if (!auth.isSupervisor(request)) {
        throw new Failure(
          "Solo el operador o supervisor puede emitir credenciales acotadas.",
          403,
        );
      }
      const data = await body(request);
      const prof = await resolveServerProfile(
        data.profileId || "investigacion",
        data.parentProfileId
          ? await resolveServerProfile(data.parentProfileId)
          : null,
      );
      const minted = await auth.issueCapability({
        sessionId: data.sessionId ?? null,
        parentSessionId: data.parentSessionId ?? null,
        workOrderId: data.workOrderId ?? null,
        memberId: data.memberId ?? null,
        actor: data.actor ?? null,
        profileId: prof.id,
        allowedMcps: prof.allowedMcps,
        allowedOperations: prof.allowedOperations,
        allowedEffectCategories: prof.allowedEffectCategories,
        allowBilledApi: false,
        canDelegateBeyondSelf: false,
        depth: data.parentSessionId ? 2 : 1,
        maxDepth: 2,
      });
      const { digest: _d, ...publicRec } = minted.record;
      return send(response, 201, {
        token: minted.token,
        capacidad: publicRec,
      });
    },
    "GET /agentes/herramientas/catalogo": async () =>
      send(
        response,
        200,
        await lanzador.catalogoHerramientas({
          motor: consulta.get("motor") ?? undefined,
          profileId: consulta.get("profileId") ?? undefined,
          parentProfileId: consulta.get("parentProfileId") ?? undefined,
          memberId: consulta.get("memberId") ?? undefined,
          sessionId: consulta.get("sessionId") ?? undefined,
          probe: consulta.get("probe") === "true" ? "true" : undefined,
        }),
      ),
    "POST /agentes/herramientas/perfiles": async () =>
      send(
        response,
        200,
        await lanzador.actualizarPerfilHerramientas(await body(request)),
      ),
    "POST /agentes/herramientas/skills/resolver": async () => {
      const payload = await body(request);
      const { billingAuthorized: _ignored, ...safePayload } = payload;
      return send(response, 200, await lanzador.resolverSkills(safePayload));
    },
  };
};
