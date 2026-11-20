import type { SkillProvenance, ToolProfile } from "./tool-catalog-types.d.ts";

export type LauncherEngine = "claude" | "codex" | "agy" | "deepseek";
export type SessionOrigin = "sala" | "remote" | "cron" | "equipo" | "encargo";
export type SessionState =
  | "pendiente"
  | "trabajando"
  | "terminada"
  | "error"
  | "cancelada"
  | "interrumpida";

export interface SessionMessage {
  rol: string;
  texto: string;
}

export interface SessionCheckpoint {
  n: number;
  commit: string;
  arbol: string;
  ts: string;
  mensaje: string;
  tipo?: string;
  de?: number;
}

export interface SessionChanges {
  interactiva?: boolean;
  remotoUrl?: string | null;
  conversacionId?: string | null;
  mensajes?: SessionMessage[];
  estado?: SessionState;
  fase?: string | null;
  ultimaAccion?: string | null;
  resultado?: string | null;
  error?: string | null;
  relevo?: { id: string; tipo: "mensaje" | "entregable"; para: string };
  terminal?: string;
  contexto?: { usados: number; limite: number };
  checkpoints?: SessionCheckpoint[];
  checkpointError?: string | null;
  toolProfileId?: string | null;
  effectiveProfile?: ToolProfile | null;
  skillIds?: string[];
  skillProvenance?: SkillProvenance[];
  observedSkills?: { source: string; names: string[]; ts: string }[];
  conexion?: { estado: string; pid: number | null; motivo: string };
  role?: string | null;
  responsibility?: string | null;
  manifestSha256?: string | null;
  workspacePath?: string | null;
  workspaceKind?: string | null;
  enColaRecursos?: boolean;
  motivoCola?: string | null;
  enqueueOrder?: number | null;
}

export interface LauncherSession extends SessionChanges {
  id: string;
  motor: LauncherEngine;
  origen: SessionOrigin;
  estado: SessionState;
  equipoId: string | null;
  padreId: string | null;
  proyecto: string | null;
  espacioId: string | null;
  harness: boolean;
  structured?: boolean;
  workOrderId?: string;
  memberId?: string;
  billingAuthorized?: boolean;
  directorio: string | null;
  copia: number;
  encargo: string | null;
  creada: string;
  actualizada?: string;
  finalizada?: string;
  eliminada?: boolean;
  eliminadaEn?: string;
  modelo: string | null;
  esfuerzo: string | null;
}

export interface CreateSessionInput extends Partial<
  Pick<
    LauncherSession,
    | "equipoId"
    | "padreId"
    | "proyecto"
    | "encargo"
    | "modelo"
    | "esfuerzo"
    | "espacioId"
    | "harness"
    | "structured"
    | "directorio"
    | "role"
    | "responsibility"
    | "manifestSha256"
    | "toolProfileId"
    | "effectiveProfile"
    | "workspacePath"
    | "workspaceKind"
    | "enColaRecursos"
    | "motivoCola"
    | "enqueueOrder"
  >
> {
  id?: string | null;
  motor: string;
  origen: string;
  workOrderId?: string | null;
  memberId?: string | null;
  skillIds?: unknown[] | null;
  billingGrantVerified?: boolean;
}

export type SessionSnapshot = readonly Readonly<LauncherSession>[];
export type SessionObserver = (sessions: SessionSnapshot) => void;
export type SessionPruneHandler = (session: LauncherSession) => unknown;
export type SessionRegistry = Awaited<
  ReturnType<typeof import("./sesiones.mjs").abrirRegistro>
>;
