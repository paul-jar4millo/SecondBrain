import { createHash } from "node:crypto";

export const sha = (texto) =>
  createHash("sha256").update(texto, "utf8").digest("hex");

/** Synthetic manifest with the same shape the service freezes at start. */
export function manifiesto(team) {
  const base = {
    manifestVersion: 1,
    workOrderId: "00000000-0000-4000-8000-000000000001",
    teamRevision: 1,
    coordinatorId: team.find((c) => c.coordinator)?.id ?? null,
    team: team.map((c) => ({ assigned: true, ...c })),
  };
  return { ...base, sha256: sha(JSON.stringify(base)) };
}
