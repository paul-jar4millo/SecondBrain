// Downloads of the refuge, in parallel, with one shared progress bar.
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { MODEL_NAMES, loadAll } from "./room-characters";
import { createLoadProgress } from "./room-quality";

export function createRefugeLoad(onProgress: (percent: number) => void) {
  const progress = createLoadProgress([
    "mapa",
    "plano",
    "datos",
    "fuentes",
    ...MODEL_NAMES,
  ]);
  const report = () => onProgress(progress.percent());
  const step =
    (name: string) =>
    <T>(value: T): T => {
      progress.done(name);
      report();
      return value;
    };
  return {
    report,
    /** Map, walkable plan, room data, character models and the zone font. */
    load: (loadRoomData: () => Promise<void>) =>
      // Every request runs in parallel and reports real bytes when it can.
      Promise.all([
        new GLTFLoader()
          .setMeshoptDecoder(MeshoptDecoder)
          .loadAsync(
            `${import.meta.env.BASE_URL}models/sala/refugio.glb`,
            (e) => {
              progress.update(
                "mapa",
                e.loaded,
                e.lengthComputable ? e.total : 0,
              );
              report();
            },
          )
          .then(step("mapa")),
        fetch(`${import.meta.env.BASE_URL}models/sala/refugio-nav.json`)
          .then((r) => {
            if (!r.ok) throw new Error("Mapa no disponible");
            return r.json();
          })
          .then(step("plano")),
        loadRoomData().then(step("datos")),
        loadAll((name: string, done: number, total: number) => {
          progress.update(name, done, total);
          report();
        }).then((models) => {
          MODEL_NAMES.forEach((n) => progress.done(n));
          report();
          return models;
        }),
        Promise.resolve(document.fonts?.load('46px "Dela Gothic One"'))
          .catch(() => null)
          .then(step("fuentes")),
      ]),
  };
}
