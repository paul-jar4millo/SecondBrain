// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { UI } from "../src/components/ui";
import { TaskRow } from "../src/features/tasks/TaskRow";
import { newItem } from "../src/core/model";
import { draftKey, prepareAgentDraft } from "../src/features/team/agent-draft";
vi.mock("../src/core/store", () => ({
  api: vi.fn(),
  isDemo: false,
  save: vi.fn(),
  create: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("opens the selected agent with the task and project without saving or executing the task", async () => {
  const user = userEvent.setup(),
    openAgent = vi.fn();
  const task = {
    ...newItem("task"),
    id: "task-1",
    title: "Revisar el borrador",
    projectId: "project-1",
    status: "pending",
  };
  render(
    <MemoryRouter>
      <UI.Provider
        value={{
          items: [task],
          edit: vi.fn(),
          trash: vi.fn(),
          ask: vi.fn(),
          notify: vi.fn(),
          openAgent,
          openTeam: vi.fn(),
        }}
      >
        <TaskRow task={task} />
      </UI.Provider>
    </MemoryRouter>,
  );
  await user.click(
    screen.getByRole("button", {
      name: "Consultar equipo: Revisar el borrador",
    }),
  );
  await user.click(
    screen.getByRole("button", { name: "Consultar a Lira para esta tarea" }),
  );
  expect(openAgent).toHaveBeenCalledWith({
    agentId: "lira",
    projectId: "project-1",
    taskId: "task-1",
  });
});

it("prepareAgentDraft does not duplicate identical or already included text", () => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) || null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });

  const key = draftKey("p1", "agy");
  const route = prepareAgentDraft("p1", "lira", "  Revisar la tarea  ");
  expect(route).toBe("/team?project=p1&agent=lira&chat=new");
  expect(storage.get(key)).toBe("Revisar la tarea");

  prepareAgentDraft("p1", "lira", "Revisar la tarea");
  expect(storage.get(key)).toBe("Revisar la tarea");

  storage.set(key, "Nota previa");
  prepareAgentDraft("p1", "lira", "Revisar la tarea");
  prepareAgentDraft("p1", "lira", "Revisar la tarea");
  expect(storage.get(key)).toBe("Nota previa\n\nRevisar la tarea");
});
