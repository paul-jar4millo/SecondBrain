// Check startup against the actual pinned binaries without accounts or turns.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { buildCodexArgs } from "../../launcher/lib/providers/codex-config.mjs";
import { claudeStartupOptions } from "../../launcher/lib/providers/claude.mjs";
import {
  prepareAcpLaunchSpec,
  waitChildExit,
} from "../../launcher/lib/providers/shared.mjs";
import { providerRpc } from "../../launcher/provider-rpc.mjs";
import { readPins } from "./pins.mjs";

const execute = promisify(execFile);
const {
  values: { prefix },
} = parseArgs({
  options: { prefix: { type: "string", default: "/opt/sb-agente/cli" } },
});
const bin = (name) => path.resolve(prefix, "current", "bin", name);
const home = await mkdtemp(path.join(tmpdir(), "sb-provider-contract-"));
const codexHome = path.join(home, "codex");
const claudeConfig = path.join(home, "claude");
const workspace = path.join(home, "workspace");
const env = {
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  PATH: process.env.PATH,
  CODEX_HOME: codexHome,
  CLAUDE_CONFIG_DIR: claudeConfig,
  DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  NO_COLOR: "1",
};
const { versions } = await readPins();
const mcpServers = {
  secondbrain: {
    type: "stdio",
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    env: { SB_CONTRACT_FIXTURE: "true" },
  },
};

try {
  await Promise.all(
    [codexHome, claudeConfig, workspace].map((dir) => mkdir(dir)),
  );
  await verifyCodex();
  await verifyClaude();
  await verifyAgy();
} finally {
  await rm(home, { recursive: true, force: true });
}

async function withRpc(program, args, processEnv, validate) {
  const child = spawn(program, args, { cwd: workspace, env: processEnv });
  child.stderr.pipe(process.stderr, { end: false });
  const rpc = providerRpc(child, { timeout: 15_000 });
  try {
    await validate(rpc);
  } finally {
    rpc.close();
    child.stdin.end();
    await waitChildExit(child);
  }
}

async function verifyCodex() {
  await writeFile(
    path.join(codexHome, "config.toml"),
    '[mcp_servers.inherited]\ncommand = "disabled"\n',
  );
  const args = buildCodexArgs(
    { disableInheritedMcp: true, session: { esfuerzo: "high" } },
    mcpServers,
    new Map([["inherited", { enabled: true }]]),
  );
  const { stdout } = await execute(
    bin("codex"),
    [...args.filter((arg) => arg !== "--stdio"), "--print-startup-config"],
    { cwd: workspace, env, timeout: 15_000 },
  );
  assert.equal(typeof JSON.parse(stdout), "object");
  await withRpc(bin("codex"), args, env, async (rpc) => {
    await rpc.call("initialize", {
      clientInfo: { name: "secondbrain", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized", {});
    const result = await rpc.call("config/read", { includeLayers: true });
    assert.equal(result.config.mcp_servers.secondbrain.enabled, true);
    assert.equal(result.config.mcp_servers.inherited.enabled, false);
  });
  console.log("Codex", versions.codex, "startup configuration accepted");
}

async function verifyClaude() {
  const options = claudeStartupOptions({
    cwd: workspace,
    env,
    operatorEnv: { SB_CLAUDE_BIN: bin("claude") },
    mcpServers,
  });
  for (const delivery of ["initialize", "argv"]) {
    const abortController = new AbortController();
    // Give the SDK an open input stream with no user message.
    const prompt = (async function* () {
      yield* await new Promise((resolve) =>
        abortController.signal.addEventListener("abort", () => resolve([]), {
          once: true,
        }),
      );
    })();
    const session = query({
      prompt,
      options: { ...options, abortController, mcpServersDelivery: delivery },
    });
    const timeout = setTimeout(() => abortController.abort(), 15_000);
    try {
      const result = await session.initializationResult();
      assert.equal(result.claude_code_version, versions.claude);
      if (delivery === "initialize")
        assert.equal(result.mcp_servers_applied, true);
    } finally {
      clearTimeout(timeout);
      abortController.abort();
      session.close();
    }
  }
  console.log(
    "Claude",
    versions.claude,
    "MCP initialize and --mcp-config accepted",
  );
}

async function verifyAgy() {
  const spec = await prepareAcpLaunchSpec({
    operatorEnv: { SB_AGY_ACP_BIN: bin("agy") },
    cwd: workspace,
    env,
    geminiDir: path.join(home, "gemini"),
    mcpServers,
  });
  await withRpc(spec.bin, spec.args, spec.env, async (rpc) => {
    const result = await rpc.call("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "secondbrain", version: "1.0.0" },
    });
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.agentInfo.version, versions.agy);
  });
  console.log("Antigravity", versions.agy, "ACP initialize accepted");
}
