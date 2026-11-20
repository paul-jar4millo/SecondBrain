// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewThreadDialog } from "../src/features/threads/dialogs";
import { ThreadsPage } from "../src/features/threads/ThreadsPage";
import { fixtureThread } from "./thread-fixture";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/core/store", () => ({ api, isDemo: false }));

const thread = {
  ...fixtureThread("thr_integration", "codex", "running"),
  title: "Revisión sintética",
  kind: "repo" as const,
  repo: {
    path: "/repos/fixture",
    baseBranch: "main",
    branch: "sb/fixture",
    worktree: "/tmp/wt",
  },
};
const newThread = {
  ...fixtureThread("thr_created", "codex", "idle"),
  title: "Thread creado",
};
const patch =
  "diff --git a/readme.md b/readme.md\n@@ -1 +1 @@\n-anterior\n+nuevo\n contexto";
const streams: FakeStream[] = [];

class FakeStream {
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  closed = false;
  constructor(readonly url: string) {
    streams.push(this);
    queueMicrotask(() => {
      if (!this.closed) this.onopen?.();
    });
  }
  close() {
    this.closed = true;
  }
}

function renderPage(path = "/threads") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/threads" element={<ThreadsPage />} />
        <Route path="/threads/:id" element={<ThreadsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function submitBody(path: string) {
  const request = api.mock.calls.find(
    ([url, options]) => url === path && options?.method === "POST",
  );
  expect(request).toBeDefined();
  return JSON.parse(request![1].body);
}

beforeEach(() => {
  streams.length = 0;
  window.localStorage.clear();
  vi.stubGlobal("EventSource", FakeStream);
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  let current = thread;
  let entries = [
    {
      threadId: thread.id,
      threadTitle: thread.title,
      requestId: "req_test",
      reason: "question",
      summary: "Falta una decisión",
    },
  ];
  api.mockImplementation(async (path: string, options?: RequestInit) => {
    if (path === "/threads" && options?.method !== "POST")
      return { threads: [current], globalSeq: 3 };
    if (path === "/threads") return { thread: newThread };
    if (path === "/bandeja") return { entries };
    if (path === "/agentes/espacios")
      return { vinculos: { project: "fixture" } };
    if (path === "/agentes/proyectos-lanzador") return ["fixture"];
    if (path === "/agentes/modelos-lanzador")
      return {
        codex: [
          { id: "model-test", nombre: "Modelo de prueba", esfuerzos: ["high"] },
        ],
      };
    if (path === "/agentes/uso") return {};
    if (path === "/threads/detalle?id=" + thread.id)
      return { thread: current, items: [], requests: [], lastSeq: 3 };
    if (path === "/threads/detalle?id=" + newThread.id)
      return { thread: newThread, items: [], requests: [], lastSeq: 0 };
    if (path === "/threads/diff?id=" + thread.id)
      return {
        files: [
          {
            path: "readme.md",
            change: "modify",
            patch,
            additions: 1,
            deletions: 1,
          },
        ],
      };
    if (path === "/threads/cerrar") {
      current = { ...current, status: "done" };
      return { thread: current };
    }
    if (path === "/threads/archivar") {
      current = { ...current, status: "archived" };
      entries = [];
      return { thread: current };
    }
    if (path === "/threads/mensajes" || path === "/threads/interrumpir")
      return {};
    throw new Error("Unexpected endpoint " + path);
  });
});

afterEach(() => {
  cleanup();
  api.mockReset();
  vi.unstubAllGlobals();
});

it("opens the inbox, resumes the detail stream, steers and reviews the diff", async () => {
  const user = userEvent.setup();
  renderPage();
  const inbox = await screen.findByRole("region", { name: "Bandeja" });
  await user.click(
    within(inbox).getByRole("link", { name: /Falta una decisión/ }),
  );
  await screen.findByRole("heading", { name: thread.title });
  const stream = streams.find((entry) => entry.url.includes("/flujo?"));
  expect(stream?.url).toContain("after=3");
  expect(
    streams.some((entry) => entry.url === "/api/v1/threads/feed?after=3"),
  ).toBe(true);
  await user.type(
    screen.getByRole("textbox", { name: "Mensaje" }),
    "Conserva el encabezado",
  );
  await user.click(screen.getByRole("button", { name: "Redirigir" }));
  expect(submitBody("/threads/mensajes")).toEqual({
    id: thread.id,
    mode: "steer",
    text: "Conserva el encabezado",
  });
  await user.click(screen.getByRole("button", { name: "Detener" }));
  expect(submitBody("/threads/interrumpir")).toEqual({ id: thread.id });
  expect(await screen.findByText("+nuevo")).toHaveClass("diff-add");
  await user.click(screen.getByRole("tab", { name: "Plan" }));
  expect(
    screen.getByText("El agente aún no ha publicado un plan."),
  ).toBeTruthy();
  act(() =>
    stream?.onmessage?.({
      data: JSON.stringify({ type: "snapshot-required" }),
    }),
  );
  await waitFor(() => expect(stream?.closed).toBe(true));
  await waitFor(() =>
    expect(
      streams.filter((entry) => entry.url.includes("/flujo?")),
    ).toHaveLength(2),
  );
});

it("creates a linked repo thread only after submission and recovers a saved brief", async () => {
  const user = userEvent.setup();
  const draftKey = "sb-chat-draft:project:codex";
  localStorage.setItem(draftKey, "Borrador anterior");
  const onCreated = vi.fn();
  render(
    <NewThreadDialog
      projectId="project"
      initialEngine="codex"
      initialPrompt="Nuevo encargo"
      onClose={vi.fn()}
      onCreated={onCreated}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Nuevo thread" });
  expect(within(dialog).getByRole("textbox", { name: "Tarea" })).toHaveValue(
    "Borrador anterior\n\nNuevo encargo",
  );
  await waitFor(() =>
    expect(
      within(dialog).getByLabelText("Proyecto", { exact: true }),
    ).toHaveValue("fixture"),
  );
  expect(
    api.mock.calls.some(
      ([url, opts]) => url === "/threads" && opts?.method === "POST",
    ),
  ).toBe(false);
  await user.click(
    within(dialog).getByRole("radio", { name: /Preguntar antes/ }),
  );
  await user.click(
    within(dialog).getByRole("button", { name: "Crear thread" }),
  );
  expect(submitBody("/threads")).toEqual({
    kind: "repo",
    repoPath: "fixture",
    autonomy: "ask",
    prompt: "Borrador anterior\n\nNuevo encargo",
    agent: { engine: "codex", model: "model-test" },
  });
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(newThread));
  expect(localStorage.getItem(draftKey)).toBeNull();
});

it("closes a repo thread by local merge and asks before archiving", async () => {
  const user = userEvent.setup();
  renderPage("/threads/" + thread.id);
  await user.click(
    await screen.findByRole("button", { name: "Cerrar thread" }),
  );
  const close = screen.getByRole("dialog", { name: "Cerrar thread" });
  await user.click(
    within(close).getByRole("radio", { name: /Integrar en local/ }),
  );
  await user.click(within(close).getByRole("button", { name: "Integrar" }));
  expect(submitBody("/threads/cerrar")).toEqual({
    id: thread.id,
    mode: "merge",
  });
  await screen.findByText("Este thread está cerrado.");
  await user.click(screen.getByRole("button", { name: "Archivar" }));
  const archive = screen.getByRole("dialog", { name: "Archivar thread" });
  await user.click(within(archive).getByRole("button", { name: "Cancelar" }));
  expect(api.mock.calls.some(([url]) => url === "/threads/archivar")).toBe(
    false,
  );
  await user.click(screen.getByRole("button", { name: "Archivar" }));
  await user.click(
    within(screen.getByRole("dialog", { name: "Archivar thread" })).getByRole(
      "button",
      { name: "Archivar" },
    ),
  );
  expect(submitBody("/threads/archivar")).toEqual({ id: thread.id });
  await screen.findByText("Elige un thread o crea uno nuevo.");
});
