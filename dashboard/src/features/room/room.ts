import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  createThirdPersonCamera,
  followPlayer,
  resetCamera,
} from "./room-camera";
import {
  AGENT_SPECS,
  JUGADOR,
  MODEL_NAMES,
  cargarTodos,
  createCharacter,
} from "./room-characters.js";
import {
  createNavigation,
  activityFor,
  interactionPrompt,
  puestoPara,
  PUESTOS,
  normalizeOrder,
  ZONES,
  zoneGuide,
  tourInstructions,
} from "./room-life";
import { FONDO, dressWorld } from "./room-world.js";
import { characterState, etiquetaRoster } from "./team-panel";
import { cursorFor, pickTarget } from "./room-pick";
import { createOverlayStack } from "./room-overlays";
import { createWorldBoards } from "./room-boards";
import {
  sceneSessions,
  conciliarCopias,
  type CopiaObservada,
} from "./room-sessions";
import {
  sceneTeams,
  figurasEsperandoOk,
  teamSeats,
  newHandoffs,
  type ObservedApproval,
  type TeamSeat,
} from "./room-teams";
import { createThreads } from "./room-threads";
import {
  advanceTour,
  thumbAxis,
  observedCompletions,
  createRoomSound,
  waitingFlow,
} from "./room-controls";
import {
  QUALITY,
  QUALITY_LABELS,
  createFrameMeter,
  createLoadProgress,
  minFrameInterval,
  nextPixelRatio,
  qualityFor,
  shadowUpdateDue,
} from "./room-quality";

import type {
  AgentsState,
  AgentState,
  TeamState,
  Relay,
  SceneState,
  RoomStats,
  ZoneId,
} from "./room-types";
import type { Point } from "./room-life";
import type {
  TeamController,
  AgentTarget,
  TeamTarget,
  TeamEvent,
} from "../team/team-controller";
import type { RoomSummary } from "./room-summary";
type Spec = (typeof AGENT_SPECS)[number];
type Person = Awaited<ReturnType<typeof createCharacter>>;
interface Actor extends Person {
  route: Point[];
  speed: number;
  angle: number;
  phase: string;
  remaining: number;
  walking?: boolean;
  activity: ReturnType<typeof activityFor> & { angle?: number };
  leisureMode?: boolean;
  nombreTag?: THREE.Sprite;
  cueTag?: THREE.Sprite | null;
  okTag?: THREE.Sprite | null;
  celebrateUntil: number;
  liveKey?: string;
  cueText?: string;
  props: Record<string, THREE.Object3D>;
}
type SavedOrder = ReturnType<typeof normalizeOrder>;
interface RoomData {
  encargos?: Record<string, SavedOrder>;
}
interface RoomOptions {
  api: (path: string, body?: unknown) => Promise<unknown>;
  toast: (message: string) => void;
  team: TeamController;
  openAgent: (target: AgentTarget) => void;
  openTeam: (target?: TeamTarget) => void;
  irAEspacio?: (path: string) => void;
  datos?: () => RoomSummary;
  /** Pending approvals of the service; the same list the approval panel reads. */
  aprobaciones?: () => Promise<unknown>;
}
const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (paths: string, transform = "") =>
  `<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><g transform="${transform}">${paths}</g></svg>`;
const ICONS = {
  rotateLeft: icon('<path d="M3 9h5M3 9V4M3.5 9a8 8 0 1 1 .8 8"/>'),
  rotateRight: icon(
    '<path d="M3 9h5M3 9V4M3.5 9a8 8 0 1 1 .8 8"/>',
    "translate(24 0) scale(-1 1)",
  ),
  close: icon('<path d="m6 6 12 12M18 6 6 18"/>'),
  plus: icon('<path d="M12 5v14M5 12h14"/>'),
  minus: icon('<path d="M5 12h14"/>'),
  chevron: icon('<path d="m9 6 6 6-6 6"/>'),
};
// Same breakpoint as the compact HUD in room.css: phones in both orientations.
const COMPACT_QUERY = "(max-width: 700px), (max-height: 500px)";
const QUALITY_KEY = "sb-refugio-calidad";
const CORAL = "#ff6f61";

function label(text: string, color = "#f1f7ff", zone = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = zone ? '46px "Dela Gothic One"' : "600 44px Fredoka, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = Math.min(470, ctx.measureText(text).width + 64),
    x = 256 - w / 2,
    slant = 18;
  const shard = (dx: number, dy: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x + slant + dx, 20 + dy);
    ctx.lineTo(x + w + dx, 14 + dy);
    ctx.lineTo(x + w - slant + dx, 98 + dy);
    ctx.lineTo(x + dx, 104 + dy);
    ctx.closePath();
    ctx.fill();
  };
  shard(7, 8, zone ? "#2f66e6" : color);
  shard(0, 0, "#0f1a55");
  ctx.fillStyle = zone ? "#f1f7ff" : color;
  ctx.fillText(text, 256, 60, w - 44);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    }),
  );
  sprite.scale.set(zone ? 4.4 : 2.7, zone ? 1.1 : 0.675, 1);
  sprite.renderOrder = 5;
  return sprite;
}

// "a la Terraza", "al Café".
const toPlace = (zone: { place: string } = ZONES[0]) =>
  zone.place.startsWith("el ")
    ? `al ${zone.place.slice(3)}`
    : `a ${zone.place}`;

// Same 32 x 24 plan as the painted floor, so the minimap reads as the place itself.
const MAP_ART = `<svg class="map-art" viewBox="-16 -12 32 24" aria-hidden="true"><rect x="-16" y="-12" width="32" height="24" fill="#cfe6ff"/><rect x="-16" y="-12" width="11" height="13" fill="#1e2f85"/><rect x="-16" y="1" width="11" height="11" fill="#131d5e"/><rect x="-5" y="-12" width="10" height="8.5" fill="#f1f7ff"/><rect x="5" y="-12" width="11" height="11.5" fill="#0e6f92"/><rect x="8" y="-12" width="4" height="11.5" fill="#bfe6f2"/><circle cx="0" cy="4" r="7" fill="#2340c8"/><circle cx="0" cy="4" r="4.6" fill="#1a2a78"/><circle cx="0" cy="4" r="1.7" fill="#e7f0ff"/><circle cx="-9" cy="6" r="4" fill="#0a1238"/><circle cx="-9" cy="6" r="1.3" fill="#2f66e6"/><circle cx="12" cy="4" r="2.8" fill="#3f8ff0"/><rect x="-16" y="-12" width="32" height="24" fill="none" stroke="#f1f7ff" stroke-width=".5"/></svg>`;

const CANVAS_LABEL =
  "Refugio 3D. Clic o toque en el suelo para caminar; WASD o flechas; E para interactuar; Esc cierra el panel abierto; rueda para zoom; arrastra con el botón derecho para girar.";

function readSavedQuality() {
  try {
    return localStorage.getItem(QUALITY_KEY) || "auto";
  } catch {
    return "auto";
  }
}

