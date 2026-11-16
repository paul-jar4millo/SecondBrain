// Stable entry point for installed systemd units and rollback to older releases.
import { startService } from "../service/index.mjs";
await startService();
