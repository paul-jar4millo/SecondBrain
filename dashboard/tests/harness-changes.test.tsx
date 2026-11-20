// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { HarnessChanges } from "../src/features/team/HarnessChanges";
import {
  diffQuery,
  lineKind,
  splitPatch,
  turnsOf,
  type Capabilities,
  type Checkpoint,
} from "../src/features/team/harness-changes";
import {
  isTransient,
  sendWithRetry,
} from "../src/features/team/approval-receipts";

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/features/team/team-store", () => ({ teamApi: fixture.api }));
afterEach(() => {
  cleanup();
  fixture.api.mockReset();
});

const ID = "a1111111-1111-4111-8111-111111111111";
const caps: Capabilities = {
  esRepo: true,
  tieneRemoto: true,
  remotoGithub: true,
  continuar: true,
  interrumpir: true,
  revertirArchivos: true,
  revertirConversacion: false,
  crearPr: true,
  redactarPr: true,
  herramientasEstructuradas: true,
  reportaUso: true,
  reportaContexto: true,
  remoteControl: true,
};
const checkpoints: Checkpoint[] = [
  { n: 1, ts: "2026-01-02T10:00:00Z", mensaje: "primer turno" },
  { n: 2, ts: "2026-01-02T10:05:00Z", mensaje: "segundo turno" },
];
const PATCH = [
  "diff --git a/a.txt b/a.txt",
  "index 1..2 100644",
  "--- a/a.txt",
  "+++ b/a.txt",
  "@@ -1 +1,2 @@",
  " uno",
  "+dos",
  "diff --git a/b.txt b/b.txt",
  "deleted file mode 100644",
  "--- a/b.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-viejo",
  "",
].join("\n");
const DIFF = {
  archivos: [
    {
      ruta: "a.txt",
      estado: "M",
      añadidas: 1,
      eliminadas: 0,
      binario: false,
    },
    {
      ruta: "b.txt",
      estado: "D",
      añadidas: 0,
      eliminadas: 1,
      binario: false,
    },
  ],
  parche: PATCH,
  recortado: false,
};

it("agrupa el parche por archivo, clasifica las líneas y arma los turnos", () => {
  const files = splitPatch(PATCH);
  expect(files.map((f) => f.ruta)).toEqual(["a.txt", "b.txt"]);
  expect(files[1].lines.at(-1)).toBe("-viejo");
  expect(
    ["@@ -1 +1 @@", "+x", "-y", " z", "--- a/x", "diff --git a/x b/x"].map(
      lineKind,
    ),
  ).toEqual(["hunk", "add", "del", "ctx", "meta", "meta"]);
  const turns = turnsOf([
    ...checkpoints,
    { n: 3, ts: "x", mensaje: "seguridad", tipo: "reversion", de: 1 },
  ]);
  expect(turns.map((t) => [t.n, t.hasta])).toEqual([
    [1, 2],
    [2, 3],
  ]);
  expect(diffQuery(ID, turns[0])).toBe(
    `/agentes/sesiones/diff?id=${ID}&desde=1&hasta=2`,
  );
  expect(diffQuery(ID)).toBe(`/agentes/sesiones/diff?id=${ID}`);
});

it("muestra archivos con sus cifras, pliega el parche y cambia de rango por turno", async () => {
  fixture.api.mockResolvedValue(DIFF);
  const user = userEvent.setup();
  render(
    <HarnessChanges
      id={ID}
      agentName="Ámbar"
      checkpoints={checkpoints}
      capacidades={caps}
      working={false}
      visible
    />,
  );
  expect(await screen.findByText("a.txt")).toBeTruthy();
  expect(screen.getByText("2 archivos", { exact: false })).toBeTruthy();
  expect(fixture.api).toHaveBeenCalledWith(`/agentes/sesiones/diff?id=${ID}`);
  // The patch lives inside a collapsed <details>, colored per line kind.
  const added = screen.getByText("+dos");
  expect(added.className).toContain("patch-add");
  expect(added.closest("details")?.open).toBe(false);
  await user.selectOptions(screen.getByRole("combobox"), "2");
  await waitFor(() =>
    expect(fixture.api).toHaveBeenLastCalledWith(
      `/agentes/sesiones/diff?id=${ID}&desde=2&hasta=actual`,
    ),
  );
});

it("revertir pide confirmación en dos pasos y luego ofrece deshacer", async () => {
  fixture.api.mockResolvedValue(DIFF);
  const user = userEvent.setup();
  const { rerender } = render(
    <HarnessChanges
      id={ID}
      agentName="Ámbar"
      checkpoints={checkpoints}
      capacidades={caps}
      working={false}
      visible
    />,
  );
  await user.selectOptions(await screen.findByRole("combobox"), "2");
  await user.click(
    await screen.findByRole("button", {
      name: "Revertir a antes de este turno",
    }),
  );
  expect(fixture.api).not.toHaveBeenCalledWith(
    "/agentes/sesiones/revertir",
    expect.anything(),
  );
  await user.click(screen.getByRole("button", { name: "Confirmar: revertir" }));
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith("/agentes/sesiones/revertir", {
      id: ID,
      n: 2,
    }),
  );
  expect(await screen.findByText(/no se revierte/)).toBeTruthy();
  // The launcher added the safety checkpoint: now the revert can be undone.
  const withSafety: Checkpoint[] = [
    ...checkpoints,
    {
      n: 3,
      ts: "2026-01-02T10:09:00Z",
      mensaje: "x",
      tipo: "reversion",
      de: 2,
    },
  ];
  rerender(
    <HarnessChanges
      id={ID}
      agentName="Ámbar"
      checkpoints={withSafety}
      capacidades={caps}
      working={false}
      visible
    />,
  );
  await user.click(
    await screen.findByRole("button", { name: "Deshacer reversión" }),
  );
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith("/agentes/sesiones/revertir", {
      id: ID,
      n: 3,
    }),
  );
});

