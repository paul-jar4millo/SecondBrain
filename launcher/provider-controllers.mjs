// Provider controllers: one per agent CLI family (Codex app-server, ACP and
// the Claude Agent SDK). The implementations live in lib/providers/; this
// module keeps the public surface and the factory table.
import { createAcpController } from "./lib/providers/acp.mjs";
import { createClaudeController } from "./lib/providers/claude.mjs";
import { createCodexController } from "./lib/providers/codex.mjs";
export { createAcpController } from "./lib/providers/acp.mjs";
export { createClaudeController } from "./lib/providers/claude.mjs";
export { createCodexController } from "./lib/providers/codex.mjs";
export {
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "./lib/providers/elicitation.mjs";
export {
  brainServer,
  formatAcpInput,
  formatCodexInput,
  resolveMcpServers,
  verifyAcpConfigModel,
} from "./lib/providers/shared.mjs";
export {
  parseCodexMcpServerEntries,
  parseCodexMcpServerKeys,
} from "./lib/providers/toml.mjs";

export const CONTROLLER_FACTORIES = {
  codex: () => createCodexController(),
  agy: () => createAcpController(),
  claude: () => createClaudeController(),
  deepseek: () => createClaudeController(),
};
