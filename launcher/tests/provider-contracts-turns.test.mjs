import assert from "node:assert/strict";

import os from "node:os";

import { randomUUID } from "node:crypto";

import { test } from "node:test";

import {
  createAcpController,
  createCodexController,
} from "../provider-controllers.mjs";

import { createStreamFakeProcess } from "./helpers/provider-fakes.mjs";

test("regresión: Codex ignora turn-1 atrasado e hilo ajeno durante turno-2 y maneja carrera legítima turn/started; ACP aísla sesión y generación", async (t) => {
  const ctrl = createCodexController();
  t.after(() => ctrl.shutdown("fin"));

  let turnCallCount = 0;
  let _sendFn = null;
  let askInvocations = 0;

  const makeCtx = (promptText, overrides = {}) => ({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "codex" },
    cwd: os.tmpdir(),
    prompt: promptText,
    attachments: [],
    mcpServers: {},
    env: {},
    operatorEnv: {},
    disableInheritedMcp: false,
    delta: (...args) => overrides.deltas?.push(args),
    message: (...args) => overrides.messages?.push(args),
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => {
      askInvocations += 1;
      return { decision: "accept" };
    },
    spawn() {
      return createStreamFakeProcess((msg, send) => {
        _sendFn = send;
        if (msg.method === "initialize") {
          send({ id: msg.id, result: {} });
        } else if (msg.method === "thread/start") {
          send({ id: msg.id, result: { thread: { id: "thread-A" } } });
        } else if (msg.method === "turn/start") {
          turnCallCount += 1;
          if (turnCallCount === 1) {
            send({ id: msg.id, result: { turn: { id: "turn-1" } } });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-A",
                turn: { id: "turn-1", status: "completed" },
              },
            });
          } else if (turnCallCount === 2) {
            // Simulate stale turn-1 delayed events + foreign thread BEFORE turn/start response
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-A",
                turnId: "turn-1",
                itemId: "stale-1",
                delta: "STALE_DELTA",
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-A",
                turn: { id: "turn-1", status: "completed" },
              },
            });
            send({
              method: "turn/completed",
              params: {
                threadId: "thread-B",
                turn: { id: "turn-9", status: "completed" },
              },
            });
            setTimeout(() => {
              // Respond turn/start with turn-2 AFTER stale turn-1 completion arrived
              send({ id: msg.id, result: { turn: { id: "turn-2" } } });
              // Stale callback from turn-1 during active turn-2 MUST be rejected (-32601)
              send({
                id: 7001,
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "thread-A",
                  turnId: "turn-1",
                  questions: [{ id: "q", question: "stale?" }],
                },
              });
              // Stale turn-1 completion again while turn-2 active
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-1", status: "completed" },
                },
              });
              send({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "thread-A",
                  turnId: "turn-2",
                  itemId: "ok-2",
                  delta: "REAL_TURN_2",
                },
              });
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-2", status: "completed" },
                },
              });
            }, 30);
          } else if (turnCallCount === 3) {
            // Legitimate race: turn/started + delta BEFORE rpc response for turn/start
            send({
              method: "turn/started",
              params: { threadId: "thread-A", turn: { id: "turn-race-3" } },
            });
            send({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-A",
                turnId: "turn-race-3",
                itemId: "r-3",
                delta: "RACE_OK",
              },
            });
            setTimeout(() => {
              send({ id: msg.id, result: { turn: { id: "turn-race-3" } } });
              send({
                method: "turn/completed",
                params: {
                  threadId: "thread-A",
                  turn: { id: "turn-race-3", status: "completed" },
                },
              });
            }, 20);
          }
        }
      });
    },
  });

  const t1Out = await ctrl.runTurn(makeCtx("uno"));
  assert.equal(t1Out.turnId, "turn-1");

  const d2 = [];
  const t2Out = await ctrl.runTurn(makeCtx("dos", { deltas: d2 }));
  assert.equal(t2Out.turnId, "turn-2");
  assert.equal(askInvocations, 0);
  assert.deepEqual(
    d2.map((x) => x[1]),
    ["REAL_TURN_2"],
  );

  const d3 = [];
  const t3Out = await ctrl.runTurn(makeCtx("tres", { deltas: d3 }));
  assert.equal(t3Out.turnId, "turn-race-3");
  assert.deepEqual(
    d3.map((x) => x[1]),
    ["RACE_OK"],
  );

  // ACP isolation: foreign sessionId updates ignored, orphan between prompts ignored
  const acpCtrl = createAcpController();
  t.after(() => acpCtrl.shutdown("fin"));
  let acpSend = null;
  const acpDeltas = [];
  await acpCtrl.runTurn({
    turnId: randomUUID(),
    session: { id: randomUUID(), motor: "agy" },
    cwd: os.tmpdir(),
    prompt: "acp-1",
    mcpServers: {},
    env: {},
    operatorEnv: { SB_AGY_ACP_ARGS: JSON.stringify(["acp-mock"]) },
    delta: (...a) => acpDeltas.push(a),
    message: () => {},
    tool: () => {},
    expire: () => {},
    artifact: async () => {},
    onAbort: () => {},
    onControl: () => {},
    invalidateConnection: () => {},
    nativeId: async () => {},
    nextId: () => 1,
    ask: async () => ({ decision: "cancel" }),
    spawn() {
      return createStreamFakeProcess((msg, send) => {
        acpSend = send;
        if (msg.method === "initialize") {
          send({
            id: msg.id,
            result: { protocolVersion: 1, agentCapabilities: {} },
          });
        } else if (msg.method === "session/new") {
          send({ id: msg.id, result: { sessionId: "acp-sess-1" } });
        } else if (msg.method === "session/prompt") {
          send({
            method: "session/update",
            params: {
              sessionId: "acp-sess-AJENA",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "AJENO" },
              },
            },
          });
          send({
            method: "session/update",
            params: {
              sessionId: "acp-sess-1",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "MIO" },
              },
            },
          });
          send({ id: msg.id, result: { stopReason: "end_turn" } });
        }
      });
    },
  });
  assert.deepEqual(
    acpDeltas.map((x) => x[1]),
    ["MIO"],
  );
  // Stale update sent outside active prompt MUST NOT mutate anything
  acpSend({
    method: "session/update",
    params: {
      sessionId: "acp-sess-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "TARDE" },
      },
    },
  });
  assert.deepEqual(
    acpDeltas.map((x) => x[1]),
    ["MIO"],
  );
});
