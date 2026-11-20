export interface Point {
  x: number;
  z: number;
}
export interface Obstacle {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}
export interface Order {
  id: string;
  mode: string;
  instruction?: string;
  project?: string;
}
export const BASE_IDS = ["ambar", "menta", "lira", "marina"];
export function tourInstructions(touch: boolean) {
  return [
    touch
      ? "1 de 3 · Toca el suelo o usa Mover para caminar."
      : "1 de 3 · Camina con WASD, toca el suelo o usa Mover.",
    "2 de 3 · Acércate a una zona del mapa para leer su resumen.",
    touch
      ? "3 de 3 · Toca el resumen para abrir esa herramienta."
      : "3 de 3 · Abre esa herramienta con E o toca el resumen.",
  ];
}
// Each zone opens one tool; prompts name both so "Café" never hides "Finanzas".
export const ZONES = [
  {
    id: "terrace",
    name: "Terraza",
    place: "la Terraza",
    x: 0,
    z: 4,
    tool: "/team",
    toolName: "Equipo",
  },
  {
    id: "workshop",
    name: "Taller",
    place: "el Taller",
    x: -9,
    z: -4,
    tool: "/projects",
    toolName: "Proyectos",
  },
  {
    id: "library",
    name: "Biblioteca",
    place: "la Biblioteca",
    x: 0,
    z: -7,
    tool: "/tasks",
    toolName: "Tareas",
  },
  {
    id: "garden",
    name: "Invernadero",
    place: "el Invernadero",
    x: 10,
    z: -3,
    tool: "/files",
    toolName: "Maletín",
  },
  {
    id: "cafe",
    name: "Café",
    place: "el Café",
    x: -9,
    z: 6,
    tool: "/finance",
    toolName: "Finanzas",
  },
];

/** Action cue for the thing in reach. `device` is the last input used: "keyboard" or "touch". */
export function interactionPrompt(
  target: { spec?: { nombre: string }; toolName?: string; place?: string },
  device = "keyboard",
) {
  const key = device === "touch" ? "Tocar" : "E";
  return target.spec
    ? `${key} · Hablar con ${target.spec.nombre}`
    : `${key} · ${target.toolName} en ${target.place}`;
}

/** "Equipo en la Terraza, …  y Finanzas en el Café" for the help panel. */
export function zoneGuide() {
  const parts = ZONES.map((z) => `${z.toolName} en ${z.place}`);
  return `${parts.slice(0, -1).join(", ")} y ${parts.at(-1)}`;
}
const ROLES: Record<string, string> = {
  ambar: "library",
  menta: "terrace",
  lira: "garden",
  marina: "workshop",
};
const REST: Record<string, string[]> = {
  ambar: ["cafe", "library", "terrace"],
  menta: ["garden", "cafe", "terrace"],
  lira: ["terrace", "garden", "library"],
  marina: ["library", "workshop", "cafe"],
};
const ACTIVITIES: Record<string, string> = {
  cafe: "Tomando un café",
  library: "Leyendo",
  garden: "Cuidando las plantas",
  terrace: "Descansando al aire libre",
  workshop: "Ordenando el taller",
};

// Coordinates match the four Blender worktables. Slots stay stable per character.
export const PUESTOS: Record<string, Point & { nombre: string; zone: string }> =
  {
    investigar: {
      nombre: "Mesa de investigación",
      zone: "library",
      x: -0.7,
      z: -10,
    },
    planificar: {
      nombre: "Mesa de planificación",
      zone: "terrace",
      x: 0,
      z: 0.3,
    },
    programar: {
      nombre: "Puesto de programación",
      zone: "workshop",
      x: -10,
      z: -7.2,
    },
    revisar: { nombre: "Mesa de revisión", zone: "workshop", x: -8.3, z: -1.2 },
  };
export function puestoPara(
  id: string,
  { fase = "", zona }: { fase?: string; zona?: string } = {},
) {
  const key = fase.toLocaleLowerCase("es");
  const phase = PUESTOS[key];
  const puesto =
    phase && (!zona || phase.zone === zona)
      ? phase
      : zona === "library"
        ? PUESTOS.investigar
        : zona === "workshop"
          ? PUESTOS.programar
          : PUESTOS.planificar;
  return {
    ...puesto,
    x: puesto.x + (Math.max(0, BASE_IDS.indexOf(id)) - 1.5) * 0.7,
    z: puesto.z + 1.15,
    angle: Math.PI,
  };
}

export function normalizeOrder(order: Order) {
  if (!order || !BASE_IDS.includes(order.id))
    throw new Error("Solo hay cuatro agentes base.");
  if (!["work", "rest"].includes(order.mode))
    throw new Error("Acción no válida.");
  const instruction =
    typeof order.instruction === "string" ? order.instruction.trim() : "";
  if (instruction.length > 2000 || (order.mode === "work" && !instruction))
    throw new Error("Escribe un encargo de 1 a 2000 caracteres.");
  const project = order.project || "general";
  if (typeof project !== "string" || !/^[\w-]{1,80}$/.test(project))
    throw new Error("Proyecto no válido.");
  return { id: order.id, mode: order.mode, instruction, project };
}

