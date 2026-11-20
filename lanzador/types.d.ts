import type { ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import type { abrirEquipos } from "./equipos.mjs";
import type { abrirEspacios } from "./espacios.mjs";
import type { createToolCatalogStore } from "./catalogo-herramientas.mjs";
import type { crearSeguimiento } from "./checkpoints.mjs";
import type { comandoHarness, crearTerminal } from "./harness.mjs";
import type { comandoMotor } from "./motores.mjs";
import type { createProviderConversations } from "./provider-conversations.mjs";
import type { SessionRegistry } from "./session-types.d.ts";
import type { ManifestInput } from "./team-types.d.ts";
import type { ToolProfile } from "./tool-catalog-types.d.ts";
import type { ProviderAttachment } from "./lib/providers/shared.mjs";

export interface ExecutorOptions {
  registro: SessionRegistry;
  equipos?: Awaited<ReturnType<typeof abrirEquipos>> | null;
  proyectos: Record<string, string>;
  espacios?: Awaited<ReturnType<typeof abrirEspacios>> | null;
  env?: NodeJS.ProcessEnv;
  comando?: typeof comandoMotor;
  comandoInteractivo?: typeof comandoHarness;
  maxActivos?: number;
  lanzarPty?: typeof spawn;
  seguimiento?: ReturnType<typeof crearSeguimiento> | null;
  conversations?: ReturnType<typeof createProviderConversations> | null;
  toolCatalog?: Awaited<ReturnType<typeof createToolCatalogStore>> | null;
  consultarSaldo?: () => Promise<number>;
  limiteMs?: number;
  inactividadMs?: number;
  idleControllerMs?: number;
  programar?: typeof setTimeout;
  cancelarTemporizador?: typeof clearTimeout;
  registrar?: (line: string) => void;
}

export interface ExecutionContext {
  cwd: string;
  repositorio?: string | null;
  copiaId?: string | null;
}

export interface ExecutionRequest {
  id?: string | null;
  motor: string;
  origen: string;
  proyecto?: string | null;
  brief: string;
  modelo?: string | null;
  esfuerzo?: string | null;
  equipoId?: string | null;
  padreId?: string | null;
  espacioId?: string | null;
  harness?: boolean;
  structured?: boolean;
  contextoHeredado?: ExecutionContext | null;
  workOrderId?: string | null;
  memberId?: string | null;
  role?: string | null;
  responsibility?: string | null;
  manifest?: ManifestInput | null;
  manifestSha256?: string | null;
  requestId?: string | null;
  toolProfileId?: string | null;
  effectiveProfile?: ToolProfile | null;
  skillIds?: string[] | null;
  capabilityToken?: string | null;
  billingGrantVerified?: boolean;
  billingAuthorized?: boolean;
  enqueueIfFull?: boolean;
  isolateWorkspace?: boolean;
  attachments?: ProviderAttachment[];
}

export interface TurnOptions {
  attachments?: ProviderAttachment[];
  commandId?: string | null;
}

export interface ResourceQueueEntry extends TurnOptions {
  sesionId: string;
  brief: string;
  cwd: string;
}

export interface QueuedJob {
  promise: Promise<void>;
  resolve: () => void;
}

export interface ActiveJob {
  hijo: ChildProcess | null;
  promesa: Promise<unknown> | null;
  cancelada: boolean;
  cleanupFailed?: boolean;
  cola?: Promise<unknown>;
  detenerVigilante?: () => void;
  excedida?: boolean;
  inactiva?: boolean;
  nativo?: boolean;
  pendientes: number;
  tecleado?: string;
  ultimoTurno?: number;
}

export type MonitoredChild = ChildProcess & {
  stdout: Readable;
  stderr: Readable;
};

export type LiveTerminal = ReturnType<typeof crearTerminal> & {
  generacion: string;
};

export type TerminalEvent =
  | { tipo: "salida"; datos: string; seq: number }
  | { tipo: "tamano"; cols: number; rows: number };

export interface TerminalSnapshot {
  datos: string;
  cols: number;
  rows: number;
  seq: number;
}

export interface TerminalInput {
  raw?: string;
  texto?: string;
  cols?: number;
  rows?: number;
  controlador?: boolean;
  interrumpir?: boolean;
}
