import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/core/store";
import {
  fileReference,
  filesMessage,
  UPLOAD_TIMEOUT_MS,
  uploadForAgents,
} from "../src/features/files/upload";

vi.mock("../src/core/store", () => ({
  api: vi.fn(async () => ({ id: "f1", name: "tarea.zip" })),
}));

afterEach(() => vi.restoreAllMocks());

it("el mensaje de adjuntos pide bajar los archivos a disco", () => {
  const message = filesMessage([
    fileReference({ id: "f1", name: "universidad.zip" }),
  ]);
  expect(message).toContain("files_download");
  expect(message).toContain("- universidad.zip (id: f1)");
});

it("una subida usa su propio tiempo de espera, no el de la API", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const file = new File(["x"], "Unidad 2.zip", {
    type: "application/x-zip-compressed",
  });
  await uploadForAgents(file);

  expect(timeout).toHaveBeenCalledWith(UPLOAD_TIMEOUT_MS);
  const [path, options] = vi.mocked(api).mock.calls[0];
  expect(path).toContain("name=Unidad+2.zip");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(options?.body).toBe(file);
});
