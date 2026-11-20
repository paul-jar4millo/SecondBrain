// Static HUD of the refuge: the markup mounted over the canvas.
import { ZONES, zoneGuide } from "./room-life";
import { QUALITY_LABELS } from "./room-quality";

export const esc = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const icon = (paths: string, transform = "") =>
  `<svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><g transform="${transform}">${paths}</g></svg>`;
export const ICONS = {
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

// "a la Terraza", "al Café".
export const toPlace = (zone: { place: string } = ZONES[0]) =>
  zone.place.startsWith("el ")
    ? `al ${zone.place.slice(3)}`
    : `a ${zone.place}`;

// Same 32 x 24 plan as the painted floor, so the minimap reads as the place itself.
const MAP_ART = `<svg class="map-art" viewBox="-16 -12 32 24" aria-hidden="true"><rect x="-16" y="-12" width="32" height="24" fill="#cfe6ff"/><rect x="-16" y="-12" width="11" height="13" fill="#1e2f85"/><rect x="-16" y="1" width="11" height="11" fill="#131d5e"/><rect x="-5" y="-12" width="10" height="8.5" fill="#f1f7ff"/><rect x="5" y="-12" width="11" height="11.5" fill="#0e6f92"/><rect x="8" y="-12" width="4" height="11.5" fill="#bfe6f2"/><circle cx="0" cy="4" r="7" fill="#2340c8"/><circle cx="0" cy="4" r="4.6" fill="#1a2a78"/><circle cx="0" cy="4" r="1.7" fill="#e7f0ff"/><circle cx="-9" cy="6" r="4" fill="#0a1238"/><circle cx="-9" cy="6" r="1.3" fill="#2f66e6"/><circle cx="12" cy="4" r="2.8" fill="#3f8ff0"/><rect x="-16" y="-12" width="32" height="24" fill="none" stroke="#f1f7ff" stroke-width=".5"/></svg>`;

export const CANVAS_LABEL =
  "Refugio 3D. Clic o toque en el suelo para caminar; WASD o flechas; E para interactuar; Esc cierra el panel abierto; rueda para zoom; arrastra con el botón derecho para girar.";

/** Position of a world point on the 32 x 24 minimap, in percent. */
export const mapPercent = (x: number, z: number) => ({
  left: `${((x + 16) / 32) * 100}%`,
  top: `${((z + 12) / 24) * 100}%`,
});

export function roomMarkup({
  compact,
  savedQuality,
  volume,
}: {
  compact: boolean;
  savedQuality: string;
  volume: number;
}) {
  return `<canvas tabindex="0" aria-label="${CANVAS_LABEL}"></canvas>
    <button class="room-help-trigger" id="room-help-button" aria-expanded="false" aria-controls="room-help">Ayuda</button><div class="room-location"><h1 id="room-zone">Terraza</h1></div>
    <div class="room-clock"><svg class="moon-dial" viewBox="0 0 64 64" aria-hidden="true"><circle class="dial-track" cx="32" cy="32" r="26"/><g id="room-orbit"><path class="dial-moon" d="M32 0a6.4 6.4 0 1 0 5.3 10 5 5 0 1 1-5.3-10z"/></g><path class="dial-gem" d="M32 20 42 32 32 44 22 32z"/><path class="dial-gem-lit" d="M32 20 42 32H22z"/></svg><span><b id="room-time"></b><small id="room-date"></small></span></div>
    <div class="room-loading"><p id="room-loading-text" role="status">Preparando el refugio…</p><div class="room-progress"><progress id="room-progress" max="100" value="0" aria-label="Carga del refugio"></progress><span id="room-progress-value" aria-hidden="true">0 %</span></div><button type="button" id="room-retry" hidden>Reintentar</button></div>
    <div class="room-side">
      <div class="team-shortcuts"><button class="team-toggle" aria-haspopup="dialog">Threads <span>4</span></button><button class="team-collapse" aria-label="${compact ? "Mostrar personajes" : "Ocultar personajes"}" aria-expanded="${!compact}" aria-controls="room-team">${ICONS.chevron}</button></div>
      <aside class="room-team ${compact ? "collapsed" : ""}" id="room-team" aria-label="Cuatro agentes base">
        <h2 class="team-heading">Tu equipo</h2>
        <div id="room-roster"></div>
      </aside>
      <div class="room-camera" role="group" aria-label="Cámara"><button data-camera="out" aria-label="Alejar cámara">${ICONS.minus}</button><button data-camera="in" aria-label="Acercar cámara">${ICONS.plus}</button><button data-camera="left" aria-label="Girar a la izquierda">${ICONS.rotateLeft}</button><button data-camera="right" aria-label="Girar a la derecha">${ICONS.rotateRight}</button><button data-camera="home" aria-label="Centrar cámara en ti">Centrar</button></div>
    </div>

    <div class="room-map"><div class="map-title"><b>Mapa del refugio</b><button id="map-toggle" aria-expanded="${!compact}" aria-controls="map-body">${compact ? "Mostrar" : "Ocultar"}</button></div><div id="map-body" ${compact ? "hidden" : ""}><div class="map-stage"><div class="map-zones" id="map-zones">${MAP_ART}${ZONES.map((z) => `<button data-zone="${z.id}" style="left:${((z.x + 16) / 32) * 100}%;top:${((z.z + 12) / 24) * 100}%" title="Ir ${toPlace(z)} · ${esc(z.toolName)}"><span>${esc(z.name)}</span></button>`).join("")}<i class="map-player" aria-label="Tu posición"></i></div></div></div></div>
    <div class="room-help" id="room-help" role="dialog" aria-labelledby="room-help-title" hidden><b id="room-help-title">Muévete a tu ritmo</b><p>Clic o toque en el suelo, o <kbd>WASD</kbd> / flechas, para caminar. Si el punto está ocupado, vas al lugar libre más cercano.</p><p>Cerca de una agente, <kbd>E</kbd> o el aviso inferior abre su ficha. Cada zona abre su herramienta: ${esc(zoneGuide())}. También están en el HUD inferior.</p><p>Rueda o + / − para zoom. Arrastra con el botón derecho para girar. En pantalla táctil, dos dedos para zoom y giro.</p><p><kbd>Esc</kbd> cierra el panel abierto. <kbd>Ctrl K</kbd> busca y <kbd>N</kbd> crea.</p><label class="room-quality" for="room-quality">Calidad gráfica<select id="room-quality">${["auto", "alta", "media", "baja"].map((v) => `<option value="${v}" ${v === savedQuality ? "selected" : ""}>${QUALITY_LABELS[v as keyof typeof QUALITY_LABELS]}</option>`).join("")}</select></label><p class="room-quality-note" id="room-quality-note"></p><label class="room-volume" for="room-volume">Sonido del refugio <input id="room-volume" type="range" min="0" max="100" step="5" value="${volume * 100}"></label><p>Empieza silenciado. El control Mover permite caminar en pantalla táctil. El mapa muestra las cuatro agentes y tu destino.</p><button id="room-guide-restart">Repetir primer paseo</button><button id="room-help-close">Entendido</button></div>
    <button class="room-interact" id="room-interact" hidden><strong id="room-quick-title"></strong><span id="room-quick-lines"></span><span id="room-quick-action"></span></button>
    <aside class="room-guide" id="room-guide" hidden aria-label="Primer paseo"><p id="room-guide-text" role="status"></p><button id="room-guide-skip">Saltar guía</button></aside>
    <div class="room-joystick" id="room-joystick" role="group" aria-label="Movimiento táctil"><span>Mover</span><i aria-hidden="true"></i></div>
    <p class="room-completion" id="room-completion" role="status" hidden></p>`;
}