export function activityFor(id: string, order: Partial<Order> = {}, cycle = 0) {
  const working = order.mode === "work";
  const text = (order.instruction || "").toLocaleLowerCase("es");
  const explicit = [
    ["biblioteca|leer|investig", "library"],
    ["taller|código|codigo|técnic|tecnic", "workshop"],
    ["invernadero|planta|jardín|jardin", "garden"],
    ["café|cafe", "cafe"],
    ["terraza|reun", "terrace"],
  ].find(([pattern]) => new RegExp(pattern).test(text));
  const zone = working
    ? explicit?.[1] || ROLES[id] || "terrace"
    : (REST[id] || REST.ambar)[cycle % 3];
  const hash = [...(order.project || "general")].reduce(
    (a, c) => a + c.charCodeAt(0),
    0,
  );
  const index = Math.max(0, BASE_IDS.indexOf(id));
  const base = ZONES.find((z) => z.id === zone) || ZONES[0];
  return {
    zone,
    x: base.x + (index % 2 ? 0.9 : -0.9),
    z: base.z + (working ? (hash % 3) * 0.45 : Math.floor(index / 2) * 0.9),
    label: working ? "Preparando referencias" : ACTIVITIES[zone],
  };
}

export function createNavigation(
  width: number,
  depth: number,
  obstacles: Obstacle[],
  step = 0.5,
) {
  const cols = Math.floor(width / step),
    rows = Math.floor(depth / step),
    radius = 0.3;
  const free = (x: number, z: number) =>
    Number.isFinite(x) &&
    Number.isFinite(z) &&
    Math.abs(x) < width / 2 - radius &&
    Math.abs(z) < depth / 2 - radius &&
    !obstacles.some(
      (b) =>
        x > b.x0 - radius &&
        x < b.x1 + radius &&
        z > b.z0 - radius &&
        z < b.z1 + radius,
    );
  const point = (n: number) => ({
    x: -width / 2 + ((n % cols) + 0.5) * step,
    z: -depth / 2 + (Math.floor(n / cols) + 0.5) * step,
  });
  const valid = new Uint8Array(cols * rows);
  for (let n = 0; n < valid.length; n++) {
    const p = point(n);
    valid[n] = free(p.x, p.z) ? 1 : 0;
  }
  const nearest = (p: Point) => {
    let best = -1,
      distance = Infinity;
    for (let n = 0; n < valid.length; n++)
      if (valid[n]) {
        const q = point(n),
          d = (p.x - q.x) ** 2 + (p.z - q.z) ** 2;
        if (d < distance) {
          distance = d;
          best = n;
        }
      }
    return best;
  };
  const route = (from: Point, to: Point) => {
    const start = nearest(from),
      end = nearest(to);
    if (start < 0 || end < 0 || start === end) return [];
    const cost = new Float32Array(valid.length).fill(Infinity),
      previous = new Int32Array(valid.length).fill(-1),
      closed = new Uint8Array(valid.length);
    const open = [start];
    cost[start] = 0;
    const h = (n: number) =>
      Math.hypot(
        (n % cols) - (end % cols),
        Math.floor(n / cols) - Math.floor(end / cols),
      );
    while (open.length) {
      let best = 0;
      for (let i = 1; i < open.length; i++)
        if (cost[open[i]] + h(open[i]) < cost[open[best]] + h(open[best]))
          best = i;
      const n = open.splice(best, 1)[0];
      if (n === end) {
        const result = [];
        for (let k = end; k !== start; k = previous[k])
          result.unshift(point(k));
        return result;
      }
      closed[n] = 1;
      const x = n % cols,
        z = Math.floor(n / cols);
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
        [1, 1],
        [-1, 1],
        [1, -1],
        [-1, -1],
      ]) {
        const nx = x + dx,
          nz = z + dz,
          m = nz * cols + nx;
        if (
          nx < 0 ||
          nz < 0 ||
          nx >= cols ||
          nz >= rows ||
          !valid[m] ||
          closed[m]
        )
          continue;
        if (dx && dz && (!valid[z * cols + nx] || !valid[nz * cols + x]))
          continue;
        const value = cost[n] + Math.hypot(dx, dz);
        if (value < cost[m]) {
          cost[m] = value;
          previous[m] = n;
          if (!open.includes(m)) open.push(m);
        }
      }
    }
    return [];
  };
  // A click on furniture walks to the closest free cell; a click on the sea is refused.
  const nearestFree = (p: Point, maxDistance = 2.5) => {
    if (free(p.x, p.z)) return { x: p.x, z: p.z };
    const n = nearest(p);
    if (n < 0) return null;
    const q = point(n);
    return Math.hypot(q.x - p.x, q.z - p.z) <= maxDistance ? q : null;
  };
  return { free, route, nearestFree };
}
