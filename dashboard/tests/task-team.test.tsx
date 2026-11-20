// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { UI } from "../src/components/ui";
import { TaskRow } from "../src/features/tasks/TaskRow";
import { newItem } from "../src/core/model";
import { taskPrompt } from "../src/core/agent-prompt";
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
    openThread = vi.fn();
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
          openThread,
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
  expect(openThread).toHaveBeenCalledWith({
    engine: "agy",
    projectId: "project-1",
    prompt: taskPrompt(task, [task]),
  });
});
