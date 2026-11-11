import "fake-indexeddb/auto";
import { expect, it, vi } from "vitest";
vi.stubGlobal("localStorage", { getItem: () => null });
vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { search: "" });
vi.stubGlobal("window", { addEventListener: () => {} });
vi.stubGlobal("document", { addEventListener: () => {} });
vi.stubGlobal("navigator", { onLine: true });
const { api } = await import("../src/core/store");

const respondWith = (response: () => Response) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string) =>
      path.endsWith("/auth/csrf")
        ? new Response(JSON.stringify({ token: "test" }))
        : response(),
    ),
  );
const upload = () => api("/files/raw", { method: "POST", body: "x" });

it("explica el 413 en HTML de un proxy", async () => {
  respondWith(
    () =>
      new Response("<html>413 Request Entity Too Large</html>", {
        status: 413,
      }),
  );
  await expect(upload()).rejects.toThrow("rechazó el envío por su tamaño");
});

it("conserva el mensaje del servicio cuando es él quien responde 413", async () => {
  respondWith(
    () =>
      new Response(JSON.stringify({ error: "El archivo supera 100 MB." }), {
        status: 413,
      }),
  );
  await expect(upload()).rejects.toThrow("El archivo supera 100 MB.");
});
