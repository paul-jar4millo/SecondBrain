// Mundo Hipotético panel: reads the package the channel publishes. Plain HTML
// templates; React only mounts and unmounts it.
import type {
  SortableMetric,
  WorldData,
  WorldMetric,
  WorldTask,
  WorldVideo,
} from "./panel-types";

interface PanelOptions {
  api: (path: string, body?: unknown) => Promise<unknown>;
  confirm?: (
    message: string,
    options?: { confirmLabel?: string; danger?: boolean },
  ) => Promise<boolean>;
}
/** A button or link that carries a data-action. */
type Action = (b: HTMLElement) => unknown;

export function mountPanel(
  root: HTMLElement,
  { api: apiBase, confirm: confirmDecision = async () => false }: PanelOptions,
) {
  const control = new AbortController();
  const on = <E extends Event>(
    goal: EventTarget,
    type: string,
    fn: (event: E) => unknown,
  ) =>
    goal.addEventListener(type, fn as EventListener, {
      signal: control.signal,
    });
  // WorldPage renders these nodes; most lookups are inputs or plain elements.
  const $ = <T extends HTMLElement = HTMLInputElement>(s: string) =>
    root.querySelector<T>(s)!;
  const dialog = () => $<HTMLDialogElement>("#dialog");
  const target = (event: Event) => event.target as HTMLInputElement;
  const message = (e: unknown) => (e as Error).message;
  const esc = (s: unknown) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        (<Record<string, string>>{
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const paths: Record<string, string> = {
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    film: "M4 3h16v18H4z M4 8h16 M4 16h16 M8 3v18 M16 3v18",
    flow: "M4 4h6v6H4z M14 14h6v6h-6z M7 10v7h7 M10 7h7v7",
    chart: "M4 3v17h17 M8 15v-4 M13 15V6 M18 15V9",
    bulb: "M9 18h6 M10 21h4 M8 14a6 6 0 1 1 8 0c-1.3 1-1 2-1 2h-6s.3-1-1-2",
    bot: "M7 7h10a3 3 0 0 1 3 3v9H4v-9a3 3 0 0 1 3-3z M12 3v4 M9 12v2 M15 12v2 M1 12v4 M23 12v4",
    activity: "M2 12h4l3-8 6 16 3-8h4",
    search: "m21 21-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
    plus: "M12 5v14 M5 12h14",
    refresh:
      "M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 3 M18 17a7 7 0 0 1-12 1l-2-3",
    arrow: "M5 12h14 m-5-5 5 5-5 5",
    close: "m6 6 12 12 M18 6 6 18",
    play: "m8 4 12 8-12 8z",
    check: "m5 12 4 4L19 6",
    download: "M12 3v12 m-5-5 5 5 5-5 M4 17v4h16v-4",
    copy: "M9 9h12v12H9z M15 9V3H3v12h6",
    file: "M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M10 2h4l1 3 3 1 3 3-2 3 2 3-3 3-3 1-1 3h-4l-1-3-3-1-3-3 2-3-2-3 3-3 3-1z",
    clock: "M12 7v5l4 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0",
  };
  const icon = (name: string) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${(
      paths[name] || paths.file
    )
      .split(" M")
      .map((p, i) => `<path d="${i ? "M" : ""}${p}"/>`)
      .join("")}</svg>`;
  const names: Record<string, string> = {
    overview: "Vista general",
    videos: "Biblioteca de videos",
    production: "Producción",
    create: "Crear video",
    analysis: "Análisis de videos",
    results: "Interpretación",
    agents: "Agentes",
    settings: "Preferencias",
  };
  const navigation: [string, string, string][] = [
    ["overview", "grid", "Vista general"],
    ["videos", "film", "Videos"],
    ["production", "flow", "Producción"],
    ["analysis", "chart", "Análisis"],
    ["results", "bulb", "Interpretación"],
    ["agents", "bot", "Agentes"],
  ];
  // Assigned by the first successful load; render() waits for it.
  let data!: WorldData;
  let loading = false,
    toastTimer: ReturnType<typeof setTimeout> | undefined,
    pollTimer: ReturnType<typeof setInterval> | undefined;
  const params = () => new URL(location.href).searchParams;
  const view = () =>
    names[params().get("view") ?? ""] ? params().get("view")! : "overview";
  let query = params().get("q") || "";
  let autoRefresh = true;
  try {
    autoRefresh = localStorage.getItem("mh-panel-auto") !== "false";
  } catch {}
  const num = (v: number | string | null | undefined, d = 0) =>
    v == null
      ? "—"
      : new Intl.NumberFormat("es-MX", { maximumFractionDigits: d }).format(
          Number(v),
        );
  const compact = (v: number | null | undefined) =>
    new Intl.NumberFormat("es-MX", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(v || 0);
  function date(
    v: string | null | undefined,
    options: Intl.DateTimeFormatOptions = {},
  ) {
    if (!v) return "Sin fecha";
    const parsed = new Date(v.length === 10 ? v + "T12:00:00Z" : v);
    if (Number.isNaN(parsed.getTime())) return "Sin fecha";
    return new Intl.DateTimeFormat("es-MX", {
      timeZone: "America/Mexico_City",
      day: "numeric",
      month: "short",
      ...options,
    }).format(parsed);
  }
  const isActive = (v: WorldVideo) =>
    !["Publicado", "Descartado"].includes(v.status);
  const shortTitle = (v: { title: string }) =>
    v.title
      .replace(/^¿Qué pasaría si\s*/i, "")
      .replace(/\?$/, "")
      .replace(/^Beats:\s*/, "");
  const match = (v: WorldVideo) =>
    !query ||
    `${v.title} ${v.num || ""} ${v.status}`
      .toLocaleLowerCase("es")
      .includes(query.toLocaleLowerCase("es"));
  const button = (label: string, action: string, extra = "", classes = "") =>
    `<button class="button ${classes}" data-action="${action}" ${extra}>${label}</button>`;
  function badge(status: string) {
    const cls =
      (<Record<string, string>>{
        Publicado: "published",
        "Listo para revisar": "ready",
        Descartado: "stopped",
        "En producción": "work",
        completed: "published",
        failed: "pink",
        running: "work",
        queued: "ready",
        interrupted: "pink",
        cancelled: "stopped",
      })[status] || "";
    const labels: Record<string, string> = {
      completed: "Completado",
      failed: "Falló",
      running: "En ejecución",
      queued: "En cola",
      interrupted: "Interrumpido",
      cancelled: "Cancelado",
    };
    return `<span class="badge ${cls}">${esc(labels[status] || status)}</span>`;
  }
  const evidence = (v: WorldVideo) =>
    `<div class="mini-progress" aria-label="${v.checks.filter(Boolean).length} de ${data.stages.length} evidencias presentes">${v.checks.map((c) => `<span class="${c ? "done" : ""}"></span>`).join("")}</div>`;
  const poster = (v: WorldVideo, cls = "", priority = false) =>
    v.poster
      ? `<img class="${cls}" src="${esc(v.poster)}" alt="Portada de ${esc(shortTitle(v))}" width="400" height="600" ${priority ? 'fetchpriority="high"' : 'loading="lazy"'}>`
      : `<div class="no-poster">${icon("film")}<span>Por crear</span></div>`;
  function videoCard(v: WorldVideo) {
    return `<article class="video-card"><button class="video-image" data-action="video" data-id="${esc(v.id)}" aria-label="Abrir ${esc(v.title)}">${poster(v)}${badge(v.status)}${v.duration ? `<span class="duration">${num(v.duration, 1)} s</span>` : ""}</button><div class="video-card-body"><h3><button data-action="video" data-id="${esc(v.id)}">${esc(shortTitle(v))}</button></h3><div class="video-card-footer"><span>${v.metric ? `${compact(v.metric.vistas)} vistas` : esc(date(v.date))}</span>${evidence(v)}</div></div></article>`;
  }
  function heading(title: string, description = "", right = "") {
    return `<div class="page-heading"><div><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ""}</div>${right}</div>`;
  }
  function section(title: string, description = "", link = "") {
    return `<div class="section-heading"><div><h2>${title}</h2>${description ? `<p>${description}</p>` : ""}</div>${link}</div>`;
  }
  function empty(title: string, text: string, action = "") {
    return `<div class="empty"><h2>${esc(title)}</h2><p>${esc(text)}</p>${action}</div>`;
  }
  function sourceNote() {
    return `<div class="source-note"><span><i class="live-dot"></i>Archivos reales del canal<span class="tag">Sin datos de ejemplo</span><span>Última toma de métricas: ${esc(date(data.updated, { year: "numeric" }))}</span></span><span>Actualización ${autoRefresh ? "automática cada 15 s" : "manual"}</span></div>`;
  }
  function overview() {
    const active = data.videos.filter(isActive),
      featured = active.find((v) => v.poster) || active[0] || data.videos[0];
    const pending = data.state.tasks.filter(
      (t) => t.status === "queued",
    ).length;
    const reading = data.interpretation.filas.find(
      (r) => r.grafica === "titular",
    );
    const visible = data.metrics.filter((m) => !m.oculto);
    const age = data.sameAge.filter((m) => !m.oculto).slice(0, 5);
    const max = Math.max(...age.map((v) => v.vistas_hora), 1);
    return (
      heading(
        "Mesa de producción",
        "De la primera idea al siguiente video publicado.",
        `<span class="date">${esc(date(new Date().toISOString(), { weekday: "long", year: "numeric" }))}</span>`,
      ) +
      sourceNote() +
      `<div class="hero-grid">${featured ? `<section class="featured" aria-label="Proyecto destacado"><div class="featured-poster">${poster(featured, "", true)}<span class="timecode">9:16${featured.duration ? ` / ${num(featured.duration, 1)} s` : ""}</span></div><div class="featured-copy"><div class="feature-label"><span><i class="live-dot"></i>En tu mesa</span><span>${esc(date(featured.date))}</span></div><h2>${esc(shortTitle(featured))}</h2><p class="meta">${num(featured.scenes.length)} escenarios · ${esc(featured.status)}<br>Siguiente evidencia: ${esc(featured.stage.toLowerCase())}</p><div class="evidence" aria-label="Evidencias de preparación">${featured.checks.map((c) => `<span class="${c ? "done" : ""}"></span>`).join("")}</div><div class="evidence-label"><span>${featured.checks.filter(Boolean).length} de 6 evidencias presentes</span><span>Verifica la entrega</span></div>${button(`Abrir proyecto ${icon("arrow")}`, "video", `data-id="${esc(featured.id)}"`, "sky")}</div></section>` : empty("Tu mesa está lista", "Crea el primer brief para comenzar.", button("Crear video", "create"))}
  <section class="panel queue"><div class="panel-heading"><h2>Lo que sigue <span class="tag">${num(active.length)} proyectos</span></h2>${icon("flow")}</div><div class="queue-list">
    <div class="queue-item"><span class="queue-icon">${icon("film")}</span><div><h3>${num(active.length)} videos en producción</h3><p>Revisa los archivos y la evidencia de entrega.</p></div><button data-action="navigate" data-view="production" aria-label="Ver producción">${icon("arrow")}</button></div>
    <div class="queue-item"><span class="queue-icon">${icon("chart")}</span><div><h3>${data.updated ? "Actualizar las tomas de métricas" : "Registrar las primeras métricas"}</h3><p>${data.updated ? "Última captura: " + esc(date(data.updated)) + ". TikTok requiere recolección." : "Aún no hay capturas guardadas."}</p></div><button data-action="assign" data-agent="recolector-tiktok" aria-label="Asignar recolección de métricas">${icon("arrow")}</button></div>
    <div class="queue-item"><span class="queue-icon">${icon("bot")}</span><div><h3>${pending ? num(pending) + " encargos en cola" : "Prepara un encargo para tus agentes"}</h3><p>Recolección y análisis con instrucciones propias.</p></div><button data-action="navigate" data-view="agents" aria-label="Ver agentes">${icon("arrow")}</button></div>
  </div><div class="queue-foot">Las evidencias indican archivos presentes; no equivalen a QA aprobado.</div></section></div>` +
      section(
        'En el estudio <span class="count">' + num(active.length) + "</span>",
        "Los proyectos más recientes, con sus portadas y evidencias.",
        `<a class="button subtle" href="/projects/mundo-hipotetico?view=videos">Ver todos los videos ${icon("arrow")}</a>`,
      ) +
      (active.length
        ? `<div class="strip">${active.slice(0, 4).map(videoCard).join("")}</div>`
        : empty(
            "No hay videos en producción",
            "Puedes comenzar con una idea de tu biblioteca.",
          )) +
      section(
        "Lo que cuentan tus videos",
        "Últimas tomas guardadas. Compara el alcance con el contexto de cada video.",
        `<a class="button subtle" href="/projects/mundo-hipotetico?view=analysis">Explorar análisis ${icon("arrow")}</a>`,
      ) +
      `<div class="insights-grid"><section class="panel"><div class="panel-heading"><div><h2>Alcance a una edad comparable</h2><p>Toma más cercana a 24 h, dentro de 15–30 h</p></div><span class="tag">TikTok</span></div><div class="statline"><div class="stat"><strong>${compact(visible.reduce((s, v) => s + (v.vistas ?? 0), 0))}</strong><small>Vistas acumuladas</small></div><div class="stat"><strong>${num(visible.length)}</strong><small>Videos con métricas</small></div><div class="stat"><strong>${num(data.videos.filter((v) => v.status === "Publicado").length)}</strong><small>Carpetas publicadas</small></div></div><div class="bar-chart">${age.map((v) => `<div class="bar-row"><span>${esc(v.video)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v.vistas_hora / max) * 100}%"></div></div><span class="value">${num(v.vistas_hora)}/h</span></div>`).join("") || '<p class="muted">Faltan tomas a una edad comparable.</p>'}</div><p class="chart-note">Las vistas acumuladas corresponden a videos de distintas edades. Las barras muestran vistas/hora desde la publicación, no crecimiento entre tomas.</p></section>
  <section class="panel reading"><div class="reading-icon">${icon("bulb")} <span class="tag">Lectura del analista · ${esc(date(data.interpretation.actualizado))}</span></div><h2>${esc(reading?.titulo || "La próxima decisión empieza con datos")}</h2><p>${esc(reading?.texto || "Registra métricas y asigna un análisis para encontrar oportunidades.")}</p>${reading ? `<div class="reading-action"><small>Para el siguiente video</small><p>${esc(reading.accion)}</p></div>` : ""}<a class="button subtle" href="/projects/mundo-hipotetico?view=results">Leer todas las conclusiones ${icon("arrow")}</a></section></div>`
    );
  }
  function videoLibrary() {
    const filter = params().get("status") || "Todos",
      all = data.videos.filter(match),
      videos = all.filter(
        (v) =>
          filter === "Todos" ||
          v.status === filter ||
          (filter === "Favoritos" && v.favorite),
      );
    return (
      heading(
        "Biblioteca de videos",
        "Tus mundos, sus archivos y el punto en el que se quedaron.",
        button(`${icon("download")} Exportar catálogo`, "export-videos"),
      ) +
      `<div class="toolbar"><div class="pills">${["Todos", "En producción", "Publicado", "Favoritos", "Descartado"].map((s) => `<button class="pill ${filter === s ? "active" : ""}" data-action="filter" data-key="status" data-value="${s}" aria-pressed="${filter === s}">${s}</button>`).join("")}</div><span class="results-count">${num(videos.length)} videos${query ? " para “" + esc(query) + "”" : ""}</span></div>` +
      (videos.length
        ? `<div class="strip library">${videos.map(videoCard).join("")}</div>`
        : empty(
            "No hay videos con ese filtro",
            "Prueba otra búsqueda o muestra todos los videos.",
            button("Restablecer filtros", "clear-filters"),
          ))
    );
  }
  function production() {
    const active = data.videos.filter(isActive).filter(match);
    const groups: [string, (v: WorldVideo) => boolean][] = [
      ["Por desarrollar", (v) => !v.checks[2]],
      ["En revisión", (v) => v.checks[2] && !v.checks[5]],
      ["Entrega disponible", (v) => v.checks[5]],
    ];
    return (
      heading(
        "La mesa de montaje",
        "Sigue cada proyecto por sus evidencias. El render solo se confirma con un archivo de entrega.",
        `<a class="button primary" href="/projects/mundo-hipotetico?view=create">${icon("plus")} Crear video</a>`,
      ) +
      sourceNote() +
      `<div class="pipeline">${groups
        .map(([name, test]) => {
          const vs = active.filter(test);
          return `<section class="pipeline-column"><h2 class="column-title">${name}<span>${num(vs.length)}</span></h2>${vs.map((v) => `<article class="pipeline-card"><h3>${esc(shortTitle(v))}</h3><p>${esc(date(v.date))} · ${num(v.scenes.length)} escenarios</p><div class="evidence">${v.checks.map((c) => `<span class="${c ? "done" : ""}"></span>`).join("")}</div><p style="margin-top:9px">${v.checks.filter(Boolean).length}/6 archivos o evidencias · Falta: ${esc(v.stage)}</p>${button("Revisar proyecto", "video", `data-id="${esc(v.id)}"`, "small")}</article>`).join("") || '<p class="status-text">No hay proyectos en esta etapa.</p>'}</section>`;
        })
        .join("")}</div>` +
      section(
        "Cómo se lee este tablero",
        "Guion y escenas detectados no garantizan una entrega revisada.",
      ) +
      `<div class="panel panel-pad"><p class="muted">Se comprueba la existencia de brief, guion, módulos de escena, portada, QA y MP4. Las entregas están fuera de Git: si el MP4 vive en tu PC con GPU o en Drive, aquí aparecerá pendiente hasta que esté disponible en esta máquina.</p></div>`
    );
  }
  function createVideo() {
    return (
      heading(
        "Un mundo por crear",
        "Empieza por la pregunta. Conserva el brief y prepara el proyecto cuando esté definido.",
      ) +
      `<div class="form-grid"><section class="panel panel-pad"><form id="brief-form" class="form-stack"><label for="brief-title">Pregunta del video<input id="brief-title" name="title" required maxlength="180" autocomplete="off" placeholder="¿Qué pasaría si la Tierra dejara de girar?…"></label><label for="brief-slug">Tema para la carpeta<input id="brief-slug" name="slug" required maxlength="80" pattern="[a-z0-9]+(-[a-z0-9]+)*" autocomplete="off" spellcheck="false" placeholder="tierra-sin-giro…"></label><label for="brief-text">Qué quieres contar<textarea id="brief-text" name="brief" required maxlength="8000" rows="7" placeholder="La premisa, el primer momento visual, el tono y lo que debe descubrir quien lo vea…"></textarea></label><p class="hint">Guardar conserva el brief en Second Brain. El proyecto se crea en Mundo Hipotético: copia el brief y úsalo allá.</p><p class="form-error" aria-live="polite"></p><div class="form-actions"><button class="button primary" type="submit">${icon("file")} Guardar brief</button>${button("Elegir una idea del canal", "ideas", "", "subtle")}</div></form></section>
  <aside class="brief-guide"><h2>Una pregunta.<br>Un mundo que cambia.</h2><p>La identidad del canal ya acompaña cada nuevo proyecto.</p><ol><li>La premisa se ve desde el cuadro 0.</li><li>La consecuencia cambia tu vida.</li><li>Los favoritos guían el look y las piezas.</li><li>El cierre deja una imagen para recordar.</li></ol><div class="specs"><div><strong>9:16</strong><small>Formato vertical</small></div><div><strong>30 FPS</strong><small>Movimiento continuo</small></div><div><strong>Abel</strong><small>Voz predeterminada</small></div><div><strong>Low poly</strong><small>Personajes del canal</small></div></div></aside></div>` +
      section(
        `Briefs guardados <span class="count">${num(data.state.briefs.length)}</span>`,
        "Los borradores permanecen en este proyecto entre sesiones.",
      ) +
      (data.state.briefs.length
        ? `<div class="panel">${data.state.briefs.map((b) => `<article class="brief-row"><div><h3>${esc(b.title)}</h3><p>${esc(b.brief)}</p><p>${esc(date(b.createdAt))} · ${esc(b.slug)}</p></div><div class="form-actions">${button(icon("copy"), "copy-brief", `data-id="${esc(b.id)}" aria-label="Copiar brief"`, "small")}</div></article>`).join("")}</div>`
        : empty(
            "Aquí empieza tu siguiente video",
            "Guarda un brief para conservar la idea y preparar sus archivos.",
          ))
    );
  }
  function metricTable(
    rows: WorldMetric[],
    sortKey: SortableMetric = "vistas_dia",
  ) {
    return `<div class="table-wrap"><table><caption class="sr-only">Métricas de TikTok por video, última toma guardada</caption><thead><tr><th>Video</th><th class="number">Vistas</th><th class="number">Edad</th><th class="number">Vistas/día</th><th class="number">Sigue a 3 s</th><th class="number">Completo</th><th class="number">Comp. + guard. / mil</th></tr></thead><tbody>${[
      ...rows,
    ]
      .sort((a, b) => (b[sortKey] ?? -1) - (a[sortKey] ?? -1))
      .map(
        (m) =>
          `<tr><td><span class="table-title">${esc(m.video)}</span><small>#${m.num} · ${esc(m.plantilla)}</small></td><td class="number">${num(m.vistas)}</td><td class="number">${num(m.edad_h, 1)} h</td><td class="number">${num(m.vistas_dia)}</td><td class="number">${num(m.pct_sigue_3s, 1)}${m.pct_sigue_3s != null ? " %" : ""}</td><td class="number">${num(m.pct_completo, 1)}${m.pct_completo != null ? " %" : ""}</td><td class="number">${num(m.comp_guard_x1000, 1)}</td></tr>`,
      )
      .join("")}</tbody></table></div>`;
  }
  function retentionChart() {
    const selected = params().get("retention") || "all";
    let series = [...new Set(data.retention.map((r) => r.num))];
    if (selected !== "all")
      series = series.filter((n) => String(n) === selected);
    else series = series.slice(0, 4);
    const maxX = Math.max(
      1,
      ...data.retention.filter((r) => series.includes(r.num)).map((r) => r.seg),
    );
    const colors = ["#315b9c", "#b45a7e", "#449380", "#9c7b38"];
    return `<div class="retention-wrap"><svg class="retention-chart" viewBox="0 0 620 250" role="img" aria-label="Retención de audiencia por segundo. Las curvas corresponden a las últimas tomas guardadas, sin igualar edad.">${[0, 25, 50, 75, 100].map((p) => `<line x1="42" x2="600" y1="${210 - p * 1.85}" y2="${210 - p * 1.85}" stroke="#e1e7ef"/><text x="3" y="${214 - p * 1.85}">${p}%</text>`).join("")}${[0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${42 + f * 558}" y="238" text-anchor="middle">${num(maxX * f)} s</text>`).join("")}${series
      .map((id, i) => {
        const points = data.retention
          .filter((r) => r.num === id)
          .sort((a, b) => a.seg - b.seg);
        return `<polyline fill="none" stroke="${colors[i % colors.length]}" stroke-width="2.5" points="${points.map((r) => `${42 + (r.seg / maxX) * 558},${210 - r.pct * 1.85}`).join(" ")}"/>${points.map((r) => `<circle cx="${42 + (r.seg / maxX) * 558}" cy="${210 - r.pct * 1.85}" r="3" fill="${colors[i % colors.length]}"><title>${esc(r.video)}: ${r.seg} s, ${r.pct}% · ${esc(r.fecha_toma)}</title></circle>`).join("")}`;
      })
      .join(
        "",
      )}</svg></div><div class="chart-legend">${series.map((id, i) => `<span><i style="background:${colors[i % colors.length]}"></i>${esc(data.retention.find((r) => r.num === id)?.video)}</span>`).join("")}</div>`;
  }
  function analysis() {
    const include = params().get("hidden") === "true",
      sort = params().get("sort") || "vistas_dia";
    const allowed: string[] = [
      "vistas_dia",
      "vistas",
      "pct_completo",
      "comp_guard_x1000",
    ];
    const rows = data.metrics.filter(
      (m) =>
        (include || !m.oculto) &&
        (!query || m.video.toLowerCase().includes(query.toLowerCase())),
    );
    const ret = params().get("retention") || "all";
    return (
      heading(
        "Cada vista tiene contexto",
        "Compara el alcance, la retención y las señales que merecen otra prueba.",
        button(`${icon("download")} Exportar métricas`, "export-metrics"),
      ) +
      sourceNote() +
      `<div class="toolbar"><div class="inline-row"><label for="metric-sort">Ordenar por<select id="metric-sort" name="sort" data-filter="sort">${[
        ["vistas_dia", "Vistas por día"],
        ["vistas", "Vistas totales"],
        ["pct_completo", "Finalización"],
        ["comp_guard_x1000", "Compartidos + guardados"],
      ]
        .map(
          ([v, l]) =>
            `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`,
        )
        .join(
          "",
        )}</select></label><label for="hidden-videos" class="switch-row"><input type="checkbox" id="hidden-videos" name="hidden" ${include ? "checked" : ""}> Incluir videos ocultos</label></div></div>` +
      (rows.length
        ? `<section class="panel">${metricTable(rows, (allowed.includes(sort) ? sort : "vistas_dia") as SortableMetric)}</section>`
        : empty(
            "No hay métricas para esta búsqueda",
            "Los valores vacíos se conservan como desconocidos.",
          )) +
      section(
        "Dónde se queda la audiencia",
        "Curvas de la última toma por video. Las edades pueden ser distintas.",
      ) +
      `<section class="panel"><div class="panel-heading"><div><h2>Retención por segundo</h2><p>Inspecciona puntos y abre la tabla para ver los valores.</p></div><label class="sr-only" for="retention-video">Video de retención</label><select id="retention-video" name="retention" data-filter="retention"><option value="all">Primeras 4 curvas</option>${[...new Set(data.retention.map((r) => r.num))].map((id) => `<option value="${id}" ${String(id) === ret ? "selected" : ""}>${esc(data.retention.find((r) => r.num === id)!.video)}</option>`).join("")}</select></div>${data.retention.length ? retentionChart() : '<p class="charts-empty">No hay curvas de retención registradas.</p>'}<details class="hypothesis"><summary>Ver valores y fechas de las curvas</summary><div class="table-wrap"><table><thead><tr><th>Video</th><th class="number">Segundo</th><th class="number">Sigue viendo</th><th>Fecha de toma</th></tr></thead><tbody>${data.retention
        .filter((r) => ret === "all" || String(r.num) === ret)
        .map(
          (r) =>
            `<tr><td>${esc(r.video)}</td><td class="number">${r.seg}</td><td class="number">${num(r.pct, 1)} %</td><td>${esc(date(r.fecha_toma))}</td></tr>`,
        )
        .join("")}</tbody></table></div></details></section>` +
      section(
        "Comparación a una edad parecida",
        "Tomas entre 15 y 30 horas. La edad exacta importa.",
      ) +
      `<section class="panel"><div class="table-wrap"><table><thead><tr><th>Video</th><th class="number">Edad de la toma</th><th class="number">Vistas</th><th class="number">Vistas/hora desde publicación</th></tr></thead><tbody>${data.sameAge
        .filter((m) => include || !m.oculto)
        .map(
          (m) =>
            `<tr><td>${esc(m.video)}</td><td class="number">${num(m.edad_h, 1)} h</td><td class="number">${num(m.vistas)}</td><td class="number">${num(m.vistas_hora)}</td></tr>`,
        )
        .join("")}</tbody></table></div></section>`
    );
  }
  function results() {
    const f = params().get("confidence") || "todas";
    const rows = data.interpretation.filas.filter(
      (r) => f === "todas" || r.confianza === f,
    );
    return (
      heading(
        "De los números a las decisiones",
        "La lectura del analista, con su confianza y una acción concreta.",
        button(
          `${icon("bot")} Encargar un análisis`,
          "assign",
          'data-agent="analista"',
        ),
      ) +
      `<div class="source-note"><span>${icon("bulb")} Interpretación escrita el ${esc(date(data.interpretation.actualizado, { year: "numeric" }))}. Muestra declarada: ${num(data.interpretation.videos_con_analiticas)} videos.</span><span>Pistas, no reglas</span></div><div class="toolbar"><div class="pills">${[
        ["todas", "Todas las lecturas"],
        ["alta", "Confianza alta"],
        ["media", "Confianza media"],
        ["baja", "Confianza baja"],
      ]
        .map(
          ([v, l]) =>
            `<button class="pill ${f === v ? "active" : ""}" data-action="filter" data-key="confidence" data-value="${v}" aria-pressed="${f === v}">${l}</button>`,
        )
        .join("")}</div></div>` +
      (rows.length
        ? `<div class="reading-list">${rows.map((r) => `<article class="reading-item"><span class="tag ${r.confianza === "baja" ? "low" : ""}">Confianza ${esc(r.confianza)}</span><h2>${esc(r.titulo)}</h2><p>${esc(r.texto)}</p><div class="reading-action"><small>Qué probar ahora</small><p>${esc(r.accion)}</p></div></article>`).join("")}</div>`
        : empty(
            "No hay lecturas con esta confianza",
            "Selecciona otro nivel para ver la interpretación disponible.",
          )) +
      section(
        "Hipótesis del canal",
        `${num(data.hypotheses.length)} pistas registradas. Abre una para revisar la evidencia.`,
      ) +
      `<section class="panel">${data.hypotheses.map((h) => `<details class="hypothesis"><summary><strong>${esc(h.id)}</strong><span>${esc(h.hipotesis)}</span><span class="tag">${esc(h.estado)}</span></summary><div class="hypothesis-body"><p><strong>Cómo se mide:</strong> ${esc(h.se_mide)}</p><p><strong>A favor:</strong> ${esc(h.a_favor)}</p><p><strong>En contra:</strong> ${esc(h.en_contra)}</p><p><strong>Lectura:</strong> ${esc(h.estado_texto)}</p></div></details>`).join("")}</section>`
    );
  }
  function agents() {
    return (
      heading(
        "Tu equipo de agentes",
        "Configura instrucciones, asigna encargos y consulta lo que realmente se ejecutó.",
        button(`${icon("plus")} Nuevo encargo`, "assign"),
      ) +
      `<div class="source-note"><span>${icon("bot")} Encargos persistentes. Cópialos y ejecútalos en Mundo Hipotético.</span>${button("Ver configuración", "navigate", 'data-view="settings"', "subtle small")}</div>` +
      `<div class="agents-grid">${data.agents.map((a) => `<article class="agent-card"><div class="agent-top"><span class="agent-avatar">${icon(a.id.includes("analista") ? "chart" : "bot")}</span><h2>${esc(a.name)}</h2><span class="badge ${a.enabled ? "published" : "stopped"}">${a.enabled ? "Disponible" : "Pausado"}</span></div><p>${esc(a.description)}</p><p>${num(data.state.tasks.filter((t) => t.agentId === a.id && t.status === "queued").length)} encargos en cola</p><div class="form-actions">${button("Asignar encargo", "assign", `data-agent="${esc(a.id)}" ${!a.enabled ? "disabled" : ""}`, "primary small")}${button("Configurar", "agent-config", `data-id="${esc(a.id)}"`, "small")}${button("Leer instrucciones", "document", `data-path="${esc(a.source)}"`, "subtle small")}</div></article>`).join("")}</div>` +
      section(
        `Encargos <span class="count">${num(data.state.tasks.length)}</span>`,
        "En cola significa guardado, pendiente de ejecución o de trabajo manual.",
      ) +
      (data.state.tasks.length
        ? `<section class="panel">${data.state.tasks.map((t) => `<article class="task-item"><div><h3>${esc(t.instruction)}</h3><p>${badge(t.status)}${t.completionSource === "manual" ? "Resuelto manualmente · " : ""}${esc(t.agentId)} · ${esc(date(t.createdAt))}${t.videoId ? " · " + esc(shortTitle(data.videos.find((v) => v.id === t.videoId) || { title: t.videoId })) : ""}</p></div><div class="form-actions">${button(`${icon("copy")} Copiar encargo`, "copy-task", `data-id="${esc(t.id)}"`, "small")}${t.status === "queued" ? button("Marcar resuelto", "task-complete", `data-id="${esc(t.id)}"`, "small") : ""}${t.status === "queued" ? button("Cancelar", "task-cancel", `data-id="${esc(t.id)}"`, "subtle small") : ""}</div></article>`).join("")}</section>`
        : empty(
            "Sin encargos pendientes",
            "Asigna una recolección o un análisis. El panel conservará el objetivo y el video.",
          ))
    );
  }
  function settings() {
    return (
      heading(
        "Un panel que sigue tu ritmo",
        "Actualización, fuentes y capacidades del estudio.",
      ) +
      `<div class="settings-stack"><section class="panel panel-pad"><h2>Actualización del panel</h2><label class="switch-row" for="auto-refresh"><span>Revisar el paquete cada 15 segundos<small class="muted" style="display:block;margin-top:7px">Se pausa cuando la pestaña está oculta. No consulta redes ni ejecuta agentes.</small></span><input id="auto-refresh" type="checkbox" name="autoRefresh" ${autoRefresh ? "checked" : ""}></label></section><section class="panel panel-pad"><h2>Fuentes de información</h2><p>El panel lee un paquete de datos que publica el canal con <code>npm run publicar:panel</code>. Última publicación: ${esc(date(data.scannedAt))}. Briefs, encargos y notas de agentes se guardan en Second Brain.</p><div class="form-actions" style="margin-top:18px">${button(`${icon("download")} Respaldar estado`, "export-state")}</div></section><section class="panel panel-pad"><h2>Producción</h2><p>Este panel solo consulta. Crear, verificar y renderizar videos se hace en el repositorio Mundo Hipotético, en tu PC.</p></section><section class="panel panel-pad"><h2>Diseño del canal</h2><p>Lexend y Source Serif 4, portadas originales y la paleta Noche, Cielo y Rosa. Skills instaladas: Frontend Design, Web Design Guidelines, UI/UX Pro Max y React Best Practices.</p></section></div>`
    );
  }
  function render() {
    if (!data) return;
    const current = view();
    $("#breadcrumb").textContent = names[current];
    $("#nav").innerHTML = navigation
      .map(
        ([id, i, label]) =>
          `<a href="/projects/mundo-hipotetico?view=${id}" class="nav-link ${current === id ? "active" : ""}" ${current === id ? 'aria-current="page"' : ""}>${icon(i)}${label}${id === "production" ? `<span class="nav-count">${data.videos.filter(isActive).length}</span>` : ""}${id === "agents" && data.state.tasks.some((t) => t.status === "queued") ? `<span class="nav-count">${data.state.tasks.filter((t) => t.status === "queued").length}</span>` : ""}</a>`,
      )
      .join("");
    $("#settings-link").classList.toggle("active", current === "settings");
    const pages: Record<string, () => string> = {
      overview,
      videos: videoLibrary,
      production,
      create: createVideo,
      analysis,
      results,
      agents,
      settings,
    };
    $("#main").innerHTML = pages[current]();
    updateSync();
  }
  function updateSync() {
    if (!data) return;
    $("#sync-label").textContent =
      `Archivos leídos ${date(data.scannedAt, { hour: "numeric", minute: "2-digit", second: "2-digit" })} · Métricas del ${date(data.updated)}`;
  }
  const discardChanges = async (text: string) =>
    (await confirmDecision(text, {
      confirmLabel: "Descartar cambios",
      danger: true,
    })) && !control.signal.aborted;
  async function navigate(
    next: string | undefined,
    options: Record<string, string> = {},
  ) {
    if (
      hasUnsavedForm() &&
      !(await discardChanges(
        "Hay cambios sin guardar. ¿Quieres salir de este formulario?",
      ))
    )
      return false;
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("view", String(next));
    for (const [key, value] of Object.entries(options))
      url.searchParams.set(key, value);
    history.pushState({}, "", url);
    query = options.q || "";
    $("#search").value = query;
    render();
    window.scrollTo({ top: 0 });
    return true;
  }
  function setFilter(key: string | undefined, value: string | undefined) {
    const url = new URL(location.href);
    url.searchParams.set(String(key), String(value));
    history.replaceState({}, "", url);
    render();
  }
  const api = (path: string, body?: unknown) => apiBase(path, body);
  let lastSignature = "";
  async function load(force = false) {
    if (loading) return;
    loading = true;
    try {
      const result = (await api("/world/overview")) as WorldData;
      const signature = JSON.stringify({ ...result, scannedAt: undefined });
      data = result;
      if (force || signature !== lastSignature) {
        lastSignature = signature;
        if (!dialog().open && !hasUnsavedForm()) render();
      }
      updateSync();
    } catch (e) {
      if (!data)
        $("#main").innerHTML =
          `<div class="error-panel"><h2>No se pudo abrir el estudio</h2><p>${esc(message(e))}</p>${button("Volver a intentar", "refresh")}</div>`;
      else toast(message(e));
    } finally {
      loading = false;
    }
  }
  function toast(text: string) {
    $("#toast").textContent = text;
    $("#toast").classList.add("toast-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(
      () => $("#toast").classList.remove("toast-visible"),
      6000,
    );
  }
  function openDialog(title: string, subtitle: string, content: string) {
    $("#dialog-body").innerHTML =
      `<div class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ""}</div><button class="icon-button" data-action="close" aria-label="Cerrar ventana">${icon("close")}</button></div><div class="dialog-content">${content}</div>`;
    if (!dialog().open) dialog().showModal();
  }
  function videoDetails(id: string | undefined) {
    const v = data.videos.find((v) => v.id === id);
    if (!v) return toast("Actualiza el panel para encontrar este proyecto.");
    openDialog(
      shortTitle(v),
      "Proyecto del " + date(v.date),
      `<div class="details-grid"><div>${poster(v, "details-poster", true)}</div><div>${badge(v.status)}<ul class="checklist">${data.stages.map((s, i) => `<li><span class="check ${v.checks[i] ? "done" : ""}" aria-hidden="true">${v.checks[i] ? "✓" : "·"}</span>${esc(s)}: ${v.checks[i] ? "evidencia presente" : "pendiente"}</li>`).join("")}</ul><p class="muted">Estas comprobaciones detectan archivos; abre el QA para conocer su resultado. Los MP4 se quedan en tu PC.</p><div class="form-actions" style="margin-top:17px">${button("Asignar agente", "assign", `data-video="${esc(v.id)}"`, "small")}</div></div></div><div class="document-links">${v.files.map((f) => button(`${icon("file")} ${esc(f)}`, "document", `data-path="${esc(v.id + "/" + f)}"`, "small")).join("")}</div>${!v.modular ? '<p class="notice">Video del motor anterior. Conserva sus documentos originales.</p>' : ""}<p class="doc-path">${esc(v.id)}</p>${v.scenes.length ? `<p class="doc-path">Escenarios: ${v.scenes.map((s) => esc(s.id) + (s.exists ? "" : " (módulo pendiente)")).join(", ")}</p>` : ""}`,
    );
  }
  async function documentDialog(path: string) {
    const doc = (await api(
      "/world/document?path=" + encodeURIComponent(path),
    )) as { path: string; text: string };
    openDialog(
      path.split("/").at(-1)!,
      doc.path,
      `<pre>${esc(doc.text)}</pre>`,
    );
  }
  function assignDialog(agentId?: string, videoId?: string) {
    const enabled = data.agents.filter((a) => a.enabled);
    if (!enabled.length)
      return toast("Activa un agente para crear un encargo.");
    openDialog(
      "Un encargo claro, un mejor resultado",
      "Se guarda en la cola. La ejecución se inicia por separado.",
      `<form id="task-form" class="form-stack"><label for="task-agent">Agente<select id="task-agent" name="agentId">${enabled.map((a) => `<option value="${esc(a.id)}" ${a.id === agentId ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label><label for="task-video">Video<select id="task-video" name="videoId"><option value="">Canal completo</option>${data.videos
        .filter((v) => v.status !== "Descartado")
        .map(
          (v) =>
            `<option value="${esc(v.id)}" ${v.id === videoId ? "selected" : ""}>${esc(shortTitle(v))}</option>`,
        )
        .join(
          "",
        )}</select></label><label for="task-instruction">Objetivo del encargo<textarea id="task-instruction" name="instruction" required maxlength="8000" rows="5" placeholder="Qué debe revisar, qué archivos debe entregar y cómo sabrás que terminó…">${agentId === "recolector-tiktok" ? "Recopila las métricas actuales de los videos publicados desde TikTok Studio. Conserva vacíos los datos no disponibles, registra fecha y fuente y no publiques ni cambies contenido." : agentId === "analista" ? "Analiza las últimas tomas guardadas, compara a la misma edad y entrega recomendaciones con evidencia y nivel de confianza. Indica qué datos faltan." : ""}</textarea></label><p class="form-error" aria-live="polite"></p><button class="button primary" type="submit">Guardar encargo</button></form>`,
    );
  }
  function agentConfig(id: string | undefined) {
    const a = data.agents.find((a) => a.id === id);
    if (!a) return;
    openDialog(
      "Configurar " + a.name,
      "Las instrucciones base se conservan; estas notas acompañan los nuevos encargos.",
      `<form id="agent-form" data-id="${esc(a.id)}" class="form-stack"><label class="switch-row" for="agent-enabled"><span>Disponible para nuevos encargos</span><input id="agent-enabled" name="enabled" type="checkbox" ${a.enabled ? "checked" : ""}></label><label for="agent-notes">Instrucciones adicionales<textarea id="agent-notes" name="notes" maxlength="8000" rows="6" placeholder="Prioridades o criterios para este agente…">${esc(a.notes)}</textarea></label><p class="form-error" aria-live="polite"></p><button class="button primary" type="submit">Guardar configuración</button></form>`,
    );
  }
  function exportJson(name: string, value: unknown) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast("Archivo exportado.");
  }
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast("Copiado al portapapeles.");
    } catch {
      openDialog(
        "Copia el texto",
        "Selecciona el contenido para copiarlo.",
        `<textarea rows="12" aria-label="Texto para copiar" readonly>${esc(value)}</textarea>`,
      );
    }
  }
  function taskPrompt(t: WorldTask) {
    return `Lee AGENTS.md y .claude/agents/${t.agentId}.md.\n\n${t.instruction}\n\nVideo: ${t.videoId || "Canal completo"}\nNotas: ${data.agents.find((a) => a.id === t.agentId)?.notes || "Sin notas adicionales"}`;
  }
  // A missing record throws inside the action; the click handler shows it.
  const actions: Record<string, Action> = {
    close: async () => {
      if (
        hasUnsavedDialog() &&
        !(await discardChanges("Hay cambios sin guardar. ¿Quieres cerrar?"))
      )
        return;
      dialog().close();
    },
    refresh: () => load(true),
    create: () => navigate("create"),
    navigate: (b) => navigate(b.dataset.view),
    video: (b) => videoDetails(b.dataset.id),
    filter: (b) => setFilter(b.dataset.key, b.dataset.value),
    "clear-filters": () => navigate("videos"),
    document: (b) => documentDialog(b.dataset.path!),
    assign: (b) => assignDialog(b.dataset.agent, b.dataset.video),
    "agent-config": (b) => agentConfig(b.dataset.id),
    "copy-task": (b) => {
      const t = data.state.tasks.find((t) => t.id === b.dataset.id);
      return copy(taskPrompt(t!));
    },
    "task-complete": async (b) => {
      await api("/world/tasks/status", {
        id: b.dataset.id,
        status: "completed",
      });
      await load(true);
      toast("Encargo marcado como resuelto manualmente.");
    },
    "task-cancel": (b) =>
      openDialog(
        "Cancelar encargo",
        "El encargo quedará registrado como cancelado.",
        `<p>El encargo se conserva en el historial.</p><div class="form-actions" style="margin-top:20px">${button("Conservar encargo", "close")}${button("Cancelar encargo", "confirm-cancel", `data-id="${esc(b.dataset.id)}"`, "danger")}</div>`,
      ),
    "confirm-cancel": async (b) => {
      await api("/world/tasks/status", {
        id: b.dataset.id,
        status: "cancelled",
      });
      dialog().close();
      await load(true);
      toast("Encargo cancelado.");
    },
    "copy-brief": (b) => {
      const brief = data.state.briefs.find((x) => x.id === b.dataset.id)!;
      return copy(`# ${brief.title}\n\n${brief.brief}`);
    },
    "export-videos": () =>
      exportJson("mundo-hipotetico-catalogo.json", data.videos),
    "export-metrics": () =>
      exportJson("mundo-hipotetico-metricas.json", {
        updated: data.updated,
        videos: data.metrics,
        retention: data.retention,
        sameAge: data.sameAge,
      }),
    "export-state": () =>
      exportJson("mundo-hipotetico-respaldo-panel.json", data.state),
    ideas: () =>
      openDialog(
        "Ideas del canal",
        `${data.ideas.length} entradas de pendientes y tendencias. Elige una como punto de partida.`,
        `<div class="form-stack">${data.ideas.map((i, index) => `<div><h3>${esc(i.title)}</h3><p class="muted">#${i.num} · ${esc(i.source)}</p>${button("Usar esta idea", "use-idea", `data-index="${index}"`, "small")}</div>`).join("") || "<p>No hay ideas disponibles.</p>"}</div>`,
      ),
    "use-idea": async (b) => {
      const idea = data.ideas[Number(b.dataset.index)];
      dialog().close();
      if (view() !== "create" && !(await navigate("create"))) return;
      $("#brief-title").value = idea.title;
      $("#brief-slug").value = slugify(idea.title);
      $("#brief-text").value =
        `Idea #${idea.num}, tomada de ${idea.source}.\n\nPremisa: ${idea.title}\n\nDesarrollar el primer momento visual, consecuencias y cierre siguiendo los favoritos del canal.`;
      $("#brief-form").dataset.dirty = "true";
      $("#brief-text").focus();
    },
  };
  function slugify(value: string) {
    return value
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/^¿?que pasaria si\s*/, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 70)
      .replace(/-$/, "");
  }
  function hasUnsavedDialog() {
    return !!$('#dialog form[data-dirty="true"]');
  }
  function hasUnsavedForm() {
    return !!$('#main form[data-dirty="true"]');
  }
  on(root, "click", async (event: MouseEvent) => {
    const b = target(event).closest<HTMLButtonElement>("[data-action]");
    if (b) {
      const action = actions[b.dataset.action!];
      if (!action) return;
      b.disabled = true;
      try {
        await action(b);
      } catch (e) {
        toast(message(e));
      } finally {
        b.disabled = false;
      }
      return;
    }
    const a = target(event).closest<HTMLAnchorElement>(
      'a[href^="/projects/mundo-hipotetico?view="]',
    );
    if (
      a &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      event.button === 0
    ) {
      event.preventDefault();
      navigate(new URL(a.href).searchParams.get("view") ?? undefined);
    }
  });
  on(root, "change", (event) => {
    const field = target(event);
    if (field.dataset.filter) setFilter(field.dataset.filter, field.value);
    if (field.id === "hidden-videos")
      setFilter("hidden", String(field.checked));
    if (field.id === "auto-refresh") {
      autoRefresh = field.checked;
      try {
        localStorage.setItem("mh-panel-auto", String(autoRefresh));
      } catch {}
      toast(
        autoRefresh
          ? "Actualización automática activada."
          : "Actualización manual activada.",
      );
    }
    const changed = field.closest("form");
    if (changed) changed.dataset.dirty = "true";
  });
  on(root, "input", (event) => {
    const field = target(event);
    const form = field.closest("form");
    if (form) form.dataset.dirty = "true";
    if (field.id === "brief-title" && !$("#brief-slug").dataset.edited)
      $("#brief-slug").value = slugify(field.value);
    if (field.id === "brief-slug") field.dataset.edited = "true";
  });
  on(root, "submit", async (event) => {
    const form = event.target as HTMLFormElement;
    if (!["brief-form", "task-form", "agent-form"].includes(form.id)) return;
    event.preventDefault();
    const submit = form.querySelector<HTMLButtonElement>('[type="submit"]')!,
      label = submit.innerHTML;
    const error = form.querySelector<HTMLElement>(".form-error")!;
    submit.disabled = true;
    submit.textContent = "Guardando…";
    error.textContent = "";
    try {
      const values = Object.fromEntries(new FormData(form));
      if (form.id === "brief-form") {
        await api("/world/briefs", values);
        form.reset();
        delete $("#brief-slug").dataset.edited;
        toast("Brief guardado.");
      }
      if (form.id === "task-form") {
        await api("/world/tasks", values);
        dialog().close();
        toast("Encargo guardado en la cola.");
      }
      if (form.id === "agent-form") {
        await api("/world/agents", {
          id: form.dataset.id,
          enabled: (form.elements.namedItem("enabled") as HTMLInputElement)
            .checked,
          notes: values.notes,
        });
        dialog().close();
        toast("Configuración guardada.");
      }
      delete form.dataset.dirty;
      await load(true);
    } catch (e) {
      error.textContent = message(e);
      error.setAttribute("tabindex", "-1");
      error.focus();
    } finally {
      submit.disabled = false;
      submit.innerHTML = label;
    }
  });
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  $("#search").value = query;
  $("#search").addEventListener("input", (event) => {
    query = target(event).value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      if (!data) return;
      if (!["videos", "production", "analysis"].includes(view()))
        navigate("videos", { q: query });
      else {
        const url = new URL(location.href);
        if (query) url.searchParams.set("q", query);
        else url.searchParams.delete("q");
        history.replaceState({}, "", url);
        render();
      }
    }, 180);
  });
  on(document, "keydown", (event: KeyboardEvent) => {
    if (
      event.key === "/" &&
      !["INPUT", "TEXTAREA", "SELECT"].includes(target(event).tagName) &&
      !dialog().open
    ) {
      event.preventDefault();
      $("#search").focus();
    }
  });
  on(dialog(), "cancel", (event) => {
    if (!hasUnsavedDialog()) return;
    event.preventDefault();
    void actions.close(dialog());
  });
  on(window, "beforeunload", (event: BeforeUnloadEvent) => {
    if (hasUnsavedForm() || hasUnsavedDialog()) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  on(window, "popstate", () => {
    query = params().get("q") || "";
    $("#search").value = query;
    render();
  });
  $("#refresh").innerHTML = icon("refresh");
  $("#refresh").dataset.action = "refresh";
  $("#new-video").innerHTML = icon("plus") + " Nuevo brief";
  $("#new-video").dataset.action = "create";
  $("#search-icon").innerHTML = icon("search");
  $("#settings-link").innerHTML = icon("settings") + " Preferencias";
  (async () => {
    try {
      await load(true);
      // Closed while the first load was in flight: the cleanup already ran.
      if (control.signal.aborted) return;
      pollTimer = setInterval(() => {
        if (autoRefresh && !document.hidden) load();
      }, 15000);
    } catch (e) {
      if (control.signal.aborted) return;
      $("#main").innerHTML =
        `<div class="error-panel"><h2>No se pudo conectar con el servidor</h2><p>${esc(message(e))}</p>${button("Volver a intentar", "refresh")}</div>`;
    }
  })();

  return () => {
    control.abort();
    clearInterval(pollTimer);
  };
}
