// Stable entry point: the `current` symlink would defeat the import.meta.url check in lanzador/index.mjs.
import { arrancar } from "../lanzador/index.mjs";
await arrancar();
