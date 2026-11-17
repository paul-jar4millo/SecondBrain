// Synthetic harness stream for the browser checks. Playwright cannot hold a
// real SSE response open and push to it, so the page gets an EventSource double
// for /agentes/terminal/stream; everything else keeps using the real one.

/** Call before the page loads: `await installFakeStream(context)`. */
export async function installFakeStream(context) {
  await context.addInitScript(() => {
    const Real = window.EventSource;
    window.__streams = [];
    window.EventSource = class {
      constructor(url) {
        if (
          !String(url).includes("/agentes/terminal/stream") &&
          !String(url).includes("/agentes/conversacion/stream")
        )
          return new Real(url);
        this.url = String(url);
        this.closed = false;
        this.onerror = null;
        this.handlers = {};
        window.__streams.push(this);
      }
      addEventListener(name, fn) {
        (this.handlers[name] ??= []).push(fn);
      }
      close() {
        this.closed = true;
      }
    };
    // Delivers an event to every open stream, as the service would.
    window.__emit = (name, data) => {
      for (const stream of window.__streams)
        if (!stream.closed)
          for (const fn of stream.handlers[name] ?? [])
            fn({ data: JSON.stringify(data) });
    };
  });
}

export const openStreams = (page) =>
  page.evaluate(() => window.__streams.filter((s) => !s.closed).length);

export const emit = (page, name, data) =>
  page.evaluate(([n, d]) => window.__emit(n, d), [name, data]);

/** Waits for the page to open its stream, then plays a first state into it. */
export async function connectStream(page, { snapshot, items = [], estado }) {
  await page.waitForFunction(() => window.__streams?.some((s) => !s.closed));
  await emit(page, "snapshot", { activa: true, generacion: "g", ...snapshot });
  await emit(page, "items", { reemplazar: true, items });
  if (estado)
    await emit(page, "estado", { activa: true, ultimaAccion: null, ...estado });
}
