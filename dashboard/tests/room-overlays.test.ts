import { describe, expect, it } from "vitest";
import { createOverlayStack } from "../src/features/room/room-overlays";

function fakeButton() {
  const attrs = new Map<string, string>();
  return {
    focused: 0,
    focus() {
      this.focused++;
    },
    setAttribute(name: string, value: string) {
      attrs.set(name, value);
    },
    getAttribute: (name: string) => attrs.get(name) ?? null,
    isConnected: true,
  };
}

describe("one overlay stack for agent, board, help and desk", () => {
  it("closes only the top overlay and returns focus to what opened it", () => {
    const closed: string[] = [];
    const stack = createOverlayStack();
    const roster = fakeButton(),
      flows = fakeButton();
    stack.open("agent", {
      close: () => closed.push("agent"),
      returnFocus: () => roster,
    });
    stack.open("desk", {
      close: () => closed.push("desk"),
      returnFocus: () => flows,
    });
    expect(stack.closeTop()).toBe(true);
    expect(closed).toEqual(["desk"]);
    expect(flows.focused).toBe(1);
    expect(stack.top()).toBe("agent");
    expect(stack.closeTop()).toBe(true);
    expect(roster.focused).toBe(1);
    expect(stack.closeTop()).toBe(false);
  });
  it("keeps aria-expanded on every opener in sync", () => {
    const stack = createOverlayStack();
    const help = fakeButton();
    stack.open("help", { close() {}, controls: () => [help] });
    expect(help.getAttribute("aria-expanded")).toBe("true");
    stack.close("help");
    expect(help.getAttribute("aria-expanded")).toBe("false");
  });
  it("replaces an overlay of the same slot without stealing focus back", () => {
    const closed: string[] = [];
    const stack = createOverlayStack();
    const roster = fakeButton();
    stack.open("agent", {
      slot: "side",
      close: () => closed.push("agent"),
      returnFocus: () => roster,
    });
    stack.open("board", { slot: "side", close: () => closed.push("board") });
    expect(closed).toEqual(["agent"]);
    expect(roster.focused).toBe(0);
    expect(stack.list()).toEqual(["board"]);
  });
  it("reopening the same overlay moves it to the top instead of stacking twice", () => {
    const stack = createOverlayStack();
    stack.open("agent", { close() {} });
    stack.open("help", { close() {} });
    stack.open("agent", { close() {} });
    expect(stack.list()).toEqual(["help", "agent"]);
  });
  it("falls back when the opener left the page", () => {
    const stack = createOverlayStack();
    const gone = { ...fakeButton(), isConnected: false };
    const canvas = fakeButton();
    stack.open("agent", {
      close() {},
      returnFocus: () => gone,
      fallbackFocus: () => canvas,
    });
    stack.closeTop();
    expect(gone.focused).toBe(0);
    expect(canvas.focused).toBe(1);
  });
  it("reports the open set so the HUD can make room", () => {
    const seen: string[][] = [];
    const stack = createOverlayStack({ onChange: (list) => seen.push(list) });
    stack.open("agent", { close() {} });
    stack.close("agent");
    expect(seen).toEqual([["agent"], []]);
  });
});
