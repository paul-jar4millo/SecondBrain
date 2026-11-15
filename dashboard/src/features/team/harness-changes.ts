// Pure helpers for the "Cambios" tab: the checkpoints of a session, its capability
// flags and a light parser for the unified patch. No network and no React here.

export interface Checkpoint {
  n: number;
  commit?: string;
  ts: string;
  mensaje: string;
  /** "reversion" marks the safety checkpoint taken right before a revert. */
  tipo?: string;
  de?: number;
}

export interface Capabilities {
  esRepo: boolean;
  tieneRemoto: boolean;
  remotoGithub: boolean;
  continuar: boolean;
  interrumpir: boolean;
  teclaInterrumpir?: string;
  revertirArchivos: boolean;
  revertirConversacion: boolean;
  crearPr: boolean;
  redactarPr: boolean;
  herramientasEstructuradas: boolean | "parcial";
  reportaUso: boolean;
  reportaContexto: boolean;
  remoteControl: boolean;
}

export interface DiffFile {
  ruta: string;
  anterior?: string;
  estado: "A" | "M" | "D" | "R";
  añadidas: number;
  eliminadas: number;
  binario: boolean;
}

export interface DiffResult {
  archivos: DiffFile[];
  parche: string;
  recortado: boolean;
}

export interface Turn {
  n: number;
  mensaje: string;
  ts: string;
  /** Checkpoint before the turn, and the one after it (or the live tree). */
  desde: number;
  hasta: number | "actual";
}

/** One turn per checkpoint, except the safety ones created by a revert. */
export function turnsOf(checkpoints: Checkpoint[]): Turn[] {
  return checkpoints
    .map((c, i) => ({ c, next: checkpoints[i + 1] }))
    .filter(({ c }) => c.tipo !== "reversion")
    .map(({ c, next }) => ({
      n: c.n,
      mensaje: c.mensaje,
      ts: c.ts,
      desde: c.n,
      hasta: next ? next.n : "actual",
    }));
}

export function diffQuery(id: string, turn?: Turn) {
  const query = new URLSearchParams({ id });
  if (turn) {
    query.set("desde", String(turn.desde));
    query.set("hasta", String(turn.hasta));
  }
  return `/agentes/sesiones/diff?${query}`;
}

export type LineKind = "add" | "del" | "hunk" | "meta" | "ctx";

export function lineKind(line: string): LineKind {
  if (line.startsWith("@@")) return "hunk";
  if (
    line.startsWith("+++") ||
    line.startsWith("---") ||
    /^(diff --git|index |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(
      line,
    )
  )
    return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

export interface PatchFile {
  ruta: string;
  lines: string[];
}

/** Splits a unified patch into one block per file, in order. */
export function splitPatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (header) files.push({ ruta: header[1], lines: [line] });
    else files.at(-1)?.lines.push(line);
  }
  for (const file of files) while (file.lines.at(-1) === "") file.lines.pop();
  return files;
}

export const STATE_LABEL: Record<DiffFile["estado"], string> = {
  A: "Nuevo",
  M: "Modificado",
  D: "Eliminado",
  R: "Renombrado",
};

export const clock = (ts: string) => {
  const date = new Date(ts);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
};
