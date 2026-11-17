// Synthetic provider protocol, desktop and touch phone. No models or personal vault.
import { chromium } from "playwright";
import { createApplication } from "../../service/index.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browserExecutable } from "./browser-executable.mjs";
import { emit, installFakeStream } from "./fake-stream.mjs";
import assert from "node:assert/strict";

const dir = await mkdtemp(path.join(tmpdir(), "sb-provider-ui-"));
await mkdir(path.join(dir, "00-Inbox"));
await writeFile(path.join(dir, "Home.md"), "# Synthetic test\n");
const app = await createApplication({
  vaultRoot: dir,
  dataDirectory: path.join(dir, ".data"),
  auth: false,
});
await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutable(),
});
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      ...(width < 700 ? { isMobile: true, hasTouch: true } : {}),
    });
    await installFakeStream(context);
    const starts = [],
      answers = [],
      terminal = [],
      errors = [];
    let session;
    await context.addInitScript(() =>
      localStorage.setItem("sb-room-tour-v1", "done"),
    );
    await context.route("**/api/v1/**", async (route) => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      const json = (value) =>
        route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (pathname === "/api/v1/items")
        return json([
          {
            id: "p1",
            kind: "project",
            title: "Proyecto sintético",
            status: "active",
            version: 1,
            createdAt: "2026-01-01",
            updatedAt: "2026-01-01",
          },
        ]);
      if (pathname === "/api/v1/agentes")
        return json({ agentes: [], conectado: true });
      if (pathname === "/api/v1/agentes/espacios")
        return json({ revision: 0, repositorios: [], vinculos: {} });
      if (pathname === "/api/v1/agentes/modelos-lanzador")
        return json({ claude: [{ id: "default", nombre: "Predeterminado" }] });
      if (pathname === "/api/v1/agentes/sesiones") {
        if (request.method() === "POST") {
          starts.push(request.postDataJSON());
          session = {
            id: "a1111111-1111-4111-8111-111111111111",
            motor: "claude",
            espacioId: "p1",
            structured: true,
            estado: "trabajando",
            encargo: starts[0].brief,
            conversacionId: "native-1",
          };
          return json(session);
        }
        return json(session ? [session] : []);
      }
      if (pathname === "/api/v1/agentes/conversacion/responder") {
        answers.push(request.postDataJSON());
        return json({ status: "delivered" });
      }
      if (pathname.includes("/terminal/")) {
        terminal.push(pathname);
        return json({});
      }
      if (pathname === "/api/v1/agentes/uso") return json({});
      return route.continue();
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/team?project=p1&agent=ambar&chat=new", {
      waitUntil: "networkidle",
    });
    await page
      .getByRole("textbox", { name: "Mensaje para Ámbar" })
      .fill("Investiga con fuentes verificadas");
    await page.getByRole("button", { name: "Abrir conversación" }).click();
    await page.waitForFunction(() =>
      window.__streams?.some((source) => !source.closed),
    );
    assert.equal(starts[0].structured, true);
    assert.equal(starts[0].harness, undefined);
    const snapshot = {
      seq: 1,
      status: "trabajando",
      items: [
        { id: "a1", tipo: "asistente", texto: "He comprobado las fuentes." },
      ],
      requests: [
        {
          id: "a2222222-2222-4222-8222-222222222222",
          kind: "question",
          title: "Modalidad",
          status: "pending",
          questions: [
            {
              id: "mode",
              question: "¿Qué modalidad?",
              options: [{ label: "Remoto" }, { label: "Híbrido" }],
            },
          ],
        },
      ],
    };
    await emit(page, "conversation", snapshot);
    await page.getByText("He comprobado las fuentes.").waitFor();
    // Finishing a provider turn must not remove a product question.
    await emit(page, "conversation", {
      ...snapshot,
      seq: 2,
      status: "terminada",
    });
    await page.getByRole("button", { name: "Remoto", exact: true }).click();
    await page.getByRole("button", { name: "Confirmar respuesta" }).click();
    await page.getByText(/Respuesta enviada/).waitFor();
    assert.equal(answers[0].answers.mode, "Remoto");
    assert.equal(terminal.length, 0);
    assert.equal(await page.getByRole("tab", { name: "Terminal" }).count(), 0);
    assert.deepEqual(errors, []);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForFunction(() =>
      window.__streams?.some((source) => !source.closed),
    );
    await emit(page, "conversation", {
      ...snapshot,
      seq: 3,
      requests: snapshot.requests.map((r) => ({ ...r, status: "answered" })),
    });
    await page.getByText(/Respuesta enviada/).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "Confirmar respuesta" }).count(),
      0,
    );
    console.log(
      `${width}: protocolo, preguntas persistentes, respuesta y recarga correctos`,
    );
    await context.close();
  }
} finally {
  await browser.close();
  await app.close();
  await rm(dir, { recursive: true, force: true });
}
