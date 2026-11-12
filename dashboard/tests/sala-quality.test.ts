import { describe, expect, it } from "vitest";
import {
  QUALITY,
  createFrameMeter,
  createLoadProgress,
  nextPixelRatio,
  qualityFor,
  shadowUpdateDue,
} from "../src/features/sala/sala-quality.js";

describe("quality levels", () => {
  it("chooses high quality on a desktop with a fine pointer", () => {
    expect(
      qualityFor({ coarse: false, cores: 12, memory: 16, saved: "auto" }),
    ).toBe("alta");
  });
  it("chooses low on phones and weak devices", () => {
    expect(qualityFor({ coarse: true, cores: 8, memory: 8 })).toBe("baja");
    expect(
      qualityFor({ coarse: true, cores: 8, memory: 8, saved: "media" }),
    ).toBe("media");
    expect(qualityFor({ coarse: true, cores: 4, memory: 2 })).toBe("baja");
    expect(qualityFor({ coarse: false, cores: 2, memory: 4 })).toBe("baja");
  });
  it("respects a saved choice over detection", () => {
    expect(qualityFor({ coarse: false, cores: 12, saved: "baja" })).toBe(
      "baja",
    );
    expect(qualityFor({ coarse: true, cores: 2, saved: "alta" })).toBe("alta");
    expect(qualityFor({ coarse: false, cores: 12, saved: "rara" })).toBe(
      "alta",
    );
  });
  it("lower levels never cost more than higher ones", () => {
    expect(QUALITY.baja.shadowMap).toBe(0);
    expect(QUALITY.media.shadowMap).toBeLessThan(QUALITY.alta.shadowMap);
    expect(QUALITY.baja.maxPixelRatio).toBeLessThanOrEqual(
      QUALITY.media.maxPixelRatio,
    );
    expect(QUALITY.media.maxPixelRatio).toBeLessThanOrEqual(
      QUALITY.alta.maxPixelRatio,
    );
  });
});

describe("adaptive pixel ratio", () => {
  const limits = { min: 0.75, max: 1.5 };
  it("drops resolution when frames are slow", () => {
    expect(nextPixelRatio(1.5, 30, limits)).toBe(1.25);
    expect(nextPixelRatio(0.75, 40, limits)).toBe(0.75);
  });
  it("recovers slowly when there is headroom, never above the device cap", () => {
    expect(nextPixelRatio(1, 16.7, limits)).toBe(1.125);
    expect(nextPixelRatio(1.5, 5, limits)).toBe(1.5);
  });
  it("holds steady inside the comfortable band", () => {
    expect(nextPixelRatio(1.25, 20, limits)).toBe(1.25);
  });
});

describe("frame meter", () => {
  it("averages frame time over a window and ignores paused gaps", () => {
    const meter = createFrameMeter(4);
    expect(meter.push(20)).toBe(null);
    meter.push(20);
    meter.push(500); // tab was hidden or a modal paused rendering
    meter.push(20);
    expect(meter.push(20)).toBe(20);
    expect(meter.push(10)).toBe(null);
  });
});

describe("shadow updates on demand", () => {
  it("redraws shadows while someone walks or the walls switch", () => {
    expect(shadowUpdateDue({ moving: true, frame: 3 })).toBe(true);
    expect(shadowUpdateDue({ wallsChanged: true, frame: 3 })).toBe(true);
  });
  it("only refreshes idle animation shadows a few times per second", () => {
    expect(shadowUpdateDue({ frame: 6, animated: true })).toBe(true);
    expect(shadowUpdateDue({ frame: 7, animated: true })).toBe(false);
    expect(shadowUpdateDue({ frame: 6, animated: false })).toBe(false);
  });
});

describe("real loading progress", () => {
  it("averages the progress of every part", () => {
    const progress = createLoadProgress(["mapa", "personajes"]);
    expect(progress.percent()).toBe(0);
    progress.update("mapa", 50, 100);
    expect(progress.percent()).toBe(25);
    progress.update("personajes", 100, 100);
    expect(progress.percent()).toBe(75);
    progress.done("mapa");
    expect(progress.percent()).toBe(100);
  });
  it("counts parts with an unknown size as half done while loading", () => {
    const progress = createLoadProgress(["mapa", "plano"]);
    progress.update("plano", 1234, 0);
    expect(progress.percent()).toBe(25);
  });
});
