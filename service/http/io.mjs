// Request and response helpers shared by every API route. None of them
// hold state: they only read the request or write the response.
import { routePolicy } from "../routes.mjs";
import { Failure } from "../vault.mjs";
import { downloadHeaders } from "../shared-files.mjs";

/** @import { HttpRequest } from "../types.d.ts" */
/** @import { ServerResponse } from "node:http" */

/** @param {HttpRequest} request */
export async function body(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 12 * 1024 * 1024)
      throw new Failure("La petición supera 12 MB.", 413);
    chunks.push(chunk);
  }
  // Parse and schema validation fail differently: only the first is "invalid JSON".
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Failure("JSON inválido.");
  }
  const route = new URL(request.url ?? "/", "http://localhost").pathname.slice(
    "/api/v1".length,
  );
  const parsed = routePolicy(request.method, route)?.body.safeParse(value);
  if (!parsed?.success)
    throw new Failure(
      "Cuerpo de petición inválido" +
        (parsed?.error ? ": " + summarizeIssues(parsed.error.issues) : "."),
    );
  return parsed.data;
}
/** @param {unknown} relative */
export const validateNotePath = (relative) => {
  if (typeof relative !== "string" || !relative.endsWith(".md"))
    throw new Failure("Solo se admiten notas Markdown.");
};
/**
 * @param {ServerResponse} response
 * @param {number} status
 * @param {unknown} [value] Omitted for bodiless replies such as 204.
 */
export function send(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(value === undefined ? "" : JSON.stringify(value));
}

/** @param {HttpRequest} request */
export const agentHeaders = (request) => {
  const rawAgent =
    typeof request.headers["x-sb-agente"] === "string"
      ? request.headers["x-sb-agente"].trim()
      : "";
  const rawSession =
    typeof request.headers["x-sb-sesion"] === "string"
      ? request.headers["x-sb-sesion"].trim()
      : "";
  return {
    agentId: rawAgent || null,
    sessionUuid: /^[a-f0-9-]{36}$/i.test(rawSession) ? rawSession : null,
  };
};

/**
 * @param {ServerResponse} res
 * @param {Response} upstream
 * @param {{ fileName?: string, id?: string, version?: number, sha256?: string, authorId?: string, fileRef?: string }} [meta]
 */
export const relayArtifactDownload = async (res, upstream, meta = {}) => {
  const buf = Buffer.from(await upstream.arrayBuffer());
  const rawName = upstream.headers.get("x-artifact-filename");
  const fileName =
    meta.fileName || (rawName ? decodeURIComponent(rawName) : "artifact.bin");
  res.writeHead(200, {
    ...downloadHeaders({ name: fileName, size: buf.length }),
    "X-Artifact-Id": upstream.headers.get("x-artifact-id") || meta.id || "",
    "X-Artifact-Version":
      upstream.headers.get("x-artifact-version") ||
      (meta.version !== undefined ? String(meta.version) : ""),
    "X-Artifact-Sha256":
      upstream.headers.get("x-artifact-sha256") || meta.sha256 || "",
    "X-Artifact-Author":
      upstream.headers.get("x-artifact-author") || meta.authorId || "",
    "X-Artifact-FileRef":
      upstream.headers.get("x-artifact-fileref") ||
      (meta.fileRef ? encodeURIComponent(meta.fileRef) : ""),
  });
  res.end(buf);
};

/**
 * Field paths and zod messages only: never the submitted values.
 * @param {import("zod").z.ZodIssue[]} issues
 */
export function summarizeIssues(issues) {
  const shown = issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(raíz)"} (${i.message})`);
  return shown.join("; ") + (issues.length > 5 ? "; …" : ".");
}
