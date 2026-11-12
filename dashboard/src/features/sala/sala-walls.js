export function fadeWalls(objects, show, dt, immediate = false) {
  let changed = false;
  for (const object of objects) {
    if (!object.userData.wallFade) {
      object.userData.wallFade = {
        shadow: object.castShadow,
        opacity: object.material.opacity,
        transparent: object.material.transparent,
        depthWrite: object.material.depthWrite,
        factor: object.visible ? 1 : 0,
      };
      // Blender surfaces and ink groups share materials: each wall owns its fade.
      object.material = object.material.clone();
    }
    const material = object.material;
    const state = object.userData.wallFade;
    const target = show ? 1 : 0;
    const before = state.factor;
    let alpha = immediate
      ? target
      : before + (target - before) * (1 - Math.exp(-18 * Math.max(0, dt)));
    if (Math.abs(alpha - target) < 0.015) alpha = target;
    const transparent = state.transparent || alpha < 1;
    if (material.transparent !== transparent) {
      material.transparent = transparent;
      material.needsUpdate = true;
    }
    state.factor = alpha;
    material.opacity = state.opacity * alpha;
    material.depthWrite = state.depthWrite && alpha === 1;
    object.visible = alpha > 0;
    object.castShadow = show && object.userData.wallFade.shadow;
    changed ||= before !== alpha;
  }
  return changed;
}
