import { describe, expect, it } from "vitest";
import {
  sceneSessions,
  conciliarCopias,
} from "../src/features/room/room-sessions";
import { characterState } from "../src/features/room/team-panel";

import { fixtureThread } from "./thread-fixture";

describe("threads in the refuge", () => {
  it("preserves the four base figures and adds a copy for concurrent work", () => {
    const { agents, copies, figures } = sceneSessions([
      fixtureThread("b", "codex", "waiting-user", "a"),
      fixtureThread("a", "codex", "running"),
      fixtureThread("c", "claude", "done"),
    ]);
    expect(agents.filter((agent) => !agent.id.includes("#"))).toHaveLength(4);
    expect(copies).toEqual([{ id: "menta#1", baseId: "menta", copy: 1 }]);
    expect([...figures]).toEqual([
      ["a", "menta"],
      ["b", "menta#1"],
    ]);
    expect(
      characterState(agents.find((agent) => agent.id === "menta#1")!),
    ).toMatchObject({
      esperando: true,
      trabajando: false,
      jobId: "b",
    });
    expect(agents.find((agent) => agent.id === "ambar")).toMatchObject({
      ocupada: false,
      ultimo: { jobId: "c", estado: "listo" },
    });
  });

  it("adds and removes only the copies that changed", () => {
    expect(
      conciliarCopias(["menta#1", "lira#1"], ["menta#1", "ambar#2"]),
    ).toEqual({ crear: ["ambar#2"], retirar: ["lira#1"] });
  });
});
