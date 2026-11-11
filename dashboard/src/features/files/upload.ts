import { api } from "../../core/store";

export const MAX_UPLOAD = 100 * 1024 * 1024;
// Matches the service's request timeout: 100 MB at about 57 KB/s.
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;

export interface UploadedFile {
  id: string;
  name: string;
}

/** Leaves a file in the Maletín, where the agents can read it. */
export async function uploadForAgents(
  file: File,
  note = "",
): Promise<UploadedFile> {
  if (file.size > MAX_UPLOAD) throw new Error(`«${file.name}» supera 100 MB.`);
  const query = new URLSearchParams({ area: "para-agentes", name: file.name });
  if (note) query.set("note", note);
  return api<UploadedFile>(`/files/raw?${query}`, {
    method: "POST",
    body: file,
    // The default API timeout would abort large files on a slow uplink.
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    headers: { "Content-Type": file.type || "application/octet-stream" },
  });
}

/** How a message names a Maletín file so the agent can fetch it. */
export const fileReference = (file: UploadedFile) =>
  `- ${file.name} (id: ${file.id})`;

/** Names the files and how to fetch them, so their bytes stay out of the context. */
export const filesMessage = (references: string[]) =>
  [
    "Archivos en el Maletín (bájalos a disco con `files_download`; no los leas con `files_get`):",
    ...references,
  ].join("\n");