it("deshabilita con una explicación lo que el motor o la carpeta no permiten", async () => {
  fixture.api.mockResolvedValue(DIFF);
  const { rerender } = render(
    <HarnessChanges
      id={ID}
      agentName="Menta"
      checkpoints={checkpoints}
      capacidades={{ ...caps, revertirArchivos: false, crearPr: false }}
      working={false}
      visible
    />,
  );
  const revert = await screen.findByRole("button", {
    name: "Revertir a antes de la sesión",
  });
  expect((revert as HTMLButtonElement).disabled).toBe(true);
  expect(revert.title).toMatch(/repositorio git/);
  const pr = screen.getByRole("button", { name: "Crear PR" });
  expect((pr as HTMLButtonElement).disabled).toBe(true);
  expect(pr.title).toMatch(/GitHub/);
  rerender(
    <HarnessChanges
      id={ID}
      agentName="Menta"
      checkpoints={checkpoints}
      capacidades={caps}
      working
      visible
    />,
  );
  expect(
    (
      screen.getByRole("button", {
        name: "Revertir a antes de la sesión",
      }) as HTMLButtonElement
    ).title,
  ).toMatch(/Detén el turno/);
});

it("el PR parte de la propuesta, solo redacta con el agente al pulsar y conserva la propuesta si falla", async () => {
  fixture.api.mockImplementation(async (path: string) => {
    if (path.startsWith("/agentes/sesiones/diff")) return DIFF;
    if (path.startsWith("/agentes/sesiones/pr/propuesta"))
      return { titulo: "fix: corrige el login", descripcion: "## Resumen\nok" };
    if (path === "/agentes/sesiones/pr/redactar")
      throw new Error("El agente no pudo redactar el PR.");
    if (path === "/agentes/sesiones/pr")
      return {
        rama: "sb/x",
        commit: "abc",
        url: "https://github.com/o/r/pull/9",
      };
    return {};
  });
  const user = userEvent.setup();
  render(
    <HarnessChanges
      id={ID}
      agentName="Ámbar"
      checkpoints={checkpoints}
      capacidades={caps}
      working={false}
      visible
    />,
  );
  await user.click(await screen.findByRole("button", { name: "Crear PR" }));
  const title = (await screen.findByLabelText(
    "Título (Conventional Commits)",
  )) as HTMLInputElement;
  await waitFor(() => expect(title.value).toBe("fix: corrige el login"));
  // Nothing is drafted by a model until the user asks.
  expect(fixture.api).not.toHaveBeenCalledWith(
    "/agentes/sesiones/pr/redactar",
    expect.anything(),
    expect.anything(),
  );
  await user.click(screen.getByRole("button", { name: "Redactar con Ámbar" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(title.value).toBe("fix: corrige el login");
  await user.clear(title);
  const dialog = screen.getByRole("dialog");
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Crear PR",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  await user.type(title, "feat: nuevo");
  await user.click(screen.getByLabelText("Borrador"));
  await user.click(within(dialog).getByRole("button", { name: "Crear PR" }));
  await waitFor(() =>
    expect(fixture.api).toHaveBeenCalledWith(
      "/agentes/sesiones/pr",
      {
        id: ID,
        titulo: "feat: nuevo",
        descripcion: "## Resumen\nok",
        borrador: true,
      },
      expect.any(Number),
    ),
  );
  expect(
    (
      await screen.findByRole("link", { name: "Abrir el PR en GitHub" })
    ).getAttribute("href"),
  ).toBe("https://github.com/o/r/pull/9");
});

it("reintenta con el mismo requestId ante fallos de red y no ante errores del servidor", async () => {
  const ids: string[] = [];
  const red = Object.assign(new Error("red"), {});
  const send = vi
    .fn()
    .mockImplementationOnce(async (id: string) => {
      ids.push(id);
      throw red;
    })
    .mockImplementationOnce(async (id: string) => {
      ids.push(id);
      throw red;
    })
    .mockImplementationOnce(async (id: string) => {
      ids.push(id);
      return { ok: true };
    });
  const wait = vi.fn(async () => {});
  expect(await sendWithRetry(send, { wait })).toEqual({ ok: true });
  expect(new Set(ids).size).toBe(1);
  expect(wait).toHaveBeenCalledTimes(2);

  const siempre = vi.fn(async () => {
    throw red;
  });
  await expect(sendWithRetry(siempre, { wait })).rejects.toBe(red);
  expect(siempre).toHaveBeenCalledTimes(4); // first try + 3 retries

  const conflict = vi.fn(async () => {
    throw Object.assign(new Error("ya resuelta"), { status: 409 });
  });
  await expect(sendWithRetry(conflict, { wait })).rejects.toThrow(
    "ya resuelta",
  );
  expect(conflict).toHaveBeenCalledTimes(1);
  expect(isTransient({ status: 503 })).toBe(true);
  expect(isTransient({ status: 400 })).toBe(false);
});
