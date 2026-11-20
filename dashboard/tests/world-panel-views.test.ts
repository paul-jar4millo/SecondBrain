// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { mountPanel } from "../src/features/world/panel";
import type { WorldData } from "../src/features/world/panel-types";

const video = (id: string, status: string, checks: boolean[]) => ({
  id,
  title: `¿Qué pasaría si ${id}?`,
  status,
  date: "2026-11-09",
  num: id.length,
  poster: status === "Publicado" ? null : `/posters/${id}.png`,
  duration: 42.5,
  metric: { vistas: 1200 },
  checks,
  favorite: status === "Publicado",
  scenes: [{ id: "intro", exists: true }, { id: "cierre" }],
  stage: "Guion",
  files: ["brief.md"],
  modular: status !== "Publicado",
});

const data: WorldData = {
  scannedAt: "2026-11-09T12:00:00Z",
  updated: "2026-11-09",
  stages: ["Brief", "Guion", "Escenas", "Portada", "QA", "MP4"],
  videos: [
    video("luna", "En producción", [true, true, false, false, false, false]),
    video("sol", "Listo para revisar", [true, true, true, true, true, false]),
    video("mar", "Publicado", [true, true, true, true, true, true]),
  ],
  metrics: [
    {
      video: "Mar",
      num: 3,
      plantilla: "clásica",
      vistas: 5000,
      edad_h: 24,
      vistas_dia: 5000,
      pct_sigue_3s: 61.5,
      pct_completo: 20,
      comp_guard_x1000: 3.2,
    },
    {
      video: "Oculto",
      num: 4,
      plantilla: "clásica",
      vistas: null,
      edad_h: null,
      vistas_dia: null,
      pct_sigue_3s: null,
      pct_completo: null,
      comp_guard_x1000: null,
      oculto: true,
    },
  ],
  sameAge: [{ video: "Mar", edad_h: 24, vistas: 5000, vistas_hora: 208 }],
  retention: [
    { num: 3, video: "Mar", seg: 0, pct: 100, fecha_toma: "2026-11-09" },
    { num: 3, video: "Mar", seg: 10, pct: 55, fecha_toma: "2026-11-09" },
  ],
  interpretation: {
    actualizado: "2026-11-09",
    videos_con_analiticas: 1,
    filas: [
      {
        grafica: "titular",
        titulo: "El gancho retiene",
        texto: "La mitad sigue a los 10 s.",
        accion: "Repetir el gancho",
        confianza: "media",
      },
      {
        titulo: "Poca muestra",
        texto: "Un solo video.",
        accion: "Publicar más",
        confianza: "baja",
      },
    ],
  },
  hypotheses: [
    {
      id: "H1",
      hipotesis: "Los ganchos visuales retienen",
      estado: "abierta",
      se_mide: "Retención a 3 s",
      a_favor: "Mar",
      en_contra: "—",
      estado_texto: "Sin datos suficientes",
    },
  ],
  agents: [
    {
      id: "analista",
      name: "Analista",
      description: "Lee métricas",
      enabled: true,
      notes: "",
      source: "agents/analista.md",
    },
    {
      id: "recolector-tiktok",
      name: "Recolector",
      description: "Toma métricas",
      enabled: false,
      notes: "",
      source: "agents/recolector.md",
    },
  ],
  ideas: [
    { title: "¿Qué pasaría si no hubiera noche?", num: 7, source: "ideas.md" },
  ],
  state: {
    tasks: [
      {
        id: "t1",
        agentId: "analista",
        videoId: "luna",
        instruction: "Analiza Luna",
        status: "queued",
        createdAt: "2026-11-09T10:00:00Z",
      },
      {
        id: "t2",
        agentId: "analista",
        videoId: null,
        instruction: "Resumen del canal",
        status: "completed",
        createdAt: "2026-11-08T10:00:00Z",
        completionSource: "manual",
      },
    ],
    briefs: [
      {
        id: "b1",
        title: "Noche eterna",
        brief: "Premisa",
        slug: "noche-eterna",
        createdAt: "2026-11-09T10:00:00Z",
      },
    ],
  },
};

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

