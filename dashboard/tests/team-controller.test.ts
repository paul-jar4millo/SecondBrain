import { describe, expect, it } from "vitest";
import {
  createTeamController,
  collectJobs,
  agentsForProject,
} from "../src/features/team/team-controller";

describe("shared team controller", () => {
  it("coalesces scene and tool reads and only reads the launcher", async () => {
    const calls: string[] = [];
    const controller = createTeamController(async (path, body) => {
      calls.push(`${body ? "POST" : "GET"} ${path}`);
      return [];
    });
    await Promise.all([controller.refresh(), controller.refresh()]);
    expect(calls).toEqual(["GET /agentes/sesiones?resumen=1"]);
    expect(controller.getSnapshot().connected).toBe(true);
  });

  it("shares observed sessions with the scene and marks the base agent busy", async () => {
    const controller = createTeamController(async () => [
      { id: "s1", motor: "codex", estado: "trabajando", copia: 0 },
    ]);
    await controller.refresh();
    const snapshot = controller.getSnapshot();
    expect(snapshot.sessions?.[0].id).toBe("s1");
    expect(snapshot.agents.find((a) => a.id === "menta")?.ocupada).toBe(true);
  });

  it("keeps the last sessions when the launcher fails", async () => {
    let unavailable = false;
    const controller = createTeamController(async () => {
      if (unavailable) throw new Error("Sin conexión");
      return [{ id: "s1", motor: "claude", estado: "trabajando", copia: 0 }];
    });
    await controller.refresh();
    unavailable = true;
    await controller.refresh();
    expect(controller.getSnapshot().sessions?.[0].id).toBe("s1");
    expect(controller.getSnapshot().connected).toBe(false);
    expect(controller.getSnapshot().error).toBe("Sin conexión");
  });

  it("deduplicates deliveries and attributes projects only from recorded work", () => {
    const agents = [
      {
        id: "ambar",
        ocupada: false,
        historial: [
          {
            jobId: "j1",
            estado: "listo",
            project: "p1",
            respuesta: "Completa",
            fin: "2026-11-07",
          },
        ],
      },
    ];
    const flows = [
      {
        id: "f1",
        project: "p1",
        estado: "listo",
        indice: 4,
        pasos: [
          {
            agente: "ambar",
            nombre: "Investigar",
            zona: "library",
            jobId: "j1",
            estado: "listo",
          },
        ],
      },
    ];
    expect(collectJobs(agents, flows)).toHaveLength(1);
    expect(collectJobs(agents, flows)[0].respuesta).toBe("Completa");
    expect(agentsForProject(agents, flows, "p1")).toEqual(["ambar"]);
    expect(agentsForProject(agents, flows, "p2")).toEqual([]);
  });
});
