// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ItemEditor, UI } from "../src/components/ui";
import { editorValue } from "../src/components/editor-value";
import { ProjectDetail } from "../src/features/projects/ProjectDetail";
import { ProjectLine } from "../src/features/projects/ProjectLine";
import { ProjectsPage } from "../src/features/projects/ProjectsPage";
import { FocusTimer } from "../src/features/tasks/FocusTimer";
import { TaskRow } from "../src/features/tasks/TaskRow";
import { newItem, type Item } from "../src/core/model";

const persistence = vi.hoisted(() => ({
  save: vi.fn(async () => {}),
  get: vi.fn<(...args: unknown[]) => Promise<{ value: string } | undefined>>(
    async () => undefined,
  ),
  put: vi.fn<(draft: { key: string; value: string }) => Promise<void>>(
    async () => {},
  ),
  delete: vi.fn(async () => {}),
}));

vi.mock("../src/core/store", () => ({
  api: vi.fn(async () => ({ revision: 1, repositories: [], links: {} })),
  isDemo: false,
  save: persistence.save,
  create: vi.fn(),
  db: {
    meta: {
      get: persistence.get,
      put: persistence.put,
      delete: persistence.delete,
    },
  },
}));

const uiContext = (items: Item[] = []) => ({
  items,
  edit: vi.fn(),
  trash: vi.fn(),
  notify: vi.fn(),
  ask: vi.fn(),
  openThread: vi.fn(),
});

