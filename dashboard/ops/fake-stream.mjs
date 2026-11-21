// EventSource double for the thread feed and individual thread streams.
export async function installFakeStream(context) {
  await context.addInitScript(() => {
    const RealEventSource = window.EventSource;
    window.__threadStreams = [];
    window.EventSource = class {
      constructor(url, options) {
        this.url = String(url);
        const path = new URL(this.url, location.origin).pathname;
        if (!["/api/v1/threads/feed", "/api/v1/threads/stream"].includes(path))
          return new RealEventSource(url, options);
        this.closed = false;
        window.__threadStreams.push(this);
        setTimeout(() => {
          if (!this.closed) this.onopen?.(new Event("open"));
        }, 0);
      }

      close() {
        this.closed = true;
      }
    };
  });
}

export const streamUrl = (page, path) =>
  page.evaluate(
    (match) =>
      window.__threadStreams.find(
        (stream) =>
          !stream.closed &&
          new URL(stream.url, location.origin).pathname.endsWith(match),
      )?.url,
    path,
  );

export const emit = (page, path, ...messages) =>
  page.evaluate(
    ([match, frames]) => {
      for (const stream of window.__threadStreams) {
        if (
          stream.closed ||
          !new URL(stream.url, location.origin).pathname.endsWith(match)
        )
          continue;
        for (const frame of frames)
          stream.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(frame) }),
          );
      }
    },
    [path, messages],
  );
