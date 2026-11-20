import { expect, it, vi } from "vitest";
import { demoAgentsApi } from "../src/features/room/room-agents-demo";
import { createTeamController } from "../src/features/team/team-controller";

it("abre Equipo en demo con sus sesiones sintéticas y sin un error de servicio", async () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  try {
    const team = createTeamController(async (path) => demoAgentsApi(path));
    await team.refresh();
    expect(team.getSnapshot().error).toBe("");
    expect(team.getSnapshot().sessions).toHaveLength(3);
    expect(team.getSnapshot().connected).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
