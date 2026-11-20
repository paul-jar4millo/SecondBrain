// Data package of the Mundo Hipotético panel (`/mundo/overview`), as the panel
// reads it. Field names come from the channel's files and stay as published.

export interface WorldVideo {
  id: string;
  title: string;
  status: string;
  date?: string;
  num?: number | string;
  poster?: string | null;
  duration?: number | null;
  metric?: { vistas: number } | null;
  /** One flag per stage in `WorldData.stages`: evidence present or not. */
  checks: boolean[];
  favorite?: boolean;
  scenes: { id: string; exists?: boolean }[];
  /** Next missing evidence. */
  stage: string;
  files: string[];
  modular?: boolean;
}

export interface WorldMetric {
  video: string;
  num: number | string;
  plantilla: string;
  vistas: number | null;
  edad_h: number | null;
  vistas_dia: number | null;
  pct_sigue_3s: number | null;
  pct_completo: number | null;
  comp_guard_x1000: number | null;
  oculto?: boolean;
}
export type SortableMetric =
  "vistas_dia" | "vistas" | "pct_completo" | "comp_guard_x1000";

export interface WorldSameAge {
  video: string;
  edad_h: number | null;
  vistas: number | null;
  vistas_hora: number;
  oculto?: boolean;
}

export interface WorldRetention {
  num: number | string;
  video: string;
  seg: number;
  pct: number;
  fecha_toma: string;
}

export interface WorldReading {
  grafica?: string;
  titulo: string;
  texto: string;
  accion: string;
  confianza: string;
}

export interface WorldHypothesis {
  id: string;
  hipotesis: string;
  estado: string;
  se_mide: string;
  a_favor: string;
  en_contra: string;
  estado_texto: string;
}

export interface WorldAgent {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  notes: string;
  source: string;
}

export interface WorldTask {
  id: string;
  agentId: string;
  videoId: string | null;
  instruction: string;
  status: string;
  createdAt: string;
  completionSource?: "manual";
}

export interface WorldBrief {
  id: string;
  title: string;
  brief: string;
  slug: string;
  createdAt: string;
}

export interface WorldIdea {
  title: string;
  num: number | string;
  source: string;
}

export interface WorldData {
  scannedAt: string;
  updated: string;
  stages: string[];
  videos: WorldVideo[];
  metrics: WorldMetric[];
  sameAge: WorldSameAge[];
  retention: WorldRetention[];
  interpretation: {
    actualizado: string;
    videos_con_analiticas: number;
    filas: WorldReading[];
  };
  hypotheses: WorldHypothesis[];
  agents: WorldAgent[];
  ideas: WorldIdea[];
  state: { tasks: WorldTask[]; briefs: WorldBrief[] };
}
