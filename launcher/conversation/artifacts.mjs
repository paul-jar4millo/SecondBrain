import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LauncherError } from "../errors.mjs";
import { sha256Hex } from "../lib/hash.mjs";
import { validId } from "./persistence.mjs";

/** @import {ConversationArtifact, ConversationArtifactInput, ConversationSession, ConversationState} from "../provider-conversation-types.mjs" */
/** @import {ConversationPersistence} from "./persistence.mjs" */

/**
 * @param {string} directory
 * @param {string} sessionId
 * @param {string} artifactId
 */
const blobPath = (directory, sessionId, artifactId) =>
  path.join(directory, "_blobs", sessionId, `${artifactId}.bin`);

/**
 * Validates an artifact published by an agent and stores its bytes, when it
 * has any, as an immutable blob. Returns what the state entry needs.
 * @param {string} directory
 * @param {string} sessionId
 * @param {ConversationArtifactInput} input
 */
export async function storeArtifactBlob(directory, sessionId, input) {
  const fileRef = String(input.fileRef || "").replace(/\\/g, "/");
  if (!fileRef || fileRef.includes("..") || path.isAbsolute(fileRef)) {
    throw new Error("El artefacto requiere ruta relativa válida (fileRef).");
  }
  const id = input.id || randomUUID();
  if (!validId(id)) {
    throw new Error("Identificador de artefacto inválido.");
  }
  const buf = Buffer.isBuffer(input.contentBuffer)
    ? input.contentBuffer
    : input.content !== undefined
      ? Buffer.from(String(input.content), "utf8")
      : null;
  let sha256 = String(input.sha256 || "");
  if (buf !== null) {
    const computed = sha256Hex(buf);
    if (sha256 && sha256 !== computed) {
      throw new Error("SHA-256 del artefacto no coincide con sus bytes.");
    }
    sha256 = computed;
    const blobDir = path.join(directory, "_blobs", sessionId);
    await mkdir(blobDir, { recursive: true, mode: 0o700 });
    const tmpBlob = path.join(
      blobDir,
      `${id}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tmpBlob, buf, { mode: 0o600 });
    await rename(tmpBlob, blobPath(directory, sessionId, id));
  }
  return { id, fileRef, buf, sha256 };
}

/**
 * The state entry for a stored artifact. Versions count per file reference.
 * @param {ConversationState} state
 * @param {ConversationSession} session
 * @param {ConversationArtifactInput} input
 * @param {Awaited<ReturnType<typeof storeArtifactBlob>>} stored
 * @returns {ConversationArtifact}
 */
export function artifactEntry(
  state,
  session,
  input,
  { id, fileRef, buf, sha256 },
) {
  const existingMax = state.artifacts
    .filter((a) => a.fileRef === fileRef)
    .reduce((max, a) => Math.max(max, a.version || 0), 0);
  return {
    id,
    artifactId: id,
    workOrderId: session.workOrderId ?? null,
    sessionId: session.id,
    authorId: session.memberId || session.motor,
    fileRef,
    fileName: input.fileName || path.basename(fileRef),
    sha256,
    hash: sha256,
    bytesLength: buf !== null ? buf.length : (input.byteLength ?? 0),
    mimeType: input.mimeType || "application/octet-stream",
    version: input.version ?? existingMax + 1,
    evidenceRefs: Array.isArray(input.evidenceRefs)
      ? input.evidenceRefs.map(String)
      : [],
    summary: String(input.summary || ""),
    comment: String(input.comment || input.summary || ""),
    immutable: buf !== null,
    verification: "pendiente",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Reads an artifact's bytes and checks them against the recorded hash.
 * @param {ConversationPersistence} persistence
 * @param {string} sessionId
 * @param {string} artifactId
 */
export async function readArtifact(persistence, sessionId, artifactId) {
  if (!validId(sessionId) || !validId(artifactId)) {
    throw new LauncherError("Identificador de artefacto inválido.", 400);
  }
  const store = await persistence.settled(sessionId);
  const entry = store.state.artifacts.find((a) => a.id === artifactId);
  if (!entry) {
    throw new LauncherError("Artefacto no encontrado.", 404);
  }
  let buffer;
  try {
    buffer = await readFile(
      blobPath(persistence.directory, sessionId, artifactId),
    );
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new LauncherError(
        "Los bytes inmutables de esta versión no están disponibles.",
        404,
      );
    }
    throw err;
  }
  const actualHash = sha256Hex(buffer);
  if (entry.sha256 && actualHash !== entry.sha256) {
    throw new LauncherError("Verificación SHA-256 del artefacto fallida.", 500);
  }
  return { artifact: structuredClone(entry), buffer };
}
