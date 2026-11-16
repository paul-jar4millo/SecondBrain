// Stable entry point for engine hooks (the `current` symlink defeats the direct-run check).
import { main } from "../lanzador/hook.mjs";
await main();
