import type { RoomSummary } from "./room-summary";
export interface Job {
  jobId?: string;
  estado: string;
  project?: string;
  fase?: string;
  actividad?: { zona: string; etiqueta: string };
}
export interface AgentState {
  id: string;
  ocupada: boolean;
  ultimo?: Job | null;
  personaje?: { zona: string };
}
export interface AgentsState {
  conectado: boolean;
  agentes: AgentState[];
}
export interface Flow {
  id: string;
  estado: string;
  indice: number;
  pasos: { agente: string; nombre: string; zona: string }[];
}
export interface Relay {
  id: string;
  tipo: string;
  de: string;
  para: string;
  texto: string;
}
export interface TeamState {
  flujos: Flow[];
  eventos: Relay[];
}
export interface SceneState {
  trabajando: boolean;
  atencion: boolean;
  esperando?: boolean;
  zona?: string;
  etiqueta: string;
  fase?: string;
  jobId?: string;
}
export interface RoomStats {
  calls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  pixelRatio: number;
  quality: string;
  frames: number;
}
export type ZoneId = keyof RoomSummary;
export interface DebugRoom {
  stats(): Partial<RoomStats> & {
    loaded: boolean;
    overlays: string[];
    blocked: boolean;
    destination: boolean;
    cursor: string;
    shadows: boolean;
  };
  positions(): Record<string, { x: number; z: number; moving: boolean }>;
  project(x: number, y: number, z: number): { x: number; y: number };
  walkTo(x: number, z: number): void;
  equipos(): {
    puestos: Record<
      string,
      { x: number; z: number; angle: number; mesa: string }
    >;
    hilos: string[];
    hilosVisibles: number;
    esperandoOk: string[];
    relevos: string[];
  };
  lastInput?: { code: string; blocked: boolean; nearby?: string };
}
declare global {
  interface Window {
    __refugio?: DebugRoom;
  }
}
