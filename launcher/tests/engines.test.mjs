import test from "node:test";
import assert from "node:assert/strict";
import {
  engineCommand,
  environmentOf,
  effortEnvironment,
  MARINA_IDENTITY,
  economyModel,
  deepSeekBalance,
  validateEngineAttachments,
} from "../engines.mjs";

test("prepara los cuatro motores headless sin imponer modelo ni herramientas", () => {
  const claude = engineCommand("claude", "Hazlo");
  assert.equal(claude.bin, "claude");
  assert.deepEqual(claude.args, [
    "-p",
    "Hazlo",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-hook-events",
    "--permission-mode",
    "bypassPermissions",
  ]);
  assert.deepEqual(engineCommand("deepseek", "x").args, [
    ...engineCommand("claude", "x").args,
    "--append-system-prompt",
    MARINA_IDENTITY,
  ]);
  const codex = engineCommand("codex", "x").args;
  assert.deepEqual(codex, [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'mcp_servers.secondbrain.env_vars=["SB_BRAIN_TOKEN_FILE","SB_BRAIN_URL","SB_AGENTE","SB_SESSION_ID"]',
    "x",
  ]);
  assert.ok(!codex.includes("model_auto_compact_token_limit=350000"));
  assert.deepEqual(engineCommand("agy", "x").args, [
    "-p",
    "x",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ]);
  assert.throws(() => engineCommand("otro", "x"));
});

test("consulta saldo USD sin registrar la clave y rechaza respuestas no fiables", async () => {
  let request;
  const fetchFn = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "9" },
          { currency: "USD", total_balance: "0.19" },
        ],
      }),
    };
  };
  assert.equal(await deepSeekBalance("test-key", fetchFn), 0.19);
  assert.equal(request.url, "https://api.deepseek.com/user/balance");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  await assert.rejects(
    deepSeekBalance("test-key", async () => ({
      ok: true,
      json: async () => ({ is_available: false, balance_infos: [] }),
    })),
  );
  await assert.rejects(deepSeekBalance("", fetchFn));
});

test("las credenciales de proveedores no se mezclan", () => {
  const env = {
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
    AGENTES_DEEPSEEK_DIR: "/deepseek",
  };
  const claude = environmentOf("claude", env);
  const deepseek = environmentOf("deepseek", env);
  assert.equal(claude.CLAUDE_CODE_OAUTH_TOKEN, "claude-secret");
  assert.equal(claude.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(deepseek.ANTHROPIC_AUTH_TOKEN, "deepseek-secret");
  assert.equal(deepseek.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(deepseek.CLAUDE_CONFIG_DIR, "/deepseek");
  assert.equal(claude.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "350000");
  assert.equal(deepseek.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "350000");
  // Without this, Claude Code loads the owner's claude.ai connectors.
  assert.equal(claude.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(deepseek.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

test("un encargo que empieza con guion no se interpreta como opción del CLI", () => {
  for (const engine of ["claude", "codex", "agy", "deepseek"]) {
    const args = engineCommand(engine, "---\nname: x\n---\nhola").args;
    assert.ok(args.includes("Instrucciones:\n---\nname: x\n---\nhola"));
    assert.ok(!args.some((a) => a.startsWith("---")));
  }
});

test("Claude recibe --effort y DeepSeek lo traduce a presupuesto de pensamiento", () => {
  assert.deepEqual(
    engineCommand("claude", "x", {
      modelo: "opus",
      esfuerzo: "max",
    }).args.slice(-4),
    ["--model", "opus", "--effort", "max"],
  );
  const marina = engineCommand("deepseek", "x", { esfuerzo: "high" }).args;
  assert.ok(!marina.includes("--effort"));
  assert.deepEqual(effortEnvironment("deepseek", "high"), {
    MAX_THINKING_TOKENS: "32000",
  });
  assert.deepEqual(effortEnvironment("deepseek", "rm -rf"), {});
  assert.deepEqual(effortEnvironment("claude", "high"), {});
});

test("economyModel reconoce -luna en Codex y validateEngineAttachments acota capacidades", () => {
  assert.equal(
    economyModel("codex", [{ id: "gpt-5.6" }, { id: "gpt-5.6-luna" }]),
    "gpt-5.6-luna",
  );
  assert.equal(
    economyModel("codex", [{ id: "gpt-5.6-luna" }, { id: "gpt-5-mini" }]),
    "gpt-5-mini",
  );
  assert.throws(
    () =>
      validateEngineAttachments("codex", [
        { type: "embeddedContext", text: "x" },
      ]),
    /no soporta adjuntos/i,
  );
  assert.throws(
    () =>
      validateEngineAttachments(
        "codex",
        [{ type: "localImage", path: "../secreto.png" }],
        "/tmp/sandbox-workspace",
      ),
    /fuera del espacio de trabajo/i,
  );
});
