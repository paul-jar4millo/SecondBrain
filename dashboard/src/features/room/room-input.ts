// Walking input: WASD / arrows and the on-screen touch stick.
import { thumbAxis } from "./room-controls";

const WALK_KEY = /^(Key[WASD]|Arrow(Up|Down|Left|Right))$/;

export function createWalkInput(
  joystick: HTMLElement,
  {
    canStartStick,
    onWalkInput,
  }: {
    /** False while a field, a dialog or a panel has the input. */
    canStartStick: () => boolean;
    /** Manual walking cancels the player's clicked route. */
    onWalkInput: () => void;
  },
) {
  const keys = new Set<string>();
  let stick = { x: 0, y: 0 },
    stickPointer: number | null = null;

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
    if (stickPointer !== null || !canStartStick()) return;
    e.preventDefault();
    stickPointer = e.pointerId;
    joystick.setPointerCapture(e.pointerId);
    onWalkInput();
    stickMove(e);
  };
  const stickEnd = (e: PointerEvent) => {
    if (e.pointerId === stickPointer) resetStick();
  };
  const listeners = [
    ["pointerdown", stickDown],
    ["pointermove", stickMove],
    ["pointerup", stickEnd],
    ["pointercancel", stickEnd],
    ["lostpointercapture", stickEnd],
  ] as const;
  for (const [type, fn] of listeners) joystick.addEventListener(type, fn);

  return {
    /** Handles a walking key; returns whether it was one. */
    keyDown(e: KeyboardEvent) {
      if (!WALK_KEY.test(e.code)) return false;
      e.preventDefault();
      keys.add(e.code);
      onWalkInput();
      return true;
    },
    keyUp: (e: KeyboardEvent) => keys.delete(e.code),
    /** Drops every held key and centers the stick. */
    release() {
      keys.clear();
      resetStick();
    },
    resetStick,
    /** Forward and left axes in [-1, 1], keys and stick combined. */
    axes() {
      const has = (a: string, b: string) => keys.has(a) || keys.has(b);
      return {
        forward:
          -stick.y +
          (has("KeyW", "ArrowUp") ? 1 : 0) -
          (has("KeyS", "ArrowDown") ? 1 : 0),
        left:
          stick.x +
          (has("KeyD", "ArrowRight") ? 1 : 0) -
          (has("KeyA", "ArrowLeft") ? 1 : 0),
      };
    },
    dispose() {
      resetStick();
      for (const [type, fn] of listeners)
        joystick.removeEventListener(type, fn);
    },
  };
}
