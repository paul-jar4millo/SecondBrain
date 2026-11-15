// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { montarPanel } from "../src/features/mundo/panel.js";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  document.body.replaceChildren();
});

async function openSyntheticVideo() {
  history.replaceState({}, "", "/projects/mundo-hipotetico?view=videos");
  document.body.innerHTML = `<div id="nav"></div><a id="settings-link"></a>
    <div id="breadcrumb"></div><input id="search"><button id="refresh"></button>
    <button id="new-video"></button><span id="search-icon"></span>
    <main id="main"></main><div id="sync-label"></div>
    <dialog id="dialog"><div id="dialog-body"></div></dialog><div id="toast"></div>`;
  const dialog = document.querySelector("dialog")!;
  dialog.showModal = () => dialog.setAttribute("open", "");
  dialog.close = () => dialog.removeAttribute("open");
  const confirm = vi.fn(async () => false);
  const stage = '<img src="x" onerror="alert(1)">';
  dispose = montarPanel(document.body, {
    confirm,
    api: async () => ({
      scannedAt: "2026-11-09T12:00:00Z",
      updated: "2026-11-09",
      stages: [stage],
      state: { tasks: [] },
      videos: [
        {
          id: "synthetic",
          title: "Video sintético",
          status: "En producción",
          date: "2026-11-09",
          checks: [false],
          files: [],
          scenes: [],
        },
      ],
    }),
  });
  await vi.waitFor(() =>
    expect(document.querySelector('[data-action="video"]')).not.toBeNull(),
  );
  (
    document.querySelector('[data-action="video"]') as HTMLButtonElement
  ).click();
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  return { dialog, stage, confirm };
}

it("muestra los nombres de etapas como texto sin crear elementos HTML", async () => {
  const { dialog, stage } = await openSyntheticVideo();
  expect(dialog.querySelector(".checklist")?.textContent).toContain(stage);
  expect(dialog.querySelector(".checklist img")).toBeNull();
});

it("Escape conserva un formulario sucio y el cierre espera la decisión del diálogo React", async () => {
  const { dialog, confirm } = await openSyntheticVideo();
  dialog
    .querySelector("#dialog-body")!
    .insertAdjacentHTML("beforeend", '<form data-dirty="true"></form>');
  const cancelled = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancelled);
  expect(cancelled.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
  expect(dialog.open).toBe(true);
  confirm.mockResolvedValueOnce(true);
  (dialog.querySelector('[data-action="close"]') as HTMLButtonElement).click();
  await vi.waitFor(() => expect(dialog.open).toBe(false));
});
