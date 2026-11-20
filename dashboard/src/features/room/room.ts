import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createThirdPersonCamera, followPlayer } from "./room-camera";
import {
  AGENT_SPECS,
  JUGADOR,
  createCharacter,
  type SceneSpec,
} from "./room-characters";
import {
  createNavigation,
  activityFor,
  interactionPrompt,
  puestoPara,
  PUESTOS,
  normalizeOrder,
  ZONES,
  tourInstructions,
} from "./room-life";
import { dressWorld } from "./room-world";
import { characterState, etiquetaRoster } from "./team-panel";
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
  observedCompletions,
  createRoomSound,
  waitingFlow,
} from "./room-controls";
import {
  QUALITY,
  QUALITY_LABELS,
  createFrameMeter,
  minFrameInterval,
  nextPixelRatio,
  qualityFor,
  shadowUpdateDue,
} from "./room-quality";
import { animateAgent, stepActor, turnToward, type Actor } from "./room-actors";
import { paintHud, startClock, type Nearby } from "./room-hud";
import { createRefugeLoad } from "./room-assets";
import { createWalkInput } from "./room-input";
import { createPointer } from "./room-pointer";
import { createRelayReplay } from "./room-replay";
import { sceneFromSnapshot, unreadJobs } from "./room-snapshot";
import { CANVAS_LABEL, ICONS, esc, roomMarkup, toPlace } from "./room-markup";
import {
  CORAL,
  disposeObject,
  disposeSprite,
  floorRing,
  label,
  leisureProps,
  placeLabels,
} from "./room-props";
import { createOrbit, createStage, nudgeCamera } from "./room-stage";

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
} from "../team/team-controller";
import type { RoomSummary } from "./room-summary";
type Spec = SceneSpec;
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
// Same breakpoint as the compact HUD in room.css: phones in both orientations.
const COMPACT_QUERY = "(max-width: 700px), (max-height: 500px)";
const QUALITY_KEY = "sb-refugio-calidad";

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
  root.innerHTML = roomMarkup({
    compact,
    savedQuality,
    volume: Number(stored("sb-room-volume", "0")),
  });
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
    disposeSprite(actor.cueTag);
    actor.cueTag = null;
  }
  function dropOk(actor: Actor) {
    if (!actor.okTag) return;
    actor.raiz.remove(actor.okTag);
    disposeSprite(actor.okTag);
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
  const stopClock = startClock(root);
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
    if (cam && controls)
      nudgeCamera(
        cam.dataset.camera,
        camera,
        controls,
        player?.raiz.position ?? null,
      );
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
  const walkInput = createWalkInput(q("#room-joystick"), {
    canStartStick: () => !inputActive() && !overlays.list().length,
    onWalkInput: () => {
      if (player) player.route = [];
    },
  });
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
    walkInput.keyDown(e);
    if (e.code === "KeyE") {
      e.preventDefault();
      interact();
    }
  };
  const keyup = (e: KeyboardEvent) => walkInput.keyUp(e),
    blur = () => walkInput.release();
  addEventListener("keydown", keydown);
  addEventListener("keyup", keyup);
  addEventListener("blur", blur);
  let nearby: Nearby;
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

  const pointer = createPointer({
    canvas: () => canvas,
    world: () => ({ camera, nav, actors, labels }),
    canClick: () => loaded && !inputActive(),
    onAgent: (id) => openAgent(id, "world"),
    onTool: openTool,
    onFloor: (spot) => {
      sound.play("move");
      move(player, spot);
      destination!.position.set(spot.x, 0.025, spot.z);
      destination!.visible = true;
      canvas.focus();
    },
    onSea: (point) => {
      // Nothing walkable nearby (the sea): a short coral pulse where the click landed.
      blocked!.position.set(point.x, 0.03, point.z);
      blocked!.userData.life = 0.7;
      blocked!.visible = true;
    },
  });
  const pointerDown = (e: PointerEvent) => pointer.down(e);
  const pointerUp = (e: PointerEvent) =>
    pointer.up(e, !!(player && destination && blocked));
  const pointerMove = (e: PointerEvent) => pointer.move(e);
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
  // Name tag over the head and the leisure props in her hands.
  function dressAgent(actor: Actor, spec: Spec) {
    const tag = label(spec.nombre, spec.color);
    tag.position.y = 2;
    actor.raiz.add(tag);
    actor.nombreTag = tag;
    actor.props = leisureProps(actor.raiz);
  }
  function releaseActor(actor: Actor) {
    Object.values(actor.props).forEach(disposeObject);
    disposeSprite(actor.nombreTag);
    dropCue(actor);
    dropOk(actor);
    actor.liberar();
  }
  function retirarActor(actor: Actor) {
    root.querySelector(`[data-map-agent="${actor.spec.id}"]`)?.remove();
    scene.remove(actor.raiz);
    releaseActor(actor);
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
          dressAgent(actor, spec);
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
      releaseActor(a);
    });
    actors = [];
    hilos?.liberar();
    hilos = null;
    labels.forEach(disposeSprite);
    labels.length = 0;
    worldBoards?.dispose();
    worldBoards = null;
    world?.liberar();
    world = null;
    disposeObject(mapObject);
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
    let settled = false;
    // Parallel downloads keep reporting after one fails; never paint over the error.
    const assets = createRefugeLoad((percent) => {
      if (settled || attempt !== startAttempt || !alive) return;
      showStatus("Preparando el refugio…", { progress: percent });
    });
    assets.report();
    try {
      ({ renderer, scene, sun } = createStage(canvas, {
        antialias: QUALITY[quality].antialias,
      }));
      applyQuality();
      camera = createThirdPersonCamera(
        canvas.clientWidth / canvas.clientHeight,
      );
      controls = createOrbit(camera, canvas, reducedMotion);
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
      const [gltf, manifest] = await assets.load(loadRoomData);
      if (!alive || attempt !== startAttempt) {
        disposeObject(gltf.scene);
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
      labels.push(...placeLabels(scene, ZONES, PUESTOS));
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
        dressAgent(actor, spec);
        actors.push(actor);
        assignActor(spec.id);
      }
      destination = floorRing(scene, "#fff2c4", 0.8);
      blocked = floorRing(scene, CORAL, 0.9);
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
          const { forward: f, left: l } = walkInput.axes();
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
          walkInput.release();
          player.walking = false;
        }
        moving ||= player.walking;
        if (player.walking) teach("walk");
        if (completionUntil && now > completionUntil) {
          q("#room-completion").hidden = true;
          completionUntil = 0;
        }
        player.animar(dt, player.walking ? "camina" : "quieta");
        turnToward(player, dt, 10);
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
          const id = actor.spec.id;
          // Every agent animates each frame; do not short-circuit the call.
          const walked = animateAgent(actor, dt, now, {
            reducedMotion,
            restSeconds: 12 + AGENT_SPECS.findIndex((a) => a.id === id) * 3,
            isBusy: () => !!liveAgent(id)?.ocupada,
            onArrive: () => setActivity(id, actor.activity.label),
            onRestOver: () => {
              cycles.set(id, (cycles.get(id) || 0) + 1);
              assignActor(id);
            },
          });
          moving ||= walked;
        }
        if (now - hud > 200) {
          hud = now;
          nearby = paintHud(root, {
            player: player.raiz.position,
            actors,
            camera,
            controls,
            destination,
            statusText,
          });
          paintPrompt();
        }
        pointer.updateCursor();
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
    const shown = sceneFromSnapshot(snapshot, observadas);
    syncAgents(shown.agents, shown.team);
    conciliarActores();
    let read: string[] = [];
    try {
      read = JSON.parse(localStorage.getItem("sb-sala-leidos-v1") || "[]");
    } catch {
      /* No stored reads. */
    }
    const unread = unreadJobs(snapshot, read);
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
  const stopReplay = createRelayReplay(root, {
    isAlive: () => alive,
    playRelay,
    onStart: () => irAEspacio("/"),
    onStop: () => {
      world?.detenerRelevo();
      showTeam({ tab: "vivo" });
    },
  });
  syncTeam();
  void start();
  return () => {
    alive = false;
    sound.dispose();
    walkInput.dispose();
    document.removeEventListener("visibilitychange", visibility);
    unsubscribeTeam();
    stopReplay();
    removeEventListener("sb-room-orders", loadRoomData);
    stopClock();
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
