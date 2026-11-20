// Team tools (POST /equipo/<action>) reach the launcher through here. The
// service checks the caller's capability and records what the team did in
// the work order before answering.
import path from "node:path";
import { Failure } from "../vault.mjs";
import { body, send } from "./io.mjs";
import { ENGINE_ACTOR, intersectProfileBounds } from "../agent-profiles.mjs";
import { randomUUID } from "node:crypto";
/** @import { ToolProfile } from "../types.d.ts" */
/** @import { WorkOrderManifest } from "../work-order-types.d.ts" */
/** @import { AppContext } from "./context.mjs" */
/** @import { RouteRequest } from "./route-types.d.ts" */

export const TEAM_ACTION =
  /^\/equipo\/(encargar|esperar|estado|mensaje|bandeja|entregar|integrar)$/;

/**
 * @param {AppContext} ctx
 * @param {Pick<RouteRequest, "request" | "response" | "callerCap">} req
 * @param {string} action
 */
export async function handleTeamAction(ctx, req, action) {
  const {
    auth,
    bridges,
    lanzador: launcher,
    resolveServerProfile,
    runStoreOp,
    sesionesLanzador: launcherSessions,
    workOrders,
  } = ctx;
  const { callerCap, request, response } = req;
  const sesion = request.headers["x-sb-sesion"];
  const actor = request.headers["x-sb-agente"];
  if (
    !auth.isRoomAgent(request) ||
    !/^[a-f0-9-]{36}$/i.test(sesion || "") ||
    !/^(ambar|menta|lira|marina)$/.test(actor || "")
  )
    throw new Failure("Se requiere una sesión de agente activa.", 403);
  const data = await body(request);
  let forwarded = data;
  let associatedWoId = data.workOrderId || null;
  if (["encargar", "entregar", "integrar"].includes(action)) {
    if (callerCap?.sessionId && sesion !== callerCap.sessionId) {
      throw new Failure("La sesión padre no coincide con tu credencial.", 403);
    }
    const parentSession = (await launcherSessions()).find(
      (s) => s.id === sesion,
    );
    const sessionWoId =
      parentSession?.workOrderId || callerCap?.workOrderId || null;
    // An agent only acts inside the work order its session belongs to.
    if (associatedWoId && associatedWoId !== sessionWoId)
      throw new Failure("La sesión no pertenece a ese encargo.", 403);
    if (!associatedWoId && sessionWoId) {
      associatedWoId = sessionWoId;
    }
    if (action === "encargar" && associatedWoId) {
      const wo = workOrders.get(associatedWoId);
      if (!wo) throw new Failure("Encargo no encontrado.", 404);
      if (!wo.manifest) {
        throw new Failure(
          "El encargo debe iniciarse con un manifiesto aprobado antes de delegar al equipo.",
          409,
        );
      }
      if (data.manifestSha256 && data.manifestSha256 !== wo.manifest.sha256) {
        throw new Failure(
          "Manifiesto del encargo desactualizado; recarga el equipo.",
          409,
        );
      }
      forwarded = {
        ...data,
        workOrderId: wo.id,
        manifest: wo.manifest,
        manifestSha256: data.manifestSha256 || wo.manifest.sha256,
      };
    }
  }
  let mintedChild = null;
  if (action === "encargar" && callerCap) {
    /** @type {ToolProfile} */
    let parentProfile = callerCap;
    const capWo = callerCap.workOrderId
      ? workOrders.get(callerCap.workOrderId)
      : null;
    const woCoord = capWo?.team?.find((m) => m.coordinator);
    if (woCoord?.toolProfileId) {
      const coordProf = await resolveServerProfile(woCoord.toolProfileId);
      parentProfile = intersectProfileBounds(coordProf, parentProfile);
    }
    // The card the manifest approved fixes the child's profile; the
    // agent can only narrow it further.
    /** @type {WorkOrderManifest | undefined} */
    const manifest = forwarded.manifest;
    const manifestCard =
      data.memberId && manifest?.team
        ? manifest.team.find((c) => c.id === data.memberId)
        : null;
    const childProfile = await resolveServerProfile(
      data.toolProfileId ||
        manifestCard?.toolProfileId ||
        callerCap.profileId ||
        "investigacion",
      parentProfile,
    );
    const preassignedSessionId = randomUUID();
    const childActor = ENGINE_ACTOR[data.motor] || null;
    mintedChild = await auth.issueCapability({
      sessionId: preassignedSessionId,
      parentSessionId: callerCap.sessionId || sesion,
      workOrderId: associatedWoId ?? callerCap.workOrderId ?? null,
      memberId: data.memberId || childActor || preassignedSessionId,
      actor: childActor,
      profileId: childProfile.id,
      allowedMcps: childProfile.allowedMcps,
      allowedOperations: childProfile.allowedOperations,
      allowedEffectCategories: childProfile.allowedEffectCategories,
      allowBilledApi: false,
      canDelegateBeyondSelf: false,
      depth: (callerCap.depth || 1) + 1,
      maxDepth: 2,
    });
    forwarded = {
      ...forwarded,
      id: preassignedSessionId,
      toolProfileId: childProfile.id,
      effectiveProfile: childProfile,
      capabilityToken: mintedChild.token,
      billingAuthorized: false,
    };
  }
  let result;
  try {
    // Both headers were validated against their patterns above.
    result = await launcher.equipo(
      action,
      /** @type {string} */ (sesion),
      /** @type {string} */ (actor),
      forwarded,
    );
    if (mintedChild && result?.id) {
      if (result.repetido) {
        // Idempotent replay: the existing child keeps its own
        // credential; the one minted for this call is not used.
        await auth.revokeCapability({
          tokenId: mintedChild.record.id,
        });
      } else if (result.id !== forwarded.id) {
        await auth.bindCapabilitySession(mintedChild.record.id, result.id, {
          rebind: true,
        });
      }
    }
  } catch (err) {
    if (mintedChild)
      await auth.revokeCapability({ tokenId: mintedChild.record.id });
    throw err;
  }
  if (action === "encargar" && associatedWoId && result?.id) {
    if (result.structured) {
      bridges.bridge(
        result.id,
        associatedWoId,
        result.memberId || data.memberId || result.motor,
      );
    }
    if (!result.repetido) {
      await runStoreOp(() =>
        workOrders.appendEvent(associatedWoId, {
          sourceId: actor,
          sessionId: result.id,
          idempotencyKey: `wo-child:${result.id}`,
          type: "member.status",
          provenance: "observed",
          payload: {
            memberId: result.memberId || null,
            motor: result.motor,
            modelo: result.modelo || null,
            esfuerzo: result.esfuerzo || null,
            role: result.role || null,
            status: result.estado,
            workspaceKind: result.workspaceKind || null,
            enColaRecursos: Boolean(result.enColaRecursos),
          },
        }),
      ).catch(() => {});
    }
  } else if (action === "entregar" && associatedWoId && result?.id) {
    await runStoreOp(() =>
      workOrders.appendEvent(associatedWoId, {
        sourceId: result.memberId || actor,
        sessionId: sesion,
        idempotencyKey: `wo-artifact:${result.id}`,
        type: "artifact.published",
        provenance: "observed",
        payload: {
          artifactId: result.id,
          authorId: result.memberId || actor,
          fileRef: result.ruta || `entregable/${result.id}`,
          fileName: result.ruta ? path.basename(result.ruta) : result.titulo,
          hash: result.sha256 || "",
          version: result.version || 1,
        },
      }),
    ).catch(() => {});
  } else if (action === "integrar" && associatedWoId && result) {
    await runStoreOp(() =>
      workOrders.appendEvent(associatedWoId, {
        sourceId: actor,
        sessionId: sesion,
        idempotencyKey: result.integracion?.id
          ? `wo-integ:${result.integracion.id}`
          : undefined,
        type: "member.status",
        provenance: "observed",
        payload: {
          reason:
            result.estado === "conflicto"
              ? "integration_conflict"
              : "integration_completed",
          estado: result.estado,
          conflictos: result.conflictos || [],
          // Local paths stay in the lanzador; events carry hashes.
          integrados: (result.integrados || []).map(
            /** @param {Record<string, unknown>} entry */
            ({ destino: _target, ...item }) => item,
          ),
        },
      }),
    ).catch(() => {});
  }
  return send(response, 200, result);
}
