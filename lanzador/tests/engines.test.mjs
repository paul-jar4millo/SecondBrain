import test from "node:test";
import assert from "node:assert/strict";
import {
  comandoMotor,
  entornoDe,
  entornoEsfuerzo,
  IDENTIDAD_MARINA,
  modeloEconomico,
  saldoDeepSeek,
  validarAdjuntosMotor,
} from "../engines.mjs";

test("prepara los cuatro motores headless sin imponer modelo ni herramientas", () => {
  const claude = comandoMotor("claude", "Hazlo");
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
  assert.deepEqual(comandoMotor("deepseek", "x").args, [
    ...comandoMotor("claude", "x").args,
    "--append-system-prompt",
    IDENTIDAD_MARINA,
  ]);
  const codex = comandoMotor("codex", "x").args;
  assert.deepEqual(codex, [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-c",
    'mcp_servers.secondbrain.env_vars=["SB_BRAIN_TOKEN_FILE","SB_BRAIN_URL","SB_AGENTE","SB_SESSION_ID"]',
    "x",
  ]);
  assert.ok(!codex.includes("model_auto_compact_token_limit=350000"));
  assert.deepEqual(comandoMotor("agy", "x").args, [
    "-p",
    "x",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
  ]);
  assert.throws(() => comandoMotor("otro", "x"));
});

test("consulta saldo USD sin registrar la clave y rechaza respuestas no fiables", async () => {
  let solicitud;
  const fetchFn = async (url, options) => {
    solicitud = { url, options };
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
  assert.equal(await saldoDeepSeek("test-key", fetchFn), 0.19);
  assert.equal(solicitud.url, "https://api.deepseek.com/user/balance");
  assert.equal(solicitud.options.headers.Authorization, "Bearer test-key");
  await assert.rejects(
    saldoDeepSeek("test-key", async () => ({
      ok: true,
      json: async () => ({ is_available: false, balance_infos: [] }),
    })),
  );
  await assert.rejects(saldoDeepSeek("", fetchFn));
});

test("las credenciales de proveedores no se mezclan", () => {
  const env = {
    PATH: "/bin",
    CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
    DEEPSEEK_API_KEY: "deepseek-secret",
    AGENTES_DEEPSEEK_DIR: "/deepseek",
  };
  const claude = entornoDe("claude", env);
  const deepseek = entornoDe("deepseek", env);
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
  for (const motor of ["claude", "codex", "agy", "deepseek"]) {
    const args = comandoMotor(motor, "---\nname: x\n---\nhola").args;
    assert.ok(args.includes("Instrucciones:\n---\nname: x\n---\nhola"));
    assert.ok(!args.some((a) => a.startsWith("---")));
  }
});

test("Claude recibe --effort y DeepSeek lo traduce a presupuesto de pensamiento", () => {
  assert.deepEqual(
    comandoMotor("claude", "x", { modelo: "opus", esfuerzo: "max" }).args.slice(
      -4,
    ),
    ["--model", "opus", "--effort", "max"],
  );
  const marina = comandoMotor("deepseek", "x", { esfuerzo: "high" }).args;
  assert.ok(!marina.includes("--effort"));
  assert.deepEqual(entornoEsfuerzo("deepseek", "high"), {
    MAX_THINKING_TOKENS: "32000",
  });
  assert.deepEqual(entornoEsfuerzo("deepseek", "rm -rf"), {});
  assert.deepEqual(entornoEsfuerzo("claude", "high"), {});
});

test("modeloEconomico reconoce -luna en Codex y validarAdjuntosMotor acota capacidades", () => {
  assert.equal(
    modeloEconomico("codex", [{ id: "gpt-5.6" }, { id: "gpt-5.6-luna" }]),
    "gpt-5.6-luna",
  );
  assert.equal(
    modeloEconomico("codex", [{ id: "gpt-5.6-luna" }, { id: "gpt-5-mini" }]),
    "gpt-5-mini",
  );
  assert.throws(
    () =>
      validarAdjuntosMotor("codex", [{ type: "embeddedContext", text: "x" }]),
    /no soporta adjuntos/i,
  );
  assert.throws(
    () =>
      validarAdjuntosMotor(
        "codex",
        [{ type: "localImage", path: "../secreto.png" }],
        "/tmp/sandbox-workspace",
      ),
    /fuera del espacio de trabajo/i,
  );
});
