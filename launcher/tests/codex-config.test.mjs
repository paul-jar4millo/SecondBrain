import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexArgs,
  buildCodexThreadMcpConfig,
} from "../lib/providers/codex-config.mjs";
import { INHERITED_DESKTOP_CONNECTORS } from "../tool-catalog.mjs";

const SECONDBRAIN = {
  secondbrain: { command: "node", args: ["mcp.mjs"], env: { A: "1" } },
};

test("-c never names a dotted MCP server: Codex would read it as nesting", () => {
  assert.ok(INHERITED_DESKTOP_CONNECTORS.includes("claude.ai"));
  const args = buildCodexArgs({}, SECONDBRAIN);
  const overrides = args.filter((_, i) => args[i - 1] === "-c");
  for (const value of overrides.filter((v) => v.startsWith("mcp_servers."))) {
    const path = value.slice(0, value.indexOf("="));
    assert.doesNotMatch(path, /claude/, value);
  }
  assert.ok(
    overrides.includes(
      'mcp_servers.blender={command="disabled",enabled=false}',
    ),
  );
  assert.ok(overrides.some((v) => v.startsWith("mcp_servers.secondbrain={")));
});

test("thread/start config names no dotted server either", () => {
  const config = buildCodexThreadMcpConfig(SECONDBRAIN);
  for (const key of Object.keys(config))
    assert.doesNotMatch(key, /claude/, key);
  assert.deepEqual(config["mcp_servers.blender"], {
    command: "disabled",
    enabled: false,
  });
  assert.equal(config["mcp_servers.secondbrain"]?.enabled, true);
});