beforeAll(() => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("Flujo de proyectos, estados y temporizador", () => {
  it("ItemEditor para proyectos ofrece los estados unificados y usa active por defecto al crear y editar legado", async () => {
    const user = userEvent.setup();
    const close = vi.fn();

    render(
      <MemoryRouter>
        <UI.Provider value={uiContext()}>
          <ItemEditor value="project" onClose={close} />
        </UI.Provider>
      </MemoryRouter>,
    );

    const select = screen.getByLabelText("Estado") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => [o.value, o.text]);
    expect(options).toEqual([
      ["active", "En marcha"],
      ["paused", "Pausado"],
      ["done", "Completado"],
      ["archived", "Archivado"],
    ]);
    expect(select.value).toBe("active");

    await user.type(screen.getByLabelText("Título"), "Lanzamiento Q4");
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "project",
        title: "Lanzamiento Q4",
        status: "active",
      }),
    );

    cleanup();
    vi.clearAllMocks();

    const legacyProject: Item = {
      ...newItem("project"),
      id: "proj-legacy",
      title: "Proyecto legado",
      status: "pending",
    };

    render(
      <MemoryRouter>
        <UI.Provider value={uiContext([legacyProject])}>
          <ItemEditor value={legacyProject} onClose={close} />
        </UI.Provider>
      </MemoryRouter>,
    );

    const editSelect = screen.getByLabelText("Estado") as HTMLSelectElement;
    expect(editSelect.value).toBe("active");

    await user.click(screen.getByRole("button", { name: "Guardar cambios" }));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "proj-legacy",
        status: "active",
      }),
    );
  });

  it("ProjectLine muestra En marcha para active y Completado en masculino para done", () => {
    const activeProject: Item = {
      ...newItem("project"),
      id: "proj-active",
      title: "Proyecto activo",
      status: "active",
    };
    const doneProject: Item = {
      ...newItem("project"),
      id: "proj-done",
      title: "Proyecto terminado",
      status: "done",
    };

    render(
      <MemoryRouter>
        <UI.Provider value={uiContext([activeProject, doneProject])}>
          <ProjectLine project={activeProject} detailed />
          <ProjectLine project={doneProject} detailed />
        </UI.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText("En marcha")).toBeTruthy();
    expect(screen.getByText("Completado")).toBeTruthy();
  });

  it("ProjectsPage muestra estado vacío en En marcha sin proyectos activos ni dashboards sueltos y oculta dashboards en Completados", async () => {
    const user = userEvent.setup();
    const completedDashboardProject: Item = {
      ...newItem("project"),
      id: "proj-mundo-done",
      title: "Mundo Hipotético",
      status: "done",
      vaultPath: "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
    };

    const { rerender } = render(
      <MemoryRouter>
        <UI.Provider value={uiContext([completedDashboardProject])}>
          <ProjectsPage />
        </UI.Provider>
      </MemoryRouter>,
    );

    expect(screen.getByText("Sin proyectos aquí.")).toBeTruthy();
    expect(screen.queryByText("Abrir panel del canal")).toBeNull();

    const activeDashboardProject: Item = {
      ...newItem("project"),
      id: "proj-mundo-active",
      title: "Mundo Hipotético",
      status: "active",
      vaultPath: "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
    };

    rerender(
      <MemoryRouter>
        <UI.Provider value={uiContext([activeDashboardProject])}>
          <ProjectsPage />
        </UI.Provider>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Completados" }));
    expect(screen.getByText("Sin proyectos aquí.")).toBeTruthy();
    expect(screen.queryByText("Abrir panel del canal")).toBeNull();
  });

  it("FocusTimer conserva los segundos pausados al desmontar y volver a montar", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T10:00:00Z"));
    const ctx = uiContext();

    const view = render(
      <UI.Provider value={ctx}>
        <FocusTimer />
      </UI.Provider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Iniciar enfoque" }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(view.container.textContent).toContain("24:55");

    fireEvent.click(screen.getByRole("button", { name: "Pausar enfoque" }));
    expect(sessionStorage.getItem("sb-focus-deadline")).toBeNull();
    expect(sessionStorage.getItem("sb-focus-paused")).toBe("1495");

    view.unmount();

    const remounted = render(
      <UI.Provider value={ctx}>
        <FocusTimer />
      </UI.Provider>,
    );

    expect(remounted.container.textContent).toContain("24:55");

    fireEvent.click(screen.getByRole("button", { name: "Iniciar enfoque" }));
    expect(sessionStorage.getItem("sb-focus-paused")).toBeNull();
    expect(sessionStorage.getItem("sb-focus-deadline")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Reiniciar enfoque" }));
    expect(remounted.container.textContent).toContain("25:00");
    expect(sessionStorage.getItem("sb-focus-deadline")).toBeNull();
    expect(sessionStorage.getItem("sb-focus-paused")).toBeNull();
  });

  it("editorValue asigna status active por defecto a project y pending a task", () => {
    const project = editorValue(
      { ...newItem("project"), title: "Nuevo proyecto", status: "" },
      "",
      {},
    );
    const task = editorValue(
      { ...newItem("task"), title: "Nueva tarea", status: "" },
      "",
      {},
    );

    expect(project.status).toBe("active");
    expect(task.status).toBe("pending");
  });

  it("ProjectDetail conserva y muestra Archivado cuando el proyecto tiene status archived", async () => {
    const archivedProject: Item = {
      ...newItem("project"),
      id: "proj-arch",
      title: "Proyecto archivado",
      status: "archived",
    };

    render(
      <MemoryRouter initialEntries={["/projects/proj-arch"]}>
        <UI.Provider value={uiContext([archivedProject])}>
          <Routes>
            <Route path="/projects/:id" element={<ProjectDetail />} />
          </Routes>
        </UI.Provider>
      </MemoryRouter>,
    );

    const select = screen.getByLabelText("Estado") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => [o.value, o.text])).toEqual([
      ["active", "En marcha"],
      ["paused", "Pausado"],
      ["done", "Completado"],
      ["archived", "Archivado"],
    ]);
    expect(select.value).toBe("archived");
    expect(select.selectedOptions[0]?.textContent).toBe("Archivado");
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Repositorio del proyecto") as HTMLSelectElement)
          .disabled,
      ).toBe(false),
    );
  });

  it("TaskRow permite marcar una 3.ª prioridad activa aunque exista una tarea cancelled con priority true", async () => {
    const user = userEvent.setup();
    const p1: Item = {
      ...newItem("task"),
      id: "t1",
      title: "Prioridad 1",
      status: "pending",
      priority: true,
    };
    const p2: Item = {
      ...newItem("task"),
      id: "t2",
      title: "Prioridad 2",
      status: "pending",
      priority: true,
    };
    const cancelledPriority: Item = {
      ...newItem("task"),
      id: "t-cancelled",
      title: "Cancelada prioritaria",
      status: "cancelled",
      priority: true,
    };
    const candidate: Item = {
      ...newItem("task"),
      id: "t3",
      title: "Tercera prioridad",
      status: "pending",
      priority: false,
    };
    const ctx = uiContext([p1, p2, cancelledPriority, candidate]);

    render(
      <UI.Provider value={ctx}>
        <TaskRow task={candidate} />
      </UI.Provider>,
    );

    await user.click(
      screen.getByRole("button", { name: "Elegir como prioridad" }),
    );

    expect(ctx.notify).not.toHaveBeenCalled();
    expect(persistence.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "t3",
        priority: true,
      }),
    );
  });
});
