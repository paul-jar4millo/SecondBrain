// Rendering budget for the refuge: quality levels, adaptive resolution, shadow
// refresh policy and real loading progress. Pure functions, no three.js.

export const QUALITY = {
  alta: { shadowMap: 2048, maxPixelRatio: 1.5, antialias: true },
  media: { shadowMap: 1024, maxPixelRatio: 1.25, antialias: true },
  baja: { shadowMap: 0, maxPixelRatio: 1, antialias: false },
};
export type QualityLevel = keyof typeof QUALITY;
export type QualityChoice = QualityLevel | "auto";
export const QUALITY_LABELS: Record<QualityChoice, string> = {
  auto: "Automática",
  alta: "Alta",
  media: "Media",
  baja: "Baja",
};

/**
 * Saved choice wins; otherwise phones and weak devices get "baja". Shadows redraw
 * several times a second even when idle, which a phone pays for in battery.
 */
export function qualityFor({
  coarse,
  cores = 4,
  memory = 4,
  saved,
}: {
  coarse?: boolean;
  cores?: number;
  memory?: number;
  saved?: string | null;
} = {}): QualityLevel {
  if (saved && saved !== "auto" && saved in QUALITY)
    return saved as QualityLevel;
  if (coarse || cores <= 2 || memory <= 2) return "baja";
  return "alta";
}

/** Phones draw at about 30 fps: 0 means "every frame the screen offers". */
export const minFrameInterval = (coarse: boolean) =>
  coarse ? 1000 / 30 - 4 : 0;

/**
 * One adaptive step from the average frame interval (ms; vsync keeps it >= 16.7
 * at 60 Hz, so "fast" means at or near the refresh rate). Slow frames drop a quarter;
 * spare headroom climbs an eighth, so resolution does not oscillate.
 */
export function nextPixelRatio(
  current: number,
  averageMs: number,
  { min, max }: { min: number; max: number },
) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  if (averageMs > 22) return clamp(current - 0.25);
  if (averageMs < 18) return clamp(current + 0.125);
  return clamp(current);
}

/** Averages frame times in windows of `size`; gaps over 250 ms (paused, hidden) are skipped. */
export function createFrameMeter(size = 90) {
  let total = 0,
    count = 0;
  return {
    push(ms: number) {
      if (ms > 250) return null;
      total += ms;
      count++;
      if (count < size) return null;
      const average = total / count;
      total = 0;
      count = 0;
      return average;
    },
    reset() {
      total = 0;
      count = 0;
    },
  };
}

/**
 * The world is static; only walkers, wall swaps and a few spinning props move
 * shadows. Walking redraws every frame, idle animation about ten times a second.
 */
export function shadowUpdateDue({
  moving = false,
  wallsChanged = false,
  animated = false,
  frame,
}: {
  moving?: boolean;
  wallsChanged?: boolean;
  animated?: boolean;
  frame: number;
}) {
  if (moving || wallsChanged) return true;
  return animated && frame % 6 === 0;
}

/** Average progress of named parts; a part with unknown size counts as half while it loads. */
export function createLoadProgress(names: readonly string[]) {
  const parts = new Map(names.map((n) => [n, 0]));
  return {
    update(name: string, loaded: number, total: number) {
      parts.set(
        name,
        total > 0 ? Math.min(1, loaded / total) : loaded > 0 ? 0.5 : 0,
      );
    },
    done(name: string) {
      parts.set(name, 1);
    },
    percent() {
      let sum = 0;
      for (const v of parts.values()) sum += v;
      return Math.round((sum / parts.size) * 100);
    },
  };
}
