import {
  brainServer,
  CONTROLLER_FACTORIES,
  createAcpController,
  createClaudeController,
  createCodexController,
  resolveMcpServers,
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "./provider-controllers.mjs";

export {
  brainServer,
  CONTROLLER_FACTORIES,
  createAcpController,
  createClaudeController,
  createCodexController,
  resolveMcpServers,
  validateAndExtractElicitationContent,
  validateRequestedSchema,
};

export async function runCodex(ctx) {
  const controller = createCodexController();
  const normalizedCtx =
    ctx.disableInheritedMcp === undefined && ctx.mcpServers === undefined
      ? { ...ctx, disableInheritedMcp: false }
      : ctx;
  try {
    return await controller.runTurn(normalizedCtx);
  } finally {
    await controller.shutdown("Fin de turno Codex");
  }
}
runCodex.createController = () => createCodexController();

export async function runClaude(ctx, queryOverride = null) {
  const controller = createClaudeController(queryOverride);
  try {
    return await controller.runTurn(ctx);
  } finally {
    await controller.shutdown("Fin de turno Claude");
  }
}
runClaude.createController = (queryOverride = null) =>
  createClaudeController(queryOverride);

export async function runAcp(ctx) {
  const controller = createAcpController();
  try {
    return await controller.runTurn(ctx);
  } finally {
    await controller.shutdown("Fin de turno ACP");
  }
}
runAcp.createController = () => createAcpController();

export const PROVIDER_ADAPTERS = {
  codex: runCodex,
  claude: runClaude,
  deepseek: runClaude,
  agy: runAcp,
};
