// Team tools (POST /equipo/<action>) reach the launcher through here. The
// service checks the caller's capability and records what the team did in
// the work order before answering.
import path from "node:path";
import { Failure } from "../vault.mjs";
import { body, send } from "./io.mjs";
import { MOTOR_ACTOR, intersectProfileBounds } from "../agent-profiles.mjs";
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
 * @param {string} accion
 */
export async function handleTeamAction(ctx, req, accion) {
  const {
    auth,
    bridges,
    lanzador,
    resolveServerProfile,
    runStoreOp,
    sesionesLanzador,
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
  const datos = await body(request);
  let forwarded = datos;
  let associatedWoId = datos.workOrderId || null;
  if (["encargar", "entregar", "integrar"].includes(accion)) {
    if (callerCap?.sessionId && sesion !== callerCap.sessionId) {
      throw new Failure("La sesión padre no coincide con tu credencial.", 403);
    }
    const parentSession = (await sesionesLanzador()).find(
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
    if (accion === "encargar" && associatedWoId) {
      const wo = workOrders.get(associatedWoId);
      if (!wo) throw new Failure("Encargo no encontrado.", 404);
      if (!wo.manifest) {
        throw new Failure(
          "El encargo debe iniciarse con un manifiesto aprobado antes de delegar al equipo.",
          409,
        );
      }
      if (datos.manifestSha256 && datos.manifestSha256 !== wo.manifest.sha256) {
        throw new Failure(
          "Manifiesto del encargo desactualizado; recarga el equipo.",
          409,
        );
      }
      forwarded = {
        ...datos,
        workOrderId: wo.id,
        manifest: wo.manifest,
        manifestSha256: datos.manifestSha256 || wo.manifest.sha256,
      };
    }
  }
  let mintedChild = null;
  if (accion === "encargar" && callerCap) {
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
      datos.memberId && manifest?.team
        ? manifest.team.find((c) => c.id === datos.memberId)
        : null;
    const childProfile = await resolveServerProfile(
      datos.toolProfileId ||
        manifestCard?.toolProfileId ||
        callerCap.profileId ||
        "investigacion",
      parentProfile,
    );
    const preassignedSessionId = randomUUID();
    const childActor = MOTOR_ACTOR[datos.motor] || null;
    mintedChild = await auth.issueCapability({
      sessionId: preassignedSessionId,
      parentSessionId: callerCap.sessionId || sesion,
      workOrderId: associatedWoId ?? callerCap.workOrderId ?? null,
      memberId: datos.memberId || childActor || preassignedSessionId,
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
  let resultado;
  try {
    // Both headers were validated against their patterns above.
    resultado = await lanzador.equipo(
      accion,
      /** @type {string} */ (sesion),
      /** @type {string} */ (actor),
      forwarded,
    );
    if (mintedChild && resultado?.id) {
      if (resultado.repetido) {
        // Idempotent replay: the existing child keeps its own
        // credential; the one minted for this call is not used.
        await auth.revokeCapability({
          tokenId: mintedChild.record.id,
        });
      } else if (resultado.id !== forwarded.id) {
        await auth.bindCapabilitySession(mintedChild.record.id, resultado.id, {
          rebind: true,
        });
      }
    }
  } catch (err) {
    if (mintedChild)
      await auth.revokeCapability({ tokenId: mintedChild.record.id });
    throw err;
  }
  if (accion === "encargar" && associatedWoId && resultado?.id) {
    if (resultado.structured) {
      bridges.bridge(
        resultado.id,
        associatedWoId,
        resultado.memberId || datos.memberId || resultado.motor,
      );
    }
    if (!resultado.repetido) {
      await runStoreOp(() =>
        workOrders.appendEvent(associatedWoId, {
          sourceId: actor,
          sessionId: resultado.id,
          idempotencyKey: `wo-child:${resultado.id}`,
          type: "member.status",
          provenance: "observed",
          payload: {
            memberId: resultado.memberId || null,
            motor: resultado.motor,
            modelo: resultado.modelo || null,
            esfuerzo: resultado.esfuerzo || null,
            role: resultado.role || null,
            status: resultado.estado,
            workspaceKind: resultado.workspaceKind || null,
            enColaRecursos: Boolean(resultado.enColaRecursos),
          },
        }),
      ).catch(() => {});
    }
  } else if (accion === "entregar" && associatedWoId && resultado?.id) {
    await runStoreOp(() =>
      workOrders.appendEvent(associatedWoId, {
        sourceId: resultado.memberId || actor,
        sessionId: sesion,
        idempotencyKey: `wo-artifact:${resultado.id}`,
        type: "artifact.published",
        provenance: "observed",
        payload: {
          artifactId: resultado.id,
          authorId: resultado.memberId || actor,
          fileRef: resultado.ruta || `entregable/${resultado.id}`,
          fileName: resultado.ruta
            ? path.basename(resultado.ruta)
            : resultado.titulo,
          hash: resultado.sha256 || "",
          version: resultado.version || 1,
        },
      }),
    ).catch(() => {});
  } else if (accion === "integrar" && associatedWoId && resultado) {
    await runStoreOp(() =>
      workOrders.appendEvent(associatedWoId, {
        sourceId: actor,
        sessionId: sesion,
        idempotencyKey: resultado.integracion?.id
          ? `wo-integ:${resultado.integracion.id}`
          : undefined,
        type: "member.status",
        provenance: "observed",
        payload: {
          reason:
            resultado.estado === "conflicto"
              ? "integration_conflict"
              : "integration_completed",
          estado: resultado.estado,
          conflictos: resultado.conflictos || [],
          // Local paths stay in the lanzador; events carry hashes.
          integrados: (resultado.integrados || []).map(
            /** @param {Record<string, unknown>} entry */
            ({ destino: _destino, ...item }) => item,
          ),
        },
      }),
    ).catch(() => {});
  }
  return send(response, 200, resultado);
}
