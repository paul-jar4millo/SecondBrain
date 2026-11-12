// Pointer picking for the refuge. three.js Raycaster ignores `visible`, so hidden
// signs used to swallow clicks; only objects drawn on screen may be picked.

/** True when the object and all its ancestors are visible. */
function shown(object) {
  for (let o = object; o; o = o.parent) if (!o.visible) return false;
  return true;
}

/**
 * What a ray would hit: `{ kind: "agent", id }`, `{ kind: "tool", tool }` or null.
 * Agent hit cylinders are invisible by design; their figure (`raiz`) decides.
 */
export function pickTarget(raycaster, { actors, labels }) {
  const candidates = [
    ...actors.filter((a) => shown(a.raiz)).map((a) => a.toque),
    ...labels.filter((label) => label.userData.tool && shown(label)),
  ];
  const hit = raycaster.intersectObjects(candidates, false)[0];
  if (!hit) return null;
  const actor = actors.find((a) => a.toque === hit.object);
  if (actor) return { kind: "agent", id: actor.spec.id };
  if (hit.object.userData.tool)
    return { kind: "tool", tool: hit.object.userData.tool };
  return null;
}

/** CSS cursor that tells what a click would do. */
export function cursorFor(target) {
  if (!target) return "default";
  if (target.kind === "agent" || target.kind === "tool") return "pointer";
  return target.reachable ? "crosshair" : "not-allowed";
}
