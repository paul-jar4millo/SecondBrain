// Small meshes the scene owns: name tags, leisure props and their disposal.
import * as THREE from "three";

export const CORAL = "#ff6f61";

/** A slanted name tag drawn on a canvas; zone tags are larger. */
export function label(text: string, color = "#f1f7ff", zone = false) {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = zone ? '46px "Dela Gothic One"' : "600 44px Fredoka, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = Math.min(470, ctx.measureText(text).width + 64),
    x = 256 - w / 2,
    slant = 18;
  const shard = (dx: number, dy: number, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x + slant + dx, 20 + dy);
    ctx.lineTo(x + w + dx, 14 + dy);
    ctx.lineTo(x + w - slant + dx, 98 + dy);
    ctx.lineTo(x + dx, 104 + dy);
    ctx.closePath();
    ctx.fill();
  };
  shard(7, 8, zone ? "#2f66e6" : color);
  shard(0, 0, "#0f1a55");
  ctx.fillStyle = zone ? "#f1f7ff" : color;
  ctx.fillText(text, 256, 60, w - 44);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
    }),
  );
  sprite.scale.set(zone ? 4.4 : 2.7, zone ? 1.1 : 0.675, 1);
  sprite.renderOrder = 5;
  return sprite;
}

/** Frees a tag's texture and material. */
export function disposeSprite(sprite: THREE.Sprite | null | undefined) {
  sprite?.material?.map?.dispose();
  sprite?.material?.dispose();
}

/** Frees every geometry and material under an object, each once. */
export function disposeObject(object: THREE.Object3D | null) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  object?.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry);
      for (const m of Array.isArray(o.material) ? o.material : [o.material])
        materials.add(m);
    }
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}

/** Cup, book and watering can, hidden until the agent rests in their zone. */
export function leisureProps(raiz: THREE.Object3D) {
  const props: Record<string, THREE.Object3D> = {};
  const material = (color: string) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const cup = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.07, 0.17, 12),
    material("#f1f7ff"),
  );
  cup.position.set(0.24, 1.12, 0.3);
  raiz.add(cup);
  props.cafe = cup;
  const book = new THREE.Group();
  book.position.set(0, 1.03, 0.3);
  book.rotation.x = -0.5;
  const pages = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.07, 0.28),
    material("#f1f7ff"),
  );
  book.add(pages);
  for (const y of [-0.045, 0.045]) {
    const cover = new THREE.Mesh(
      new THREE.BoxGeometry(0.43, 0.02, 0.31),
      material("#2f66e6"),
    );
    cover.position.y = y;
    book.add(cover);
  }
  raiz.add(book);
  props.library = book;
  const can = new THREE.Group();
  can.position.set(0.27, 0.88, 0.34);
  can.add(
    new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.12, 0.2, 10),
      material("#43c9dc"),
    ),
  );
  const spout = new THREE.Mesh(
    new THREE.CylinderGeometry(0.025, 0.04, 0.26, 8),
    material("#43c9dc"),
  );
  spout.rotation.z = -0.8;
  spout.position.set(0.17, 0.06, 0);
  can.add(spout);
  raiz.add(can);
  props.garden = can;
  Object.values(props).forEach((prop) => (prop.visible = false));
  return props;
}

/** Flat ring on the floor: the walk destination and the "can't go there" pulse. */
export function floorRing(scene: THREE.Scene, color: string, opacity: number) {
  const mesh = new THREE.Mesh(
    new THREE.RingGeometry(0.25, 0.34, 28),
    new THREE.MeshBasicMaterial({
      color,
      side: THREE.DoubleSide,
      transparent: true,
      opacity,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.visible = false;
  scene.add(mesh);
  return mesh;
}

/**
 * Hidden tags over each zone (they carry the tool to open) and over each work
 * spot (shown while an agent works in that phase).
 */
export function placeLabels(
  scene: THREE.Scene,
  zones: readonly { name: string; tool: string; x: number; z: number }[],
  spots: Record<string, { x: number; z: number }>,
) {
  const labels: THREE.Sprite[] = [];
  for (const zone of zones) {
    const tag = label(zone.name, undefined, true);
    tag.visible = false;
    tag.position.set(zone.x, 3.1, zone.z - 1.8);
    tag.userData.tool = zone.tool;
    scene.add(tag);
    labels.push(tag);
  }
  for (const [task, spot] of Object.entries(spots)) {
    const tag = label(task[0].toUpperCase() + task.slice(1), "#78bdf8");
    tag.visible = false;
    tag.userData.phase = task;
    tag.position.set(spot.x, 1.6, spot.z + 0.25);
    tag.scale.set(2.3, 0.575, 1);
    scene.add(tag);
    labels.push(tag);
  }
  return labels;
}
