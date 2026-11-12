// Faceted glyphs for the HUD: flat-shaded polygons that match the low-poly world.
// Each facet is [tone, points]; tones a/b/c/w are themed from CSS (dark to light).
type Facet = [string, string];

function star(points: number, outer: number, inner: number): Facet[] {
  const at = (i: number, r: number) => {
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    return `${(24 + Math.cos(angle) * r).toFixed(1)},${(24 + Math.sin(angle) * r).toFixed(1)}`;
  };
  return Array.from({ length: points * 2 }, (_, i) => {
    const tip = i % 2 === 0;
    return [
      tip ? "c" : "b",
      `24,24 ${at(i, tip ? outer : inner)} ${at(i + 1, tip ? inner : outer)}`,
    ];
  });
}

const GLYPHS = {
  sala: [
    ["b", "24,4 5,22 24,22"],
    ["c", "24,4 43,22 24,22"],
    ["a", "9,22 39,22 39,44 9,44"],
    ["b", "24,22 39,22 39,44 24,44"],
    ["w", "19,44 19,31 29,31 29,44"],
  ],
  hoy: [
    ...star(8, 23, 12),
    ["w", "24,15 30,18 33,24 30,30 24,33 18,30 15,24 18,18"],
  ],
  equipo: [
    ["b", "8,20 16,12 24,20 16,28"],
    ["c", "24,20 32,12 40,20 32,28"],
    ["a", "4,44 8,32 16,28 24,32 24,44"],
    ["b", "24,44 24,32 32,28 40,32 44,44"],
    ["w", "16,14 22,20 16,26 10,20"],
    ["w", "32,14 38,20 32,26 26,20"],
  ],
  tareas: [
    ["a", "24,3 43,14 43,34 24,45 5,34 5,14"],
    ["b", "24,3 43,14 43,34 24,24"],
    ["c", "24,3 5,14 24,24"],
    ["w", "13,24 21,32 35,15 39,19 21,40 9,28"],
  ],
  agenda: [
    ["b", "31,3 17,7 8,19 8,32 17,42 31,45 41,39 29,36 21,28 20,18 24,10"],
    ["c", "31,3 17,7 8,19 20,18 24,10"],
    ["a", "8,32 17,42 31,45 41,39 29,36 21,28"],
    ["w", "38,11 40,18 47,20 40,22 38,29 36,22 29,20 36,18"],
  ],
  proyectos: [
    ["c", "24,5 43,15 24,25 5,15"],
    ["a", "5,15 24,25 24,45 5,34"],
    ["b", "43,15 24,25 24,45 43,34"],
    ["w", "24,11 32,15 24,19 16,15"],
  ],
  finanzas: [
    ["a", "16,3 32,3 45,16 45,32 32,45 16,45 3,32 3,16"],
    ["b", "16,3 32,3 45,16 3,16"],
    ["w", "24,11 35,24 24,37 13,24"],
    ["c", "24,11 35,24 13,24"],
  ],
  maletin: [
    ["a", "6,16 42,16 42,42 6,42"],
    ["b", "24,16 42,16 42,42 24,42"],
    ["c", "16,16 16,8 32,8 32,16 28,16 28,12 20,12 20,16"],
    ["w", "21,26 27,26 27,32 21,32"],
  ],
  ajustes: [
    ...star(6, 23, 15),
    ["a", "24,13 33,18 33,30 24,35 15,30 15,18"],
    ["w", "24,19 28,21 28,27 24,29 20,27 20,21"],
  ],
  buscar: [
    ["c", "14,3 26,3 35,12 35,24 26,33 14,33 5,24 5,12"],
    ["b", "26,3 35,12 35,24 26,33 20,18"],
    ["a", "16,10 24,10 28,14 28,22 24,26 16,26 12,22 12,14"],
    ["w", "30,28 35,24 46,39 40,44"],
  ],
  avisos: [
    ["b", "24,3 14,12 11,30 5,37 43,37 37,30 34,12"],
    ["c", "24,3 14,12 11,30 5,37 24,37"],
    ["w", "18,39 30,39 24,46"],
  ],
  capturar: [
    ["c", "24,2 19,19 2,24 24,24"],
    ["b", "24,2 29,19 46,24 24,24"],
    ["a", "46,24 29,29 24,46 24,24"],
    ["b", "2,24 19,29 24,46 24,24"],
  ],
} satisfies Record<string, Facet[]>;

export type GlyphName = keyof typeof GLYPHS;

export function HudGlyph({
  name,
  size = 46,
}: {
  name: GlyphName;
  size?: number;
}) {
  return (
    <svg
      className="hud-glyph"
      viewBox="0 0 48 48"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {(GLYPHS[name] as Facet[]).map(([tone, points], i) => (
        <polygon key={i} className={`g-${tone}`} points={points} />
      ))}
    </svg>
  );
}

// The dock's backdrop: a low-poly moon rising from the bottom edge.
const RIM = [
  [0, 130],
  [44, 80],
  [170, 42],
  [340, 18],
  [500, 8],
  [660, 18],
  [830, 42],
  [956, 80],
  [1000, 130],
];
const BASE = [150, 300, 500, 700, 850];

export function HudMoon() {
  const fan: { points: string; tone: string }[] = [];
  RIM.slice(0, -1).forEach(([x, y], i) => {
    const [nx, ny] = RIM[i + 1];
    const foot = BASE[Math.min(BASE.length - 1, Math.floor(i * 0.68))];
    fan.push({
      points: `${x},${y} ${nx},${ny} ${foot},130`,
      tone: ["m-a", "m-b", "m-c"][i % 3],
    });
    const nextFoot =
      BASE[Math.min(BASE.length - 1, Math.floor((i + 1) * 0.68))];
    if (nextFoot !== foot)
      fan.push({
        points: `${nx},${ny} ${foot},130 ${nextFoot},130`,
        tone: ["m-b", "m-c", "m-a"][i % 3],
      });
  });
  return (
    <svg
      className="hud-moon"
      viewBox="0 0 1000 130"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon
        className="m-rim"
        points={RIM.map(([x, y]) => `${x},${y - 6}`).join(" ")}
      />
      <polygon
        className="m-a"
        points={`${RIM.map((p) => p.join(",")).join(" ")}`}
      />
      {fan.map((f, i) => (
        <polygon key={i} className={f.tone} points={f.points} />
      ))}
    </svg>
  );
}
