import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { createHash } from "node:crypto";
const compress = promisify(gzip);
/**
 * @param {import("./types.d.ts").HttpRequest} request
 * @param {import("node:http").ServerResponse} response
 * @param {{ kind: string, body?: string }[]} items
 */
export async function sendItems(request, response, items) {
  const text = JSON.stringify(
    items.map((item) => {
      if (item.kind !== "note") return item;
      const { body, ...summary } = item;
      return summary;
    }),
  );
  const etag = '"' + createHash("sha256").update(text).digest("hex") + '"';
  response.setHeader("ETag", etag);
  response.setHeader("Vary", "Accept-Encoding");
  if (
    String(request.headers["if-none-match"] || "")
      .split(",")
      .some((value) => value.trim().replace(/^W\//, "") === etag)
  ) {
    response.writeHead(304);
    response.end();
    return;
  }
  const useGzip = String(request.headers["accept-encoding"] || "")
    .split(",")
    .some((value) => {
      const [encoding, quality] = value.trim().split(";");
      return (
        encoding === "gzip" &&
        (!quality || Number(quality.trim().replace(/^q=/, "")) > 0)
      );
    });
  const data = useGzip ? await compress(text) : Buffer.from(text);
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    ...(useGzip ? { "Content-Encoding": "gzip" } : {}),
  });
  response.end(data);
}
