import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { runCodex, runClaude, runAcp } from "../provider-adapters.mjs";

function fakeProcess(handle) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _enc, callback) {
      for (const line of chunk.toString().trim().split("\n")) {
        const value = JSON.parse(line);
        setImmediate(() =>
          handle(value, (message) =>
            child.stdout.write(JSON.stringify(message) + "\n"),
          ),
        );
      }
      callback();
    },
  });
  child.kill = () => {
    child.stdin.end();
    child.emit("exit", 0);
  };
  return child;
}
function context(overrides = {}) {
  const items = [];
  const ids = [];
  return {
    session: { motor: "codex", modelo: "test-model", esfuerzo: "medium" },
    env: {},
    operatorEnv: {},
    cwd: "/synthetic",
    prompt: "Hola",
    items,
    ids,
    nativeId: async (id) => ids.push(id),
    message: (...item) => items.push(item),
    delta: (...item) => items.push(item),
    tool: (...item) => items.push(item),
    expire: () => {},
    onAbort: () => {},
    nextId: () => 1,
    ask: async () => ({ preference: "remoto" }),
    ...overrides,
  };
}

test("Codex usa App Server, responde solicitudes RPC y conserva modelo/esfuerzo", async () => {
  const calls = [];
  const ctx = context({
    spawn(bin, args) {
      assert.equal(bin, "codex");
      assert.deepEqual(args, ["app-server", "--stdio"]);
      return fakeProcess((m, send) => {
        calls.push(m);
        if (m.method === "initialize") send({ id: m.id, result: {} });
        if (m.method === "thread/start")
          send({ id: m.id, result: { thread: { id: "native-thread" } } });
        if (m.method === "turn/start") {
          send({ id: m.id, result: { turn: { id: "turn-1" } } });
          send({
            id: "question-1",
            method: "item/tool/requestUserInput",
            params: {
              questions: [{ id: "preference", question: "¿Modalidad?" }],
            },
          });
        }
        if (m.id === "question-1") {
          assert.deepEqual(m.result.answers.preference.answers, ["remoto"]);
          send({
            method: "item/completed",
            params: { item: { type: "agentMessage", id: "a1", text: "Listo" } },
          });
          send({
            method: "turn/completed",
            params: { turn: { status: "completed" } },
          });
        }
      });
    },
  });
  await runCodex(ctx);
  assert.equal(
    calls.find((c) => c.method === "thread/start").params.model,
    "test-model",
  );
  assert.equal(
    calls.find((c) => c.method === "turn/start").params.effort,
    "medium",
  );
  assert.deepEqual(ctx.items, [["a1", "Listo"]]);
});

test("Claude utiliza el SDK oficial con sesión nativa, preguntas y permisos explícitos", async () => {
  let options;
  const ctx = context({
    session: { motor: "claude", conversacionId: "native-1" },
  });
  const query = (args) => {
    options = args.options;
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        const answer = await options.canUseTool(
          "AskUserQuestion",
          { questions: [{ question: "preference", options: [] }] },
          { toolUseID: "q1" },
        );
        assert.equal(answer.updatedInput.answers.preference, "remoto");
        yield {
          type: "assistant",
          uuid: "a1",
          session_id: "native-1",
          message: { content: [{ type: "text", text: "OK" }] },
        };
        yield { type: "result", is_error: false };
      },
    };
  };
  await runClaude(ctx, query);
  assert.equal(options.resume, "native-1");
  assert.equal(options.permissionMode, "default");
  assert.equal(options.strictMcpConfig, true);
  assert.deepEqual(ctx.items, [["a1:text:0", "OK"]]);
});

test("ACP negocia capacidades y entrega notificaciones de herramientas sin leer transcripts", async () => {
  const ctx = context({
    session: { motor: "agy", modelo: "model-1" },
    spawn() {
      return fakeProcess((m, send) => {
        if (!m.method) return;
        const result =
          m.method === "initialize"
            ? { agentCapabilities: { loadSession: true } }
            : m.method === "session/new"
              ? { sessionId: "acp-1" }
              : m.method === "session/prompt"
                ? { stopReason: "end_turn" }
                : {};
        if (m.method === "session/prompt")
          send({
            method: "session/update",
            params: {
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "t1",
                title: "Consulta",
                status: "pending",
              },
            },
          });
        send({ id: m.id, result });
      });
    },
  });
  await runAcp(ctx);
  assert.equal(ctx.ids[0], "acp-1");
  assert.equal(ctx.items[0][0], "t1");
});

