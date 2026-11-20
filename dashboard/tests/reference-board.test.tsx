// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { ReferenceBoard } from "../src/features/projects/ReferenceBoard";
const fixture = vi.hoisted(() => ({
  finish: null as null | ((ids: string[]) => void),
}));
vi.mock("../src/core/store", () => ({ isDemo: true }));
vi.mock("../src/features/agents/agent-api", () => ({
  agentApi: async (path: string) => {
    if (path === "/sala/tablero")
      return new Promise<string[]>((resolve) => {
        fixture.finish = resolve;
      });
    const id = path.includes("p1") ? "first" : "second";
    return {
      pines: [
        { id, titulo: id, url: "https://example.com/", imagen: "/example.png" },
      ],
      tablero: [id],
    };
  },
}));
afterEach(cleanup);
it("does not apply a late board mutation to the project opened in the meantime", async () => {
  const user = userEvent.setup();
  const view = render(<ReferenceBoard projectId="p1" />);
  await screen.findByRole("heading", { name: "first" });
  await user.click(screen.getByRole("button", { name: "Quitar del tablero" }));
  view.rerender(<ReferenceBoard projectId="p2" />);
  await screen.findByRole("heading", { name: "second" });
  await act(async () => {
    fixture.finish?.([]);
  });
  expect(screen.getByRole("heading", { name: "second" })).toBeTruthy();
});
