// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
vi.mock("../src/core/store", () => ({ api: vi.fn(), isDemo: false }));
import { AgentProfile } from "../src/features/team/AgentProfile";
afterEach(cleanup);

it("shows the agent card without launching any work", () => {
  render(
    <AgentProfile
      target={{ agentId: "ambar", projectId: "p1" }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByRole("heading", { name: "Ámbar" })).toBeTruthy();
  expect(screen.getByText("Sesiones activas")).toBeTruthy();
  expect(screen.getByText("Sin sesiones en curso.")).toBeTruthy();
});
