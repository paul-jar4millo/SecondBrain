// Server-Sent Events for threads. A stream replays the log after the
// client's position (Last-Event-ID or ?after=), sends the live state of
// items still in progress, then follows new events and deltas.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  formatSse,
  resumePosition,
  type StreamMessage,
  type ThreadEvent,
} from "../../../contracts/src/index.ts";
import type { Store } from "../store/event-log.ts";
import type { ThreadEngine } from "../engine/thread-engine.ts";

const HEARTBEAT_MS = 15_000;
const PAGE = 500;

function open(res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
}

function position(req: IncomingMessage, url: URL) {
  const header = req.headers["last-event-id"];
  return resumePosition(
    Array.isArray(header) ? header[0] : header,
    url.searchParams.get("after"),
  );
}

/** Keeps the connection open and cleans up when the client leaves. */
function follow(
  req: IncomingMessage,
  res: ServerResponse,
  cleanups: (() => void)[],
) {
  const heartbeat = setInterval(
    () => res.write(formatSse({ type: "heartbeat" })),
    HEARTBEAT_MS,
  );
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    for (const fn of cleanups.splice(0)) fn();
  };
  req.once("close", close);
  res.once("close", close);
}

export function streamThread(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  threadId: string,
  { store, engine }: { store: Store; engine: ThreadEngine },
): void {
  let sent = position(req, url);
  const last = store.lastSeq(threadId);
  open(res);
  if (sent > last) {
    res.end(
      formatSse({
        type: "snapshot-required",
        threadId,
        reason: "La posición pedida no existe en este thread.",
      } satisfies StreamMessage),
    );
    return;
  }
  // Subscribe first and buffer, so nothing appended during the replay is lost.
  let replaying = true;
  const buffered: ThreadEvent[] = [];
  const write = (event: ThreadEvent) => {
    if (event.seq <= sent) return;
    sent = event.seq;
    res.write(
      formatSse({ type: "event", event } satisfies StreamMessage, event.seq),
    );
  };
  const offEvents = store.subscribe((events) => {
    for (const event of events) {
      if (event.threadId !== threadId) continue;
      if (replaying) buffered.push(event);
      else write(event);
    }
  });
  const offDeltas = engine.subscribeDeltas((message) => {
    if (
      !replaying &&
      message.type === "item.delta" &&
      message.threadId === threadId
    )
      res.write(formatSse(message));
  });
  for (;;) {
    const page = store.readAfter(threadId, sent, PAGE);
    for (const event of page) write(event);
    if (page.length < PAGE) break;
  }
  for (const event of buffered.splice(0)) write(event);
  replaying = false;
  for (const item of engine.liveItems(threadId))
    res.write(
      formatSse({
        type: "item.snapshot",
        item,
        afterSeq: sent,
      } satisfies StreamMessage),
    );
  follow(req, res, [offEvents, offDeltas]);
}

export function streamGlobal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  { store }: { store: Store },
): void {
  let sent = position(req, url);
  open(res);
  if (sent > store.lastGlobalSeq()) {
    res.end(
      formatSse({
        type: "snapshot-required",
        reason: "La posición pedida no existe.",
      }),
    );
    return;
  }
  let replaying = true;
  const buffered: ThreadEvent[] = [];
  const write = (event: ThreadEvent) => {
    if (event.globalSeq <= sent) return;
    sent = event.globalSeq;
    res.write(formatSse({ type: "event", event }, event.globalSeq));
  };
  const off = store.subscribe((events) => {
    for (const event of events) {
      if (replaying) buffered.push(event);
      else write(event);
    }
  });
  for (;;) {
    const page = store.readGlobalAfter(sent, PAGE);
    for (const event of page) write(event);
    if (page.length < PAGE) break;
  }
  for (const event of buffered.splice(0)) write(event);
  replaying = false;
  follow(req, res, [off]);
}