export function montar(
  root: HTMLElement,
  {
    api,
    toast,
    team,
    openAgent: showAgent,
    openTeam: showTeam,
    irAEspacio = () => {},
    datos,
    aprobaciones: aprobar,
  }: RoomOptions,
) {
  // HTTP input is validated by the server; keep transport decoding at one boundary.
  const requestData = async <T>(path: string, body?: unknown): Promise<T> =>
    (await api(path, body)) as T;
  let alive = true,
    frame = 0,
    orders: Record<string, ReturnType<typeof normalizeOrder>> = {},
    actors: Actor[] = [],
    player: Actor | null = null;
  const activities = new Map<string, string>(),
    cycles = new Map<string, number>();
  const compactQuery = matchMedia(COMPACT_QUERY);
  const coarse = matchMedia("(pointer: coarse)").matches;
  const frameBudget = minFrameInterval(coarse);
  let pausedLoop: ReturnType<typeof setTimeout> | undefined;
  let compact = compactQuery.matches;
  // Last input device decides the prompt wording: "E ·" or "Tocar ·".
  let device = coarse ? "touch" : "keyboard";
  let savedQuality = readSavedQuality();
  const stored = (key: string, fallback: string) => {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const save = (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Session-only when storage is unavailable. */
    }
  };
  let tourStep = stored("sb-room-tour-v1", "") === "done" ? 3 : 0;
  const sound = createRoomSound(Number(stored("sb-room-volume", "0")));
  const detectQuality = (saved: string) =>
    qualityFor({
      coarse,
      cores: navigator.hardwareConcurrency,
      memory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      saved,
    });
  let quality = detectQuality(savedQuality);
  const debug = new URLSearchParams(location.search).has("debug");
  AGENT_SPECS.forEach((a) => {
    cycles.set(a.id, 0);
  });
  root.classList.toggle("is-compact", compact);
  root.innerHTML = `<canvas tabindex="0" aria-label="${CANVAS_LABEL}"></canvas>
    <button class="room-help-trigger" id="room-help-button" aria-expanded="false" aria-controls="room-help">Ayuda</button><div class="room-location"><h1 id="room-zone">Terraza</h1></div>
    <div class="room-clock"><svg class="moon-dial" viewBox="0 0 64 64" aria-hidden="true"><circle class="dial-track" cx="32" cy="32" r="26"/><g id="room-orbit"><path class="dial-moon" d="M32 0a6.4 6.4 0 1 0 5.3 10 5 5 0 1 1-5.3-10z"/></g><path class="dial-gem" d="M32 20 42 32 32 44 22 32z"/><path class="dial-gem-lit" d="M32 20 42 32H22z"/></svg><span><b id="room-time"></b><small id="room-date"></small></span></div>
    <div class="room-loading"><p id="room-loading-text" role="status">Preparando el refugio…</p><div class="room-progress"><progress id="room-progress" max="100" value="0" aria-label="Carga del refugio"></progress><span id="room-progress-value" aria-hidden="true">0 %</span></div><button type="button" id="room-retry" hidden>Reintentar</button></div>
    <div class="room-side">
      <div class="team-shortcuts"><button class="team-toggle" aria-haspopup="dialog">Equipo <span>4</span></button><button class="team-collapse" aria-label="${compact ? "Mostrar personajes" : "Ocultar personajes"}" aria-expanded="${!compact}" aria-controls="room-team">${ICONS.chevron}</button></div>
      <aside class="room-team ${compact ? "collapsed" : ""}" id="room-team" aria-label="Cuatro agentes base">
        <h2 class="team-heading">Tu equipo</h2>
        <div id="room-roster"></div>
        <p id="team-handoff" class="team-handoff" hidden></p>
      </aside>
      <div class="room-camera" role="group" aria-label="Cámara"><button data-camera="out" aria-label="Alejar cámara">${ICONS.minus}</button><button data-camera="in" aria-label="Acercar cámara">${ICONS.plus}</button><button data-camera="left" aria-label="Girar a la izquierda">${ICONS.rotateLeft}</button><button data-camera="right" aria-label="Girar a la derecha">${ICONS.rotateRight}</button><button data-camera="home" aria-label="Centrar cámara en ti">Centrar</button></div>
    </div>

    <div class="room-map"><div class="map-title"><b>Mapa del refugio</b><button id="map-toggle" aria-expanded="${!compact}" aria-controls="map-body">${compact ? "Mostrar" : "Ocultar"}</button></div><div id="map-body" ${compact ? "hidden" : ""}><div class="map-stage"><div class="map-zones" id="map-zones">${MAP_ART}${ZONES.map((z) => `<button data-zone="${z.id}" style="left:${((z.x + 16) / 32) * 100}%;top:${((z.z + 12) / 24) * 100}%" title="Ir ${toPlace(z)} · ${esc(z.toolName)}"><span>${esc(z.name)}</span></button>`).join("")}<i class="map-player" aria-label="Tu posición"></i></div></div></div></div>
    <div class="equipo-replay" hidden><p id="team-replay-status" role="status"></p><button id="team-replay-stop">Volver a flujos</button></div>
    <div class="room-help" id="room-help" role="dialog" aria-labelledby="room-help-title" hidden><b id="room-help-title">Muévete a tu ritmo</b><p>Clic o toque en el suelo, o <kbd>WASD</kbd> / flechas, para caminar. Si el punto está ocupado, vas al lugar libre más cercano.</p><p>Cerca de una agente, <kbd>E</kbd> o el aviso inferior abre su ficha. Cada zona abre su herramienta: ${esc(zoneGuide())}. También están en el HUD inferior.</p><p>Rueda o + / − para zoom. Arrastra con el botón derecho para girar. En pantalla táctil, dos dedos para zoom y giro.</p><p><kbd>Esc</kbd> cierra el panel abierto. <kbd>Ctrl K</kbd> busca y <kbd>N</kbd> crea.</p><label class="room-quality" for="room-quality">Calidad gráfica<select id="room-quality">${["auto", "alta", "media", "baja"].map((v) => `<option value="${v}" ${v === savedQuality ? "selected" : ""}>${QUALITY_LABELS[v as keyof typeof QUALITY_LABELS]}</option>`).join("")}</select></label><p class="room-quality-note" id="room-quality-note"></p><label class="room-volume" for="room-volume">Sonido del refugio <input id="room-volume" type="range" min="0" max="100" step="5" value="${Number(stored("sb-room-volume", "0")) * 100}"></label><p>Empieza silenciado. El control Mover permite caminar en pantalla táctil. El mapa muestra las cuatro agentes y tu destino.</p><button id="room-guide-restart">Repetir primer paseo</button><button id="room-help-close">Entendido</button></div>
    <button class="room-interact" id="room-interact" hidden><strong id="room-quick-title"></strong><span id="room-quick-lines"></span><span id="room-quick-action"></span></button>
    <aside class="room-guide" id="room-guide" hidden aria-label="Primer paseo"><p id="room-guide-text" role="status"></p><button id="room-guide-skip">Saltar guía</button></aside>
    <div class="room-joystick" id="room-joystick" role="group" aria-label="Movimiento táctil"><span>Mover</span><i aria-hidden="true"></i></div>
    <p class="room-completion" id="room-completion" role="status" hidden></p>`;
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) =>
    root.querySelector<T>(selector)!;
  function paintTour() {
    q("#room-guide").hidden = tourStep >= 3;
    q("#room-guide-text").textContent =
      tourInstructions(coarse)[tourStep] || "";
  }
  const teach = (event: string) => {
    const next = advanceTour(tourStep, event);
    if (next === tourStep) return;
    tourStep = next;
    if (tourStep === 3) save("sb-room-tour-v1", "done");
    paintTour();
  };
  const openTool = (path: string) => {
    teach("open");
    sound.play("open");
    irAEspacio(path);
  };
  let canvas = q<HTMLCanvasElement>("canvas");
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let controls: OrbitControls | null = null;
  let sun: THREE.DirectionalLight;
  let nav: ReturnType<typeof createNavigation> | null = null;
  let mapObject: THREE.Object3D | null = null;
  let observer: ResizeObserver | null = null;
  let destination: THREE.Mesh<
    THREE.RingGeometry,
    THREE.MeshBasicMaterial
  > | null = null;
  let blocked: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null =
    null;
  let world: ReturnType<typeof dressWorld> | null = null;
  let worldBoards: ReturnType<typeof createWorldBoards> | null = null;
  let summary = datos?.();
  const updateRoomData = (event: Event) => {
    summary = (event as CustomEvent<RoomSummary>).detail;
    worldBoards?.update(summary);
    // Purge money from the retained canvas immediately, even under a paused tool.
    if (loaded && renderer) renderer.render(scene, camera);
    paintPrompt();
  };
  root.addEventListener("room-data", updateRoomData);
  let loaded = false,
    contextLost = false,
    startAttempt = 0,
    pixelRatio = 1,
    stats: RoomStats | null = null;
  let realState: AgentsState | null = null;
  let copiasDeseadas: CopiaObservada[] = [];
  let crearActor:
    ((spec: Spec, x: number, z: number) => Promise<Actor | null>) | null = null;
  const copiasEnCreacion = new Set<string>();
  // Teams: seats around a table, light threads, real handoffs and pending OKs.
  let puestosEq = new Map<string, TeamSeat>();
  let esperandoOk = new Set<string>();
  let aprobacionesVivas: ObservedApproval[] = [];
  let leyendoAprobaciones = false,
    ultimaLecturaAprobaciones = 0;
  const relevosVistos = new Set<string>();
  let relevosIniciados = false;
  let hilos: ReturnType<typeof createThreads> | null = null;
  let hilosDeseados: { de: string; a: string }[] = [];
  let teamState: TeamState = { flujos: [], eventos: [] };
  const labels: THREE.Sprite[] = [];
  const overlays = createOverlayStack({
    onChange: (list) => {
      // Lets the HUD make room (e.g. hide the minimap behind a side panel).
      root.dataset.overlays = list.join(" ");
    },
  });

  function sceneState(a: AgentState): SceneState {
    const state = characterState(a);
    const flow = waitingFlow(teamState.flujos, a.id);
    if (!a.ocupada && flow) {
      const s = flow.pasos[flow.indice];
      return {
        ...state,
        atencion: false,
        esperando: true,
        zona: s.zona,
        fase: s.nombre,
        etiqueta: `Lista para ${s.nombre.toLocaleLowerCase("es")} · ${flow.estado === "esperando" ? "tu clic" : "en cola"}`,
        jobId: flow.id,
      };
    }
    return state;
  }
  const liveAgent = (id: string) => realState?.agentes.find((a) => a.id === id);
  // Roster text: real work, waits and failures win; otherwise what the scene shows.
  const statusText = (id: string) => {
    if (esperandoOk.has(id)) return "Esperando tu OK";
    const live = liveAgent(id);
    return (
      etiquetaRoster(
        live ? sceneState(live) : null,
        activities.get(id) || "",
      ) || "En descanso"
    );
  };
  const paintStatus = (id: string) => {
    const text = statusText(id);
    const node = q(`[data-status="${id}"]`);
    if (node && node.textContent !== text) node.textContent = text;
  };
  const setActivity = (id: string, text: string) => {
    activities.set(id, text);
    paintStatus(id);
  };

  let relayInitialized = false;
  const observedRelays = new Set();
  function playRelay(e: Relay | null, replay = false) {
    if (!e) {
      world?.detenerRelevo();
      return;
    }
    const from = actors.find((a) => a.spec.id === e.de);
    const to = actors.find((a) => a.spec.id === e.para);
    if (from && to) world?.relevo(from.raiz, to.raiz);
    q("#team-handoff").hidden = false;
    q("#team-handoff").textContent =
      `${replay ? "Repetición del relevo" : "Relevo programado"}: ${e.texto}`;
  }
  function dropCue(actor: Actor) {
    if (!actor.cueTag) return;
    actor.raiz.remove(actor.cueTag);
    actor.cueTag.material.map?.dispose();
    actor.cueTag.material.dispose();
    actor.cueTag = null;
  }
  function dropOk(actor: Actor) {
    if (!actor.okTag) return;
    actor.raiz.remove(actor.okTag);
    actor.okTag.material.map?.dispose();
    actor.okTag.material.dispose();
    actor.okTag = null;
  }
  // «Esperando tu OK» hovers over the figure until the approval is decided or expires.
  function syncOk() {
    for (const actor of actors) {
      const wants = esperandoOk.has(actor.spec.id);
      if (wants && !actor.okTag) {
        actor.okTag = label("Esperando tu OK", CORAL);
        actor.okTag.position.y = 3.55;
        actor.okTag.scale.set(3.2, 0.8, 1);
        actor.okTag.name = "espera-ok";
        actor.raiz.add(actor.okTag);
      } else if (!wants) dropOk(actor);
    }
    AGENT_SPECS.forEach((a) => paintStatus(a.id));
  }
  function syncAgents(d: AgentsState, e = teamState) {
    if (!alive) return;
    const finished = observedCompletions(realState, d);
    for (const id of finished) {
      const actor = actors.find((a) => a.spec.id === id);
      if (actor && !reducedMotion)
        actor.celebrateUntil = performance.now() + 1800;
      q("#room-completion").textContent =
        `${AGENT_SPECS.find((a) => a.id === id)?.nombre || id} terminó su encargo`;
      q("#room-completion").hidden = false;
      completionUntil = performance.now() + 5000;
      sound.play("complete");
    }
    teamState = e;
    realState = d.conectado ? d : null;
    const relay = e.eventos.filter((x) => x.tipo === "relevo").at(-1);
    q("#team-handoff").hidden = !relay;
    if (relay)
      q("#team-handoff").textContent = `Relevo programado: ${relay.texto}`;
    for (const event of e.eventos.filter((x) => x.tipo === "relevo")) {
      if (relayInitialized && !observedRelays.has(event.id)) playRelay(event);
      observedRelays.add(event.id);
    }
    relayInitialized = true;
    for (const actor of actors) {
      const a = liveAgent(actor.spec.id);
      const state = a && sceneState(a);
      const seat = puestosEq.get(actor.spec.id);
      const key = JSON.stringify([state, seat?.x, seat?.z]);
      if (key !== actor.liveKey) {
        actor.liveKey = key;
        assignActor(actor.spec.id);
      }
      if (state?.etiqueta !== actor.cueText) {
        actor.cueText = state?.etiqueta;
        dropCue(actor);
        // Work, a wait for the owner's click or a failure is shown over her head.
        if (a?.ocupada || state?.esperando || state?.atencion) {
          actor.cueTag = label(
            state!.etiqueta,
            state!.atencion ? CORAL : actor.spec.color,
          );
          actor.cueTag.position.y = 2.8;
          actor.cueTag.scale.set(3.7, 0.65, 1);
          actor.raiz.add(actor.cueTag);
        }
      }
    }
    syncOk();
    for (const tag of labels) {
      if (!tag.userData.phase) continue;
      tag.visible = !!realState?.agentes.some((a) => {
        const state = sceneState(a);
        return (
          (state.trabajando || state.esperando || state.atencion) &&
          state.fase?.toLocaleLowerCase("es") === tag.userData.phase
        );
      });
    }
  }
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let completionUntil = 0;
  const modalOpen = () => !!document.querySelector("dialog[open]");
  const inputActive = () =>
    modalOpen() ||
    ["INPUT", "SELECT", "TEXTAREA"].includes(
      document.activeElement?.tagName || "",
    ) ||
    (document.activeElement as HTMLElement | null)?.isContentEditable ||
    false;
  const paintRoster = () => {
    q("#room-roster").innerHTML = AGENT_SPECS.map(
      (a) =>
        `<button class="team-agent" data-agent="${a.id}" aria-haspopup="dialog" style="--agent-color:${a.color}"><span class="agent-initial">${esc(a.nombre[0])}</span><span><b>${esc(a.nombre)}</b><small data-status="${a.id}">${esc(statusText(a.id))}</small></span><span class="agent-chevron" aria-hidden="true">${ICONS.chevron}</span></button>`,
    ).join("");
  };
  function openAgent(id: string, _from = "world") {
    const base = id.split("#")[0];
    const live = liveAgent(id) || liveAgent(base);
    showAgent({
      agentId: base,
      projectId: orders[base]?.project || live?.ultimo?.project,
      chatId: live?.ultimo?.jobId,
    });
  }
  function toggleHelp() {
    if (overlays.has("help")) {
      overlays.close("help");
      return;
    }
    q("#room-help").hidden = false;
    paintQualityNote();
    overlays.open("help", {
      close: () => (q("#room-help").hidden = true),
      returnFocus: () => q("#room-help-button"),
      fallbackFocus: () => canvas,
      controls: () => [q("#room-help-button")],
    });
    q("#room-help-close").focus({ preventScroll: true });
  }
  function setTeam(open: boolean) {
    q(".room-team").classList.toggle("collapsed", !open);
    q(".team-collapse").setAttribute("aria-expanded", String(open));
    q(".team-collapse").setAttribute(
      "aria-label",
      open ? "Ocultar personajes" : "Mostrar personajes",
    );
  }
  function setMap(open: boolean) {
    q("#map-body").hidden = !open;
    q("#map-toggle").textContent = open ? "Ocultar" : "Mostrar";
    q("#map-toggle").setAttribute("aria-expanded", String(open));
  }
  // Phones start with team and map folded; rotating or resizing re-applies it.
  const compactChange = (e: MediaQueryListEvent) => {
    compact = e.matches;
    root.classList.toggle("is-compact", compact);
    setTeam(!compact);
    setMap(!compact);
  };
  compactQuery.addEventListener("change", compactChange);
  const move = (actor: Actor | null, point: Point) => {
    if (!actor || !nav) return;
    if (actor && nav) actor.route = nav.route(actor.raiz.position, point);
  };
  function assignActor(id: string) {
    const actor = actors.find((a) => a.spec.id === id);
    if (!actor) return;
    const live = liveAgent(id);
    const leisure = !live?.ocupada;
    const state = live ? sceneState(live) : null;
    // Work, a pending click and a failure keep her at her desk instead of leisure.
    const cue =
      state?.trabajando || state?.esperando || state?.atencion ? state : null;
    let activity: ReturnType<typeof activityFor> & { angle?: number } =
      activityFor(
        id,
        cue
          ? {
              mode: "work",
              project: live?.ultimo?.project,
              instruction: ZONES.find((z) => z.id === cue.zona)?.name || "",
            }
          : leisure
            ? { mode: "rest" }
            : orders[id],
        cycles.get(id),
      );
    if (cue) {
      const puesto = puestoPara(id, {
        fase: cue.fase || live?.ultimo?.fase,
        zona: cue.zona,
      });
      const copia = Number(id.split("#")[1] || 0);
      if (copia) puesto.x += copia * 0.65;
      activity = { ...activity, ...puesto, label: cue.etiqueta };
      // A team sits together around one table, facing it.
      const seat = puestosEq.get(id);
      if (seat)
        activity = { ...activity, x: seat.x, z: seat.z, angle: seat.angle };
    }
    actor.activity = activity;
    actor.leisureMode = cue ? false : leisure || orders[id]?.mode !== "work";
    actor.remaining = 7;
    actor.phase = "going";
    move(actor, activity);
    setActivity(
      id,
      `Yendo ${toPlace(ZONES.find((z) => z.id === activity.zone))}`,
    );
  }
  const updateClock = () => {
    const now = new Date();
    q("#room-time").textContent = now.toLocaleTimeString("es-MX", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/Mexico_City",
    });
    const [hour, minute] = q("#room-time").textContent.split(":").map(Number);
    q("#room-orbit").style.transform =
      `rotate(${((hour * 60 + minute) / 1440) * 360}deg)`;
    q("#room-date").textContent = now.toLocaleDateString("es-MX", {
      day: "numeric",
      month: "short",
      timeZone: "America/Mexico_City",
    });
  };
  updateClock();
  const clock = setInterval(updateClock, 30000);
  paintRoster();
  const click = async (e: MouseEvent) => {
    if (
      (e.target as HTMLElement).closest<HTMLButtonElement>("#room-guide-skip")
    ) {
      tourStep = 3;
      save("sb-room-tour-v1", "done");
      paintTour();
      canvas.focus();
    }
    if (
      (e.target as HTMLElement).closest<HTMLButtonElement>(
        "#room-guide-restart",
      )
    ) {
      tourStep = 0;
      save("sb-room-tour-v1", "");
      paintTour();
      overlays.close("help");
    }
    const agent = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-agent]",
    );
    if (agent) openAgent(agent.dataset.agent!, "roster");
    if ((e.target as HTMLElement).closest<HTMLButtonElement>(".team-toggle"))
      showTeam({ tab: "vivo" });
    if ((e.target as HTMLElement).closest<HTMLButtonElement>(".team-collapse"))
      setTeam(q(".room-team").classList.contains("collapsed"));
    if ((e.target as HTMLElement).closest<HTMLButtonElement>("#map-toggle"))
      setMap(q("#map-body").hidden);
    if (
      (e.target as HTMLElement).closest<HTMLButtonElement>(
        "#room-help-button",
      ) ||
      (e.target as HTMLElement).closest<HTMLButtonElement>("#room-help-close")
    )
      toggleHelp();
    if ((e.target as HTMLElement).closest<HTMLButtonElement>("#room-retry"))
      restart();
    const zone = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-zone]",
    );
    if (zone) {
      sound.play("move");
      move(player, ZONES.find((z) => z.id === zone.dataset.zone) || ZONES[0]);
      canvas.focus();
    }
    const cam = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-camera]",
    );
    if (cam && controls) {
      const action = cam.dataset.camera;
      if (action === "in" || action === "out") {
        const offset = camera.position.clone().sub(controls.target);
        offset.setLength(
          THREE.MathUtils.clamp(
            offset.length() * (action === "in" ? 1 / 1.2 : 1.2),
            controls.minDistance,
            controls.maxDistance,
          ),
        );
        camera.position.copy(controls.target).add(offset);
      }
      if (action === "left" || action === "right") {
        const offset = camera.position
          .clone()
          .sub(controls.target)
          .applyAxisAngle(
            new THREE.Vector3(0, 1, 0),
            action === "left" ? 0.35 : -0.35,
          );
        camera.position.copy(controls.target).add(offset);
      }
      if (action === "home" && player) {
        resetCamera(camera, controls.target, player.raiz.position);
      }
      controls.update();
    }
    if ((e.target as HTMLElement).closest<HTMLButtonElement>("#room-interact"))
      interact();
  };
  const change = (e: Event) => {
    if ((e.target as HTMLElement).id === "room-volume") {
      sound.volume(Number((e.target as HTMLInputElement).value) / 100);
      save(
        "sb-room-volume",
        String(Number((e.target as HTMLInputElement).value) / 100),
      );
      sound.play("open");
    }
    if ((e.target as HTMLElement).id === "room-quality") {
      savedQuality = (e.target as HTMLInputElement).value;
      try {
        localStorage.setItem(QUALITY_KEY, savedQuality);
      } catch {
        /* Private mode: the choice lasts for this visit. */
      }
      quality = detectQuality(savedQuality);
      applyQuality();
      paintQualityNote();
    }
  };
  function paintQualityNote() {
    const note = q("#room-quality-note");
    const shadows = QUALITY[quality].shadowMap ? "con sombras" : "sin sombras";
    note.textContent = `${savedQuality === "auto" ? `Elegida para este equipo: ${QUALITY_LABELS[quality].toLocaleLowerCase("es")}` : QUALITY_LABELS[quality]}, ${shadows}. Si el mundo va lento, la resolución baja sola.`;
  }
  root.addEventListener("click", click);
  root.addEventListener("change", change);
  const setDevice = (next: string) => {
    if (next === device) return;
    device = next;
    paintPrompt();
  };
  const pointerKind = (e: PointerEvent) =>
    setDevice(e.pointerType === "mouse" ? "keyboard" : "touch");
  root.addEventListener("pointerdown", pointerKind, true);
  const keys = new Set();
  let stick = { x: 0, y: 0 },
    stickPointer: number | null = null;
  const joystick = q("#room-joystick");
  function resetStick() {
    if (stickPointer !== null && joystick.hasPointerCapture(stickPointer))
      joystick.releasePointerCapture(stickPointer);
    stickPointer = null;
    stick = { x: 0, y: 0 };
    joystick.style.setProperty("--stick-x", "0px");
    joystick.style.setProperty("--stick-y", "0px");
  }
  const stickMove = (e: PointerEvent) => {
    if (e.pointerId !== stickPointer) return;
    const rect = joystick.getBoundingClientRect();
    stick = thumbAxis(
      e.clientX - rect.x - rect.width / 2,
      e.clientY - rect.y - rect.height / 2,
      rect.width * 0.36,
    );
    joystick.style.setProperty("--stick-x", `${stick.x * 30}px`);
    joystick.style.setProperty("--stick-y", `${stick.y * 30}px`);
  };
  const stickDown = (e: PointerEvent) => {
    if (stickPointer !== null || inputActive() || overlays.list().length)
      return;
    e.preventDefault();
    stickPointer = e.pointerId;
    joystick.setPointerCapture(e.pointerId);
    if (player) player.route = [];
    stickMove(e);
  };
  const stickEnd = (e: PointerEvent) => {
    if (e.pointerId === stickPointer) resetStick();
  };
  joystick.addEventListener("pointerdown", stickDown);
  joystick.addEventListener("pointermove", stickMove);
  joystick.addEventListener("pointerup", stickEnd);
  joystick.addEventListener("pointercancel", stickEnd);
  joystick.addEventListener("lostpointercapture", stickEnd);
  const visibility = () => {
    if (document.hidden) blur();
  };
  document.addEventListener("visibilitychange", visibility);
  q("#map-zones").insertAdjacentHTML(
    "beforeend",
    AGENT_SPECS.map(
      (a) =>
        `<i class="map-agent" data-map-agent="${a.id}" style="--agent-color:${a.color}" role="img" aria-label="${esc(a.nombre)}"></i>`,
    ).join("") +
      '<i class="map-destination" aria-label="Tu destino" hidden></i>',
  );
  const keydown = (e: KeyboardEvent) => {
    if (debug && window.__refugio)
      window.__refugio.lastInput = {
        code: e.code,
        blocked: inputActive(),
        nearby: nearby && ("spec" in nearby ? nearby.spec.id : nearby.id),
      };
    // Escape works from any field: it closes the top panel, not the tool dialogs,
    // which handle their own Escape.
    if (e.key === "Escape") {
      if (e.isComposing || modalOpen()) return;
      if (overlays.closeTop()) e.preventDefault();
      return;
    }
    if (!["Shift", "Control", "Alt", "Meta"].includes(e.key))
      setDevice("keyboard");
    if (inputActive()) return;
    if (/^(Key[WASD]|Arrow(Up|Down|Left|Right))$/.test(e.code)) {
      e.preventDefault();
      keys.add(e.code);
      if (player) player.route = [];
    }
    if (e.code === "KeyE") {
      e.preventDefault();
      interact();
    }
  };
  const keyup = (e: KeyboardEvent) => keys.delete(e.code),
    blur = () => {
      keys.clear();
      resetStick();
    };
  addEventListener("keydown", keydown);
  addEventListener("keyup", keyup);
  addEventListener("blur", blur);
  let nearby: Actor | (typeof ZONES)[number] | undefined;
  function paintPrompt() {
    const button = q("#room-interact");
    button.hidden = !nearby;
    if (!nearby) return;
    const value = "spec" in nearby ? null : summary?.[nearby.id as ZoneId];
    if (value) teach("zone");
    const write = (selector: string, text: string) => {
      const node = q(selector);
      if (node.textContent !== text) node.textContent = text;
    };
    write("#room-quick-title", value?.headline || "");
    write("#room-quick-lines", value?.lines.join(" · ") || "");
    write("#room-quick-action", interactionPrompt(nearby, device));
  }
  function interact() {
    if (!nearby) return;
    if ("spec" in nearby) openAgent(nearby.spec.id, "world");
    else openTool(nearby.tool);
  }
  const loadRoomData = () =>
    requestData<RoomData>("/sala?espacio=general")
      .then((data) => {
        if (!alive) return;
        orders = data.encargos || {};
      })
      .catch((e) => {
        if (alive) toast(`No se pudo leer la sala: ${e.message}`);
      });

  // Pointer: pick what is drawn, walk to the closest free spot, refuse the sea.
  const rays = new THREE.Raycaster(),
    mouse = new THREE.Vector2(),
    plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
    floorPoint = new THREE.Vector3();
  let pointerStart: { x: number; y: number; button: number } | null = null;
  const hover = { x: 0, y: 0, pending: false };
  function aim(clientX: number, clientY: number) {
    const rect = canvas.getBoundingClientRect();
    mouse.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      (-(clientY - rect.top) / rect.height) * 2 + 1,
    );
    rays.setFromCamera(mouse, camera);
  }
  function floorUnderRay() {
    if (!nav) return null;
    if (!rays.ray.intersectPlane(plane, floorPoint)) return null;
    return {
      point: floorPoint,
      spot: nav.nearestFree({ x: floorPoint.x, z: floorPoint.z }, 2.5),
    };
  }
  function pointerDown(e: PointerEvent) {
    pointerStart = { x: e.clientX, y: e.clientY, button: e.button };
  }
  function pointerUp(e: PointerEvent) {
    if (!player || !destination || !blocked) return;
    const start = pointerStart;
    pointerStart = null;
    if (
      !loaded ||
      inputActive() ||
      !start ||
      start.button !== 0 ||
      Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8
    )
      return;
    aim(e.clientX, e.clientY);
    const target = pickTarget(rays, { actors, labels });
    if (target?.kind === "agent") {
      openAgent(target.id, "world");
      return;
    }
    if (target?.kind === "tool") {
      openTool(target.tool);
      return;
    }
    const floor = floorUnderRay();
    if (!floor) return;
    if (floor.spot) {
      sound.play("move");
      move(player, floor.spot);
      destination.position.set(floor.spot.x, 0.025, floor.spot.z);
      destination.visible = true;
      canvas.focus();
    } else {
      // Nothing walkable nearby (the sea): a short coral pulse where the click landed.
      blocked.position.set(floor.point.x, 0.03, floor.point.z);
      blocked.userData.life = 0.7;
      blocked.visible = true;
    }
  }
  function pointerMove(e: PointerEvent) {
    if (e.pointerType !== "mouse" || e.buttons) return;
    hover.x = e.clientX;
    hover.y = e.clientY;
    hover.pending = true;
  }
  function updateCursor() {
    if (!hover.pending) return;
    hover.pending = false;
    aim(hover.x, hover.y);
    const target = pickTarget(rays, { actors, labels });
    let cursor;
    if (target) cursor = cursorFor(target);
    else {
      const floor = floorUnderRay();
      cursor = cursorFor(
        floor ? { kind: "floor", reachable: !!floor.spot } : null,
      );
    }
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
  }
  function contextLostHandler(e: Event) {
    e.preventDefault();
    contextLost = true;
    showStatus(
      "El navegador pausó el mundo 3D para liberar la tarjeta gráfica. Recuperando…",
      { retry: true },
    );
  }
  function contextRestored() {
    contextLost = false;
    if (renderer) renderer.shadowMap.needsUpdate = true;
    hideStatus();
  }
  function bindCanvas(node: HTMLCanvasElement) {
    node.addEventListener("pointerdown", pointerDown);
    node.addEventListener("pointerup", pointerUp);
    node.addEventListener("pointermove", pointerMove);
    node.addEventListener("webglcontextlost", contextLostHandler);
    node.addEventListener("webglcontextrestored", contextRestored);
  }
  function unbindCanvas(node: HTMLCanvasElement) {
    node.removeEventListener("pointerdown", pointerDown);
    node.removeEventListener("pointerup", pointerUp);
    node.removeEventListener("pointermove", pointerMove);
    node.removeEventListener("webglcontextlost", contextLostHandler);
    node.removeEventListener("webglcontextrestored", contextRestored);
  }
  bindCanvas(canvas);

  function showStatus(
    text: string,
    {
      progress = null,
      retry = false,
    }: { progress?: number | null; retry?: boolean } = {},
  ) {
    const box = q(".room-loading");
    box.hidden = false;
    box.classList.toggle("is-error", retry);
    q("#room-loading-text").textContent = text;
    q(".room-progress").hidden = progress === null;
    if (progress !== null) {
      q<HTMLProgressElement>("#room-progress").value = progress;
      q("#room-progress-value").textContent = `${progress} %`;
    }
    q("#room-retry").hidden = !retry;
  }
  function hideStatus() {
    q(".room-loading").hidden = true;
  }
  function stepActor(actor: Actor, dt: number) {
    let walking = false;
    while (actor.route.length) {
      const p = actor.route[0],
        position = actor.raiz.position,
        dx = p.x - position.x,
        dz = p.z - position.z,
        d = Math.hypot(dx, dz);
      if (d < 0.07) {
        actor.route.shift();
        continue;
      }
      const v = Math.min(d, dt * actor.speed);
      position.x += (dx / d) * v;
      position.z += (dz / d) * v;
      actor.angle = Math.atan2(dx, dz);
      walking = true;
      break;
    }
    return walking;
  }
  function leisureProps(actor: Actor) {
    const props: Record<string, THREE.Object3D> = {};
    const material = (color: string) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
    const cup = new THREE.Mesh(
      new THREE.CylinderGeometry(0.09, 0.07, 0.17, 12),
      material("#f1f7ff"),
    );
    cup.position.set(0.24, 1.12, 0.3);
    actor.raiz.add(cup);
    props.cafe = cup;
    const book = new THREE.Group();
    book.position.set(0, 1.03, 0.3);
    book.rotation.x = -0.5;
    const pages = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.07, 0.28),
      material("#f1f7ff"),
    );
    book.add(pages);
    for (const y of [-0.045, 0.045]) {
      const cover = new THREE.Mesh(
        new THREE.BoxGeometry(0.43, 0.02, 0.31),
        material("#2f66e6"),
      );
      cover.position.y = y;
      book.add(cover);
    }
    actor.raiz.add(book);
    props.library = book;
    const can = new THREE.Group();
    can.position.set(0.27, 0.88, 0.34);
    can.add(
      new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.2, 10),
        material("#43c9dc"),
      ),
    );
    const spout = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.04, 0.26, 8),
      material("#43c9dc"),
    );
    spout.rotation.z = -0.8;
    spout.position.set(0.17, 0.06, 0);
    can.add(spout);
    actor.raiz.add(can);
    props.garden = can;
    Object.values(props).forEach((prop) => (prop.visible = false));
    return props;
  }
  const meter = createFrameMeter(90);
  let adaptCooldown = 0;
  function applyQuality() {
    if (!renderer) return;
    const level = QUALITY[quality];
    pixelRatio = Math.min(devicePixelRatio || 1, level.maxPixelRatio);
    renderer.setPixelRatio(pixelRatio);
    sun.castShadow = level.shadowMap > 0;
    if (level.shadowMap && sun.shadow.mapSize.x !== level.shadowMap) {
      sun.shadow.mapSize.set(level.shadowMap, level.shadowMap);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    renderer.shadowMap.needsUpdate = true;
    meter.reset();
    adaptCooldown = 0;
  }
  // Resolution follows the measured frame interval inside the quality's cap.
  function adapt(elapsed: number) {
    const average = meter.push(elapsed);
    if (average === null) return;
    if (adaptCooldown > 0) {
      adaptCooldown--;
      return;
    }
    const cap = Math.min(devicePixelRatio || 1, QUALITY[quality].maxPixelRatio);
    const next = nextPixelRatio(pixelRatio, average, {
      min: Math.min(0.75, cap),
      max: cap,
    });
    if (next === pixelRatio) return;
    // After a drop, wait before climbing again so resolution does not flicker.
    if (next < pixelRatio) adaptCooldown = 6;
    pixelRatio = next;
    renderer?.setPixelRatio(next);
  }
  function disposeMap(object: THREE.Object3D | null) {
    const geometries = new Set<THREE.BufferGeometry>(),
      materials = new Set<THREE.Material>();
    object?.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          materials.add(m);
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
  }
  function retirarActor(actor: Actor) {
    root.querySelector(`[data-map-agent="${actor.spec.id}"]`)?.remove();
    scene.remove(actor.raiz);
    Object.values(actor.props).forEach(disposeMap);
    actor.nombreTag?.material.map?.dispose();
    actor.nombreTag?.material.dispose();
    dropCue(actor);
    dropOk(actor);
    actor.liberar();
    actors = actors.filter((a) => a !== actor);
  }
  function conciliarActores() {
    if (!loaded || !crearActor) return;
    const actuales = actors
      .filter((a) => a.spec.id.includes("#"))
      .map((a) => a.spec.id);
    const { crear, retirar } = conciliarCopias(
      [...actuales, ...copiasEnCreacion],
      copiasDeseadas.map((c) => c.id),
    );
    for (const id of retirar) {
      const actor = actors.find((a) => a.spec.id === id);
      if (actor) retirarActor(actor);
    }
    for (const id of crear) {
      const copia = copiasDeseadas.find((c) => c.id === id)!;
      const original = AGENT_SPECS.find((a) => a.id === copia.baseId);
      if (!original) continue;
      const variar = (color: string) =>
        "#" +
        new THREE.Color(color)
          .offsetHSL((copia.copia * 0.19) % 1, 0, 0)
          .getHexString();
      const spec = {
        ...original,
        id,
        nombre: `${original.nombre} · ${copia.copia + 1}`,
        color: variar(original.color),
        colores: Object.fromEntries(
          Object.entries(original.colores as Record<string, string>).map(
            ([key, value]) => [key, variar(value)],
          ),
        ),
      };
      const origen = activityFor(original.id);
      copiasEnCreacion.add(id);
      const fabrica = crearActor;
      void fabrica(spec, origen.x + copia.copia * 0.7, origen.z)
        .then((actor) => {
          if (crearActor === fabrica) copiasEnCreacion.delete(id);
          if (!actor) return;
          if (!alive || !loaded || !copiasDeseadas.some((c) => c.id === id)) {
            scene.remove(actor.raiz);
            actor.liberar();
            return;
          }
          const tag = label(spec.nombre, spec.color);
          tag.position.y = 2;
          actor.raiz.add(tag);
          actor.nombreTag = tag;
          actor.props = leisureProps(actor);
          actors.push(actor);
          const dot = document.createElement("i");
          dot.className = "map-agent";
          dot.dataset.mapAgent = id;
          dot.style.setProperty("--agent-color", spec.color);
          dot.setAttribute("role", "img");
          dot.setAttribute("aria-label", spec.nombre);
          q("#map-zones").append(dot);
          if (realState) syncAgents(realState);
        })
        .catch(() => {
          if (crearActor === fabrica) copiasEnCreacion.delete(id);
        });
    }
  }
  function teardownWorld() {
    loaded = false;
    crearActor = null;
    copiasEnCreacion.clear();
    cancelAnimationFrame(frame);
    clearTimeout(pausedLoop);
    observer?.disconnect();
    observer = null;
    controls?.dispose();
    controls = null;
    player?.liberar();
    player = null;
    actors.forEach((a) => {
      if (a.spec.id.includes("#"))
        root.querySelector(`[data-map-agent="${a.spec.id}"]`)?.remove();
      Object.values(a.props).forEach(disposeMap);
      a.nombreTag?.material?.map?.dispose();
      a.nombreTag?.material?.dispose();
      dropCue(a);
      dropOk(a);
      a.liberar();
    });
    actors = [];
    hilos?.liberar();
    hilos = null;
    labels.forEach((l) => {
      l.material.map?.dispose();
      l.material.dispose();
    });
    labels.length = 0;
    worldBoards?.dispose();
    worldBoards = null;
    world?.liberar();
    world = null;
    disposeMap(mapObject);
    mapObject = null;
    for (const mesh of [destination, blocked]) {
      mesh?.geometry.dispose();
      mesh?.material.dispose();
    }
    destination = blocked = null;
    nav = null;
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer = null;
  }
  // A lost or failed context cannot be reused: retry on a fresh canvas.
  function restart() {
    teardownWorld();
    contextLost = false;
    const fresh = document.createElement("canvas");
    fresh.tabIndex = 0;
    fresh.setAttribute("aria-label", CANVAS_LABEL);
    unbindCanvas(canvas);
    canvas.replaceWith(fresh);
    canvas = fresh;
    bindCanvas(canvas);
    void start();
  }
  async function start() {
    const attempt = ++startAttempt;
    const progress = createLoadProgress([
      "mapa",
      "plano",
      "datos",
      "fuentes",
      ...MODEL_NAMES,
    ]);
    let settled = false;
    // Parallel downloads keep reporting after one fails; never paint over the error.
    const report = () => {
      if (settled || attempt !== startAttempt || !alive) return;
      showStatus("Preparando el refugio…", { progress: progress.percent() });
    };
    const step =
      (name: string) =>
      <T>(value: T): T => {
        progress.done(name);
        report();
        return value;
      };
    report();
    try {
      renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: QUALITY[quality].antialias,
        powerPreference: "high-performance",
      });
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      // The map is static: shadows are redrawn only when something moves.
      renderer.shadowMap.autoUpdate = false;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.NoToneMapping;
      scene = new THREE.Scene();
      scene.background = new THREE.Color(FONDO);
      scene.add(new THREE.HemisphereLight("#c9d8ff", "#3d52c4", 2));
      sun = new THREE.DirectionalLight("#fff3df", 1.35);
      sun.position.set(13, 26, 19);
      sun.shadow.mapSize.set(2048, 2048);
      Object.assign(sun.shadow.camera, {
        left: -24,
        right: 24,
        top: 22,
        bottom: -22,
        near: 1,
        far: 80,
      });
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.05;
      scene.add(sun);
      applyQuality();
      camera = createThirdPersonCamera(
        canvas.clientWidth / canvas.clientHeight,
      );
      controls = new OrbitControls(camera, canvas);
      resetCamera(camera, controls.target, new THREE.Vector3(1, 0, 3));
      controls.enableDamping = !reducedMotion;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.minDistance = 3;
      controls.maxDistance = 14;
      controls.minPolarAngle = 0.35;
      controls.maxPolarAngle = 1.45;
      controls.mouseButtons = {
        LEFT: null,
        MIDDLE: null,
        RIGHT: THREE.MOUSE.ROTATE,
      };
      controls.touches = {
        ONE: THREE.TOUCH.ROTATE,
        TWO: THREE.TOUCH.DOLLY_ROTATE,
      };
      controls.update();
      const size = () => {
        const w = canvas.clientWidth,
          h = canvas.clientHeight;
        if (!w || !h || !renderer) return;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      observer = new ResizeObserver(size);
      observer.observe(canvas);
      size();
      // Every request runs in parallel and reports real bytes when it can.
      const [gltf, manifest] = await Promise.all([
        new GLTFLoader()
          .setMeshoptDecoder(MeshoptDecoder)
          .loadAsync(
            `${import.meta.env.BASE_URL}models/sala/refugio.glb`,
            (e) => {
              progress.update(
                "mapa",
                e.loaded,
                e.lengthComputable ? e.total : 0,
              );
              report();
            },
          )
          .then(step("mapa")),
        fetch(`${import.meta.env.BASE_URL}models/sala/refugio-nav.json`)
          .then((r) => {
            if (!r.ok) throw new Error("Mapa no disponible");
            return r.json();
          })
          .then(step("plano")),
        loadRoomData().then(step("datos")),
        cargarTodos((nombre: string, done: number, total: number) => {
          progress.update(nombre, done, total);
          report();
        }).then((models) => {
          MODEL_NAMES.forEach((n) => progress.done(n));
          report();
          return models;
        }),
        Promise.resolve(document.fonts?.load('46px "Dela Gothic One"'))
          .catch(() => null)
          .then(step("fuentes")),
      ]);
      if (!alive || attempt !== startAttempt) {
        disposeMap(gltf.scene);
        return;
      }
      mapObject = gltf.scene;
      scene.add(mapObject);
      world = dressWorld(scene, mapObject, manifest, {
        quieto: reducedMotion,
      });
      worldBoards = createWorldBoards(scene);
      worldBoards.update(summary);
      hilos = createThreads(scene, reducedMotion);
      hilos.sincronizar(hilosDeseados);
      nav = createNavigation(
        manifest.width,
        manifest.depth,
        manifest.obstacles,
      );
      for (const zone of ZONES) {
        const tag = label(zone.name, undefined, true);
        tag.visible = false;
        tag.position.set(zone.x, 3.1, zone.z - 1.8);
        tag.userData.tool = zone.tool;
        scene.add(tag);
        labels.push(tag);
      }
      for (const [task, spot] of Object.entries(PUESTOS)) {
        const tag = label(task[0].toUpperCase() + task.slice(1), "#78bdf8");
        tag.visible = false;
        tag.userData.phase = task;
        tag.position.set(spot.x, 1.6, spot.z + 0.25);
        tag.scale.set(2.3, 0.575, 1);
        scene.add(tag);
        labels.push(tag);
      }
      const make = async (
        spec: Spec,
        x: number,
        z: number,
      ): Promise<Actor | null> => {
        const person = await createCharacter(spec);
        if (!alive || attempt !== startAttempt) {
          person.liberar();
          return null;
        }
        person.raiz.position.set(x, 0, z);
        person.raiz.scale.setScalar(0.85);
        scene.add(person.raiz);
        return {
          ...person,
          props: {},
          activity: activityFor(spec.id),
          celebrateUntil: 0,
          route: [],
          speed: spec.id === "tu" ? 4 : 2.2,
          angle: Math.PI,
          phase: "rest",
          remaining: 1,
        };
      };
      crearActor = make;
      player = await make(JUGADOR, 1, 3);
      if (!player) return;
      const previousPlayerPosition = player.raiz.position.clone();
      for (const spec of AGENT_SPECS) {
        const activity = activityFor(spec.id, orders[spec.id], 0);
        const actor = await make(spec, activity.x, activity.z);
        if (!actor) return;
        const tag = label(spec.nombre, spec.color);
        tag.position.y = 2;
        actor.raiz.add(tag);
        actor.nombreTag = tag;
        actor.props = leisureProps(actor);
        actors.push(actor);
        assignActor(spec.id);
      }
      const ring = (color: string, opacity: number) => {
        const mesh = new THREE.Mesh(
          new THREE.RingGeometry(0.25, 0.34, 28),
          new THREE.MeshBasicMaterial({
            color,
            side: THREE.DoubleSide,
            transparent: true,
            opacity,
          }),
        );
        mesh.rotation.x = -Math.PI / 2;
        mesh.visible = false;
        scene.add(mesh);
        return mesh;
      };
      destination = ring("#fff2c4", 0.8);
      blocked = ring(CORAL, 0.9);
      await renderer.compileAsync(scene, camera).catch(() => null);
      if (!alive || attempt !== startAttempt) return;
      loaded = true;
      if (realState) syncAgents(realState);
      conciliarActores();
      hideStatus();
      paintTour();
      if (
        !root.contains(document.activeElement) ||
        document.activeElement === document.body
      )
        canvas.focus({ preventScroll: true });
      let last = performance.now(),
        hud = 0,
        tick = 0;
      const forward = new THREE.Vector3(),
        right = new THREE.Vector3();
      const loop = (now: number) => {
        if (
          !alive ||
          !loaded ||
          attempt !== startAttempt ||
          !player ||
          !nav ||
          !renderer ||
          !controls ||
          !world ||
          !destination ||
          !blocked
        )
          return;
        // A tool dialog covers the scene: keep the last frame and let the GPU and
        // the display's frame callbacks rest, looking back twice a second.
        if (contextLost || modalOpen()) {
          meter.reset();
          last = now;
          pausedLoop = setTimeout(() => {
            frame = requestAnimationFrame(loop);
          }, 500);
          return;
        }
        frame = requestAnimationFrame(loop);
        const elapsed = now - last;
        if (elapsed < frameBudget) return;
        last = now;
        const dt = Math.min(0.05, elapsed / 1000);
        let moving = false;
        if (!inputActive()) {
          const f =
              -stick.y +
              (keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0) -
              (keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0),
            l =
              stick.x +
              (keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0) -
              (keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0);
          if (f || l) {
            camera.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            right.set(-forward.z, 0, forward.x);
            const dx = forward.x * f + right.x * l,
              dz = forward.z * f + right.z * l,
              n = Math.hypot(dx, dz),
              pos = player.raiz.position;
            const strength = Math.min(1, Math.hypot(f, l));
            const x = pos.x + (dx / n) * dt * player.speed * strength,
              z = pos.z + (dz / n) * dt * player.speed * strength;
            if (nav.free(x, pos.z)) pos.x = x;
            if (nav.free(pos.x, z)) pos.z = z;
            player.angle = Math.atan2(dx, dz);
            player.walking = true;
          } else player.walking = stepActor(player, dt);
        } else {
          keys.clear();
          resetStick();
          player.walking = false;
        }
        moving ||= player.walking;
        if (player.walking) teach("walk");
        if (completionUntil && now > completionUntil) {
          q("#room-completion").hidden = true;
          completionUntil = 0;
        }
        player.animar(dt, player.walking ? "camina" : "quieta");
        player.raiz.rotation.y +=
          Math.atan2(
            Math.sin(player.angle - player.raiz.rotation.y),
            Math.cos(player.angle - player.raiz.rotation.y),
          ) * Math.min(1, dt * 10);
        if (destination.visible && !player.route.length)
          destination.visible = false;
        if (blocked.visible) {
          blocked.userData.life -= dt;
          const life = Math.max(0, blocked.userData.life / 0.7);
          blocked.material.opacity = 0.9 * life;
          if (!reducedMotion) blocked.scale.setScalar(1 + (1 - life) * 0.8);
          if (life <= 0) blocked.visible = false;
        }
        for (const actor of actors) {
          const walking = stepActor(actor, dt);
          moving ||= walking;
          let action = walking ? "camina" : "quieta";
          if (!walking && actor.phase === "going") {
            actor.phase = actor.leisureMode ? "rest" : "working";
            setActivity(actor.spec.id, actor.activity.label);
            actor.remaining =
              actor.phase === "working"
                ? 7
                : 12 + AGENT_SPECS.findIndex((a) => a.id === actor.spec.id) * 3;
          }
          if (!walking && actor.phase === "working")
            actor.angle = actor.activity.angle ?? Math.PI;
          if (!walking) {
            actor.remaining -= dt;
            if (actor.phase === "working") {
              action = liveAgent(actor.spec.id)?.ocupada ? "teclea" : "quieta";
            } else if (
              (actor.phase === "rest" || actor.phase === "done") &&
              actor.remaining <= 0 &&
              !reducedMotion
            ) {
              cycles.set(actor.spec.id, (cycles.get(actor.spec.id) || 0) + 1);
              assignActor(actor.spec.id);
            }
          }
          if (
            !walking &&
            actor.phase === "rest" &&
            actor.activity.zone === "library"
          )
            action = "teclea";
          if (!walking && actor.celebrateUntil > now && !reducedMotion)
            action = "festeja";
          for (const [zone, prop] of Object.entries(actor.props)) {
            prop.visible =
              !walking &&
              (actor.phase === "rest" ||
                (actor.phase === "working" && zone === "library")) &&
              actor.activity.zone === zone;
          }
          actor.props.cafe.position.y =
            1.12 +
            (reducedMotion ? 0 : Math.max(0, Math.sin(now / 1000)) * 0.18);
          actor.props.garden.rotation.z = reducedMotion
            ? 0
            : Math.sin(now / 1800) * 0.18;
          actor.animar(dt, action);
          actor.raiz.rotation.y +=
            Math.atan2(
              Math.sin(actor.angle - actor.raiz.rotation.y),
              Math.cos(actor.angle - actor.raiz.rotation.y),
            ) * Math.min(1, dt * 8);
        }
        if (now - hud > 200) {
          hud = now;
          const pos = player.raiz.position;
          const zone = [...ZONES].sort(
            (a, b) =>
              Math.hypot(a.x - pos.x, a.z - pos.z) -
              Math.hypot(b.x - pos.x, b.z - pos.z),
          )[0];
          if (q("#room-zone").textContent !== zone.name) {
            q("#room-zone").textContent = zone.name;
            q("#room-zone").classList.remove("swap");
            void q("#room-zone").offsetWidth;
            q("#room-zone").classList.add("swap");
          }
          root.querySelectorAll<HTMLElement>("[data-zone]").forEach((node) => {
            node.setAttribute(
              "aria-current",
              String(node.dataset.zone === zone.id),
            );
          });
          // Keep the minimap oriented like the camera, so "up" matches the screen.
          const view = camera.position.clone().sub(controls.target);
          q(".map-stage").style.setProperty(
            "--map-turn",
            `${Math.atan2(view.x, view.z)}rad`,
          );
          q(".map-player").style.left = `${((pos.x + 16) / 32) * 100}%`;
          q(".map-player").style.top = `${((pos.z + 12) / 24) * 100}%`;
          for (const actor of actors) {
            const dot = q(`[data-map-agent="${actor.spec.id}"]`);
            dot.style.left = `${((actor.raiz.position.x + 16) / 32) * 100}%`;
            dot.style.top = `${((actor.raiz.position.z + 12) / 24) * 100}%`;
            dot.title = `${actor.spec.nombre} · ${statusText(actor.spec.id)}`;
          }
          const target = q(".map-destination");
          target.hidden = !destination.visible;
          target.style.left = `${((destination.position.x + 16) / 32) * 100}%`;
          target.style.top = `${((destination.position.z + 12) / 24) * 100}%`;
          nearby =
            actors.find((a) => a.raiz.position.distanceTo(pos) < 2) ||
            ZONES.find((z) => Math.hypot(z.x - pos.x, z.z - 1.8 - pos.z) < 2);
          paintPrompt();
        }
        updateCursor();
        followPlayer(
          camera,
          controls.target,
          previousPlayerPosition,
          player.raiz.position,
          reducedMotion ? undefined : dt,
        );
        controls.update();
        hilos?.actualizar(
          now / 1000,
          (id) => actors.find((a) => a.spec.id === id)?.raiz.position,
        );
        if (!reducedMotion) {
          const pulse = 1 + Math.sin(now / 320) * 0.06;
          for (const actor of actors)
            actor.okTag?.scale.set(3.2 * pulse, 0.8 * pulse, 1);
        }
        const wallsChanged = world.actualizar(
          now / 1000,
          dt,
          camera,
          controls.target,
        );
        if (
          sun.castShadow &&
          shadowUpdateDue({
            moving,
            wallsChanged,
            animated: !reducedMotion,
            frame: tick,
          })
        )
          renderer.shadowMap.needsUpdate = true;
        tick++;
        renderer.render(scene, camera);
        if (debug)
          stats = {
            calls: renderer.info.render.calls,
            triangles: renderer.info.render.triangles,
            geometries: renderer.info.memory.geometries,
            textures: renderer.info.memory.textures,
            programs: renderer.info.programs?.length ?? 0,
            pixelRatio,
            quality,
            frames: (stats?.frames ?? 0) + 1,
          };
        // Under a frame cap, hitting the cap is the "at refresh rate" of adapt().
        adapt(frameBudget ? elapsed - 16.7 : elapsed);
      };
      frame = requestAnimationFrame(loop);
    } catch (caught) {
      const e = caught as Error;
      settled = true;
      if (alive && attempt === startAttempt) {
        showStatus(
          "No se pudo abrir el mundo 3D. Los encargos y las herramientas siguen disponibles.",
          { retry: true },
        );
        toast(e.message);
      }
    }
  }
  // `?debug` only: numbers and world-to-screen helpers for ops/verify-refuge.mjs.
  if (debug)
    window.__refugio = {
      stats: () => ({
        ...stats,
        loaded,
        overlays: overlays.list(),
        blocked: !!blocked?.visible,
        destination: !!destination?.visible,
        cursor: canvas.style.cursor,
        shadows: !!sun?.castShadow,
      }),
      positions: () =>
        Object.fromEntries(
          [player, ...actors]
            .filter((a): a is Actor => a !== null)
            .map((a) => [
              a!.spec.id,
              {
                x: a.raiz.position.x,
                z: a.raiz.position.z,
                moving: a.route.length > 0,
              },
            ]),
        ),
      project(x: number, y: number, z: number) {
        const v = new THREE.Vector3(x, y, z).project(camera);
        const rect = canvas.getBoundingClientRect();
        return {
          x: rect.left + ((v.x + 1) / 2) * rect.width,
          y: rect.top + ((1 - v.y) / 2) * rect.height,
        };
      },
      walkTo: (x: number, z: number) => move(player, { x, z }),
      equipos: () => ({
        puestos: Object.fromEntries(puestosEq),
        hilos: hilos?.claves() || [],
        hilosVisibles: hilos?.visibles() || 0,
        esperandoOk: actors.filter((a) => a.okTag).map((a) => a.spec.id),
        relevos: [...relevosVistos],
      }),
    };
  const syncTeam = () => {
    const snapshot = team.getSnapshot();
    const observadas =
      snapshot.sessions === null ? null : sceneSessions(snapshot.sessions);
    copiasDeseadas = observadas?.copias || [];
    const equipos = sceneTeams(snapshot.sessions || []);
    puestosEq = teamSeats(equipos.grupos);
    hilosDeseados = equipos.hilos;
    hilos?.sincronizar(hilosDeseados);
    // Handoffs come from what the launcher recorded; nothing is invented or fetched.
    const reales = newHandoffs(snapshot.sessions || [], relevosVistos);
    for (const id of reales.ids) relevosVistos.add(id);
    const ultimo = reales.nuevos.at(-1);
    if (ultimo && relevosIniciados)
      playRelay({
        ...ultimo,
        tipo: "relevo",
        texto:
          ultimo.tipo === "entregable"
            ? "entregable del equipo"
            : "mensaje del equipo",
      });
    relevosIniciados = snapshot.sessions !== null;
    leerAprobaciones();
    const relayEvents = snapshot.events
      .filter((e) => e.id && e.de && e.para)
      .map((e) => ({
        id: e.id!,
        tipo: e.tipo || "",
        de: e.de!,
        para: e.para!,
        texto: e.texto || "",
      }));
    syncAgents(
      {
        conectado: observadas ? true : snapshot.connected,
        agentes: observadas
          ? [
              ...observadas.base,
              ...observadas.copias.map((c) => ({
                id: c.id,
                ocupada: true,
                ultimo: {
                  jobId: c.sesionId,
                  estado: "trabajando",
                  fase: c.fase,
                  actividad: {
                    zona: PUESTOS[c.fase || ""]?.zone || "terrace",
                    etiqueta: c.etiqueta,
                  },
                },
              })),
            ]
          : snapshot.agents.map((a) => ({ ...a, ocupada: !!a.ocupada })),
      },
      {
        flujos: observadas ? [] : snapshot.flows,
        eventos: observadas ? [] : relayEvents,
      },
    );
    conciliarActores();
    const unread = new Set<string>();
    let read: string[] = [];
    try {
      read = JSON.parse(localStorage.getItem("sb-sala-leidos-v1") || "[]");
    } catch {
      /* No stored reads. */
    }
    for (const a of snapshot.agents)
      for (const job of a.historial || (a.ultimo?.fin ? [a.ultimo] : []))
        if (job.jobId && !read.includes(job.jobId)) unread.add(job.jobId);
    for (const f of snapshot.flows)
      for (const job of f.pasos)
        if (
          job.jobId &&
          ["listo", "error", "cancelado", "interrumpido"].includes(
            job.estado,
          ) &&
          !read.includes(job.jobId)
        )
          unread.add(job.jobId);
    q(".team-toggle span").textContent = unread.size
      ? `${unread.size} nuevos`
      : "4";
  };
  // The service already lists approvals for the panel; the scene only reads them.
  function leerAprobaciones() {
    const now = Date.now();
    if (
      !aprobar ||
      leyendoAprobaciones ||
      now - ultimaLecturaAprobaciones < 2000
    )
      return;
    leyendoAprobaciones = true;
    ultimaLecturaAprobaciones = now;
    void aprobar()
      .then((lista) => {
        if (alive && Array.isArray(lista))
          aprobacionesVivas = lista as ObservedApproval[];
      })
      .catch(() => {
        /* Keeps the last list; the panel reports the failure. */
      })
      .finally(() => {
        leyendoAprobaciones = false;
        if (alive) refrescarOk();
      });
  }
  function refrescarOk() {
    const siguiente = figurasEsperandoOk(aprobacionesVivas, Date.now());
    if (
      siguiente.size === esperandoOk.size &&
      [...siguiente].every((id) => esperandoOk.has(id))
    )
      return;
    esperandoOk = siguiente;
    syncOk();
  }
  // Expiry is local: the bubble leaves when the deadline passes, without a request.
  const okClock = setInterval(refrescarOk, 1000);
  const unsubscribeTeam = team.subscribe(syncTeam);
  addEventListener("sb-room-orders", loadRoomData);
  let replayTimer: ReturnType<typeof setTimeout>;
  const replay = (event: Event) => {
    clearTimeout(replayTimer);
    irAEspacio("/");
    const events = (event as CustomEvent<{ events: TeamEvent[] }>).detail
      .events;
    let index = 0;
    q(".equipo-replay").hidden = false;
    const next = () => {
      if (!alive) return;
      if (index >= events.length) {
        q("#team-replay-status").textContent = "Repetición terminada";
        return;
      }
      const e = events[index++];
      playRelay(
        {
          id: e.id || "replay",
          tipo: "relevo",
          de: e.de || "",
          para: e.para || "",
          texto: e.texto || "",
        },
        true,
      );
      q("#team-replay-status").textContent =
        `Reproduciendo ${index}/${events.length}: ${e.texto}`;
      replayTimer = setTimeout(next, 4500);
    };
    q("#team-replay-stop").onclick = () => {
      clearTimeout(replayTimer);
      q(".equipo-replay").hidden = true;
      world?.detenerRelevo();
      showTeam({ tab: "vivo" });
    };
    next();
    q("#team-replay-stop").focus();
  };
  addEventListener("sb-team-replay", replay);
  syncTeam();
  void start();
  return () => {
    alive = false;
    sound.dispose();
    resetStick();
    joystick.removeEventListener("pointerdown", stickDown);
    joystick.removeEventListener("pointermove", stickMove);
    joystick.removeEventListener("pointerup", stickEnd);
    joystick.removeEventListener("pointercancel", stickEnd);
    joystick.removeEventListener("lostpointercapture", stickEnd);
    document.removeEventListener("visibilitychange", visibility);
    unsubscribeTeam();
    clearTimeout(replayTimer);
    removeEventListener("sb-room-orders", loadRoomData);
    removeEventListener("sb-team-replay", replay);
    clearInterval(clock);
    clearInterval(okClock);
    compactQuery.removeEventListener("change", compactChange);
    removeEventListener("keydown", keydown);
    removeEventListener("keyup", keyup);
    removeEventListener("blur", blur);
    root.removeEventListener("click", click);
    root.removeEventListener("room-data", updateRoomData);
    root.removeEventListener("change", change);
    root.removeEventListener("pointerdown", pointerKind, true);
    unbindCanvas(canvas);
    teardownWorld();
    if (debug) delete window.__refugio;
  };
}