test("Codex soporta elicitación MCP, turn/steer, turn/interrupt y rechaza model/rerouted", async () => {
  const sent = [];
  let ctrl;
  const ctx = context({
    session: {
      motor: "codex",
      modelo: "gpt-5.6-luna",
      esfuerzo: "high",
      conversacionId: "thread-prev",
    },
    onControl: (c) => {
      ctrl = c;
    },
    ask: async (id, req) => {
      if (req.serverName === "synthetic") {
        return { decision: "accept", content: { choice: "allow_once" } };
      }
      return { decision: "decline" };
    },
    spawn() {
      return fakeProcess((m, send) => {
        sent.push(m);
        if (m.method === "initialize") send({ id: m.id, result: {} });
        if (m.method === "thread/resume")
          send({ id: m.id, result: { thread: { id: "thread-prev" } } });
        if (m.method === "turn/start") {
          send({ id: m.id, result: { turn: { id: "turn-99" } } });
          send({
            id: "elicit-1",
            method: "mcpServer/elicitation/request",
            params: {
              serverName: "synthetic",
              mode: "form",
              message: "Autorizar consulta una vez",
              requestedSchema: {
                type: "object",
                properties: {
                  choice: { enum: ["allow_always", "allow_once", "decline"] },
                },
              },
            },
          });
        }
        if (m.id === "elicit-1") {
          assert.equal(m.result.action, "accept");
          assert.equal(m.result.content.choice, "allow_once");
          void ctrl.steer("Ajusta enfoque").then(() => {
            send({
              method: "turn/completed",
              params: { turn: { id: "turn-99", status: "completed" } },
            });
          });
        }
        if (m.method === "turn/steer") {
          assert.equal(m.params.expectedTurnId, "turn-99");
          send({ id: m.id, result: { ok: true } });
        }
      });
    },
  });
  const res = await runCodex(ctx);
  assert.equal(res.status, "completed");
  const startCall = sent.find((m) => m.method === "turn/start");
  assert.equal(startCall.params.model, "gpt-5.6-luna");
  assert.equal(startCall.params.effort, "high");

  // Silent model reroute must be rejected explicitly
  await assert.rejects(
    runCodex(
      context({
        session: { motor: "codex", modelo: "gpt-5.6-luna" },
        spawn() {
          return fakeProcess((m, send) => {
            if (m.method === "initialize") send({ id: m.id, result: {} });
            if (m.method === "thread/start")
              send({ id: m.id, result: { thread: { id: "th-reroute" } } });
            if (m.method === "turn/start") {
              send({ id: m.id, result: { turn: { id: "t-r" } } });
              send({
                method: "model/rerouted",
                params: { toModel: "cheaper-model" },
              });
            }
          });
        },
      }),
    ),
    /redirigió el modelo/,
  );
});

test("ACP reenvía mcpServers en resume, reaplica set_config_option, prioriza allow_once y cancela con session/cancel", async () => {
  const rpcLog = [];
  let abortFn;
  let permOutcome;
  const ctx = context({
    session: {
      motor: "agy",
      modelo: "gemini-3.8-flash-medium",
      conversacionId: "acp-resume-1",
    },
    attachments: [
      { type: "embeddedContext", uri: "mem://nota", text: "contexto" },
    ],
    mcpServers: {
      secondbrain: { command: "node", args: ["mcp.mjs"], env: { SB: "1" } },
    },
    onAbort: (fn) => {
      abortFn = fn;
    },
    ask: async (_id, req) => {
      // allow_always MUST be stripped before choices reach decision
      assert.ok(!req.choices.includes("always-id"));
      assert.deepEqual(req.choices, ["once-id", "reject-id"]);
      return { decision: "once-id" };
    },
    spawn() {
      return fakeProcess((m, send) => {
        if (m.method) rpcLog.push(m);
        if (m.method === "initialize")
          return send({
            id: m.id,
            result: {
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: true },
              },
            },
          });
        if (m.method === "session/resume")
          return send({ id: m.id, result: { sessionId: "acp-resume-1" } });
        if (m.method === "session/set_config_option")
          return send({
            id: m.id,
            result: {
              configOptions: [
                {
                  id: "model",
                  category: "model",
                  currentValue: "gemini-3.8-flash",
                },
                {
                  id: "thought_level",
                  category: "thought_level",
                  currentValue: "medium",
                },
              ],
            },
          });
        if (m.method === "session/prompt") {
          send({
            id: "perm-1",
            method: "session/request_permission",
            params: {
              toolCall: { title: "Leer nota sintética" },
              options: [
                {
                  optionId: "always-id",
                  kind: "allow_always",
                  name: "Siempre",
                },
                {
                  optionId: "reject-id",
                  kind: "reject_once",
                  name: "Rechazar",
                },
                { optionId: "once-id", kind: "allow_once", name: "Una vez" },
              ],
            },
          });
        }
        if (m.id === "perm-1") {
          permOutcome = m.result;
          abortFn();
        }
        if (m.method === "session/cancel") {
          const promptReq = rpcLog.find((c) => c.method === "session/prompt");
          send({ id: promptReq.id, result: { stopReason: "cancelled" } });
        }
      });
    },
  });
  const outcome = await runAcp(ctx);
  assert.equal(outcome.status, "interrupted");
  assert.equal(permOutcome.outcome.optionId, "once-id");
  const resumeCall = rpcLog.find((m) => m.method === "session/resume");
  assert.equal(resumeCall.params.mcpServers[0].name, "secondbrain");
  const cfgCall = rpcLog.find((m) => m.method === "session/set_config_option");
  assert.equal(cfgCall.params.value, "gemini-3.8-flash-medium");
  const promptCall = rpcLog.find((m) => m.method === "session/prompt");
  assert.equal(promptCall.params.prompt[1].type, "resource");
});

test("Claude fija mcpServersDelivery='initialize', soporta onElicitation y DeepSeek respeta bloqueo de gasto", async () => {
  let sdkOptions;
  let elicitResult;
  await runClaude(
    context({
      session: { motor: "claude", modelo: "opus" },
      ask: async () => ({ decision: "accept", content: { ok: true } }),
    }),
    ({ options }) => {
      sdkOptions = options;
      return {
        close() {},
        async *[Symbol.asyncIterator]() {
          elicitResult = await options.onElicitation({
            serverName: "synthetic",
            mode: "form",
            message: "Confirmar lectura",
            requestedSchema: { type: "object", properties: {} },
          });
          yield { type: "result", is_error: false };
        },
      };
    },
  );
  assert.equal(sdkOptions.mcpServersDelivery, "initialize");
  assert.equal(elicitResult.action, "accept");

  // DeepSeek without explicit billing authorization MUST be rejected before calling SDK
  let sdkInvoked = false;
  await assert.rejects(
    runClaude(context({ session: { motor: "deepseek" } }), () => {
      sdkInvoked = true;
      return { close() {}, async *[Symbol.asyncIterator]() {} };
    }),
    /gasto/,
  );
  assert.equal(sdkInvoked, false);
});