async function mount(view: string, extra = "") {
  history.replaceState(
    {},
    "",
    `/projects/mundo-hipotetico?view=${view}${extra}`,
  );
  document.body.innerHTML = `<div id="nav"></div><a id="settings-link"></a>
    <div id="breadcrumb"></div><input id="search"><button id="refresh"></button>
    <button id="new-video"></button><span id="search-icon"></span>
    <main id="main"></main><div id="sync-label"></div>
    <dialog id="dialog"><div id="dialog-body"></div></dialog><div id="toast"></div>`;
  const dialog = document.querySelector("dialog")!;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  const api = vi.fn(async (path: string) =>
    path.startsWith("/mundo/document")
      ? { path: "agents/analista.md", text: "# Analista" }
      : path === "/mundo/overview"
        ? data
        : {},
  );
  dispose = mountPanel(document.body, { api, confirm: async () => true });
  await vi.waitFor(() =>
    expect(document.querySelector("#main")!.children.length).toBeGreaterThan(0),
  );
  return { api, dialog, main: document.querySelector("#main")! };
}

const click = (selector: string) =>
  (document.querySelector(selector) as HTMLElement).click();

it.each([
  ["overview", "", "Mesa de producción"],
  ["videos", "&status=Favoritos", "Biblioteca de videos"],
  ["production", "", "La mesa de montaje"],
  ["create", "", "Un mundo por crear"],
  ["analysis", "&hidden=true&sort=vistas", "Cada vista tiene contexto"],
  ["results", "&confidence=baja", "De los números a las decisiones"],
  ["agents", "", "Tu equipo de agentes"],
  ["settings", "", "Un panel que sigue tu ritmo"],
])("muestra la vista %s", async (view, extra, title) => {
  const { main } = await mount(view, extra);
  expect(main.querySelector("h1")?.textContent).toBe(title);
  expect(document.querySelector("#breadcrumb")!.textContent).not.toBe("");
});

it("abre los diálogos de encargo, configuración, documento e ideas", async () => {
  const { api, dialog } = await mount("agents");
  click('[data-action="assign"][data-agent="analista"]');
  await vi.waitFor(() =>
    expect(dialog.querySelector("#task-form")).not.toBeNull(),
  );
  click('[data-action="agent-config"][data-id="analista"]');
  await vi.waitFor(() =>
    expect(dialog.querySelector("#agent-form")).not.toBeNull(),
  );
  click('[data-action="document"]');
  await vi.waitFor(() =>
    expect(dialog.querySelector("pre")?.textContent).toBe("# Analista"),
  );
  expect(api).toHaveBeenCalledWith(
    "/mundo/document?path=agents%2Fanalista.md",
    undefined,
  );
  click('[data-action="task-cancel"]');
  await vi.waitFor(() =>
    expect(
      dialog.querySelector('[data-action="confirm-cancel"]'),
    ).not.toBeNull(),
  );
  click('[data-action="confirm-cancel"]');
  await vi.waitFor(() =>
    expect(api).toHaveBeenCalledWith("/mundo/tasks/status", {
      id: "t1",
      status: "cancelled",
    }),
  );
});

it("una idea llena el brief y el formulario guarda", async () => {
  const { api, dialog } = await mount("create");
  click('[data-action="ideas"]');
  await vi.waitFor(() =>
    expect(dialog.querySelector('[data-action="use-idea"]')).not.toBeNull(),
  );
  click('[data-action="use-idea"]');
  await vi.waitFor(() =>
    expect(
      (document.querySelector("#brief-slug") as HTMLInputElement).value,
    ).toBe("no-hubiera-noche"),
  );
  const form = document.querySelector("#brief-form") as HTMLFormElement;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/mundo/briefs",
      expect.objectContaining({ slug: "no-hubiera-noche" }),
    ),
  );
});

it("filtra, busca y navega por los enlaces del menú", async () => {
  const { main } = await mount("videos");
  click('[data-action="filter"][data-value="Publicado"]');
  expect(main.querySelectorAll(".video-card")).toHaveLength(1);
  click('a.nav-link[href$="view=analysis"]');
  expect(main.querySelector("h1")?.textContent).toBe(
    "Cada vista tiene contexto",
  );
  const sort = document.querySelector("#metric-sort") as HTMLSelectElement;
  sort.value = "pct_completo";
  sort.dispatchEvent(new Event("change", { bubbles: true }));
  expect(new URL(location.href).searchParams.get("sort")).toBe("pct_completo");
  const hidden = document.querySelector("#hidden-videos") as HTMLInputElement;
  hidden.checked = true;
  hidden.dispatchEvent(new Event("change", { bubbles: true }));
  expect(new URL(location.href).searchParams.get("hidden")).toBe("true");
});
