import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { newItem, type Item } from "../core/model";
const safe = (s: string) =>
  s.replace(/[^\p{L}\p{N} _-]/gu, "").slice(0, 100) || "Nota";
function download(data: Uint8Array, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([data.slice().buffer], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
export function noteMarkdown(n: Item): string {
  if (/^---\r?\n[\s\S]*?\r?\n---/.test(n.body || "")) return n.body!;
  return `---\ntitle: ${JSON.stringify(n.title)}\nid: ${n.id}\narea: ${JSON.stringify(n.area || "")}\nverified: ${n.verifiedAt || ""}\nexpires: ${n.expiresAt || ""}\n---\n\n${n.body || ""}`;
}
export function exportAll(items: Item[]) {
  const files: Record<string, Uint8Array> = {
    "second-brain.json": strToU8(
      JSON.stringify(
        {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          items: items.filter((i) => i.kind !== "notification"),
        },
        null,
        2,
      ),
    ),
  };
  for (const n of items.filter((x) => x.kind === "note" && !x.deleted))
    files[`notas/${safe(n.title)}-${n.id.slice(0, 8)}.md`] = strToU8(
      noteMarkdown(n),
    );
  const rows = [
    ["fecha", "concepto", "tipo", "importe_mxn", "categoria", "cuenta"],
    ...items
      .filter((x) => x.kind === "transaction" && !x.deleted)
      .map((t) => [
        t.date || "",
        t.title,
        t.transactionType || "",
        ((t.amountMinor || 0) / 100).toFixed(2),
        t.category || "",
        items.find((x) => x.id === t.accountId)?.title || "",
      ]),
  ];
  files["finanzas.csv"] = strToU8(
    "\uFEFF" +
      rows
        .map((r) =>
          r
            .map(
              (v) =>
                '"' +
                (/^[=+\-@\t\r]/.test(v) ? "'" : "") +
                v.replaceAll('"', '""') +
                '"',
            )
            .join(","),
        )
        .join("\r\n"),
  );
  files["agenda.ics"] = strToU8(exportICS(items));
  download(
    zipSync(files),
    "second-brain-" + new Date().toISOString().slice(0, 10) + ".zip",
    "application/zip",
  );
}
const esc = (s: string) =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
export function exportICS(items: Item[]) {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Second Brain//ES",
    "CALSCALE:GREGORIAN",
    ...items
      .filter((x) => x.kind === "event" && !x.deleted)
      .flatMap((e) => {
        const d = (e.date || "").replaceAll("-", "");
        const end = (e.endDate || e.date || "").replaceAll("-", "");
        return [
          "BEGIN:VEVENT",
          `UID:${e.id}@secondbrain.local`,
          `DTSTAMP:${stamp}`,
          e.time
            ? `DTSTART;TZID=${e.timezone || "America/Mexico_City"}:${d}T${e.time.replace(":", "")}00`
            : `DTSTART;VALUE=DATE:${d}`,
          e.time
            ? `DTEND;TZID=${e.timezone || "America/Mexico_City"}:${end}T${(e.endTime || e.time).replace(":", "")}00`
            : `DTEND;VALUE=DATE:${end}`,
          `SUMMARY:${esc(e.title)}`,
          `DESCRIPTION:${esc(e.body || "")}`,
          "END:VEVENT",
        ];
      }),
    "END:VCALENDAR",
  ].join("\r\n");
}
export function downloadICS(items: Item[]) {
  download(strToU8(exportICS(items)), "agenda.ics", "text/calendar");
}
export async function previewImport(file: File): Promise<Item[]> {
  if (file.size > 10 * 1024 * 1024)
    throw new Error("El límite es 10 MB por archivo.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (file.name.endsWith(".zip")) {
    const files = unzipSync(bytes, {
      filter: (f) =>
        f.originalSize < 2 * 1024 * 1024 && !/(^|\/)\.|\.\.|\\/.test(f.name),
    });
    let size = 0;
    for (const data of Object.values(files)) {
      size += data.length;
      if (size > 30 * 1024 * 1024)
        throw new Error("El ZIP descomprimido supera 30 MB.");
    }
    if (files["second-brain.json"])
      return parseJSON(strFromU8(files["second-brain.json"]));
    const out = [];
    for (const [path, data] of Object.entries(files)) {
      if (path.endsWith(".md"))
        out.push(await markdownItem(path, strFromU8(data)));
    }
    return out;
  }
  const text = strFromU8(bytes);
  if (file.name.endsWith(".json")) return parseJSON(text);
  if (file.name.endsWith(".md")) return [await markdownItem(file.name, text)];
  if (file.name.endsWith(".ics")) return importICS(text);
  throw new Error(
    "Selecciona un ZIP del vault, export JSON, nota Markdown o calendario ICS.",
  );
}
function parseJSON(text: string): Item[] {
  const data = JSON.parse(text);
  if (data.schemaVersion !== 1 || !Array.isArray(data.items))
    throw new Error("El archivo no es una exportación compatible.");
  if (data.items.length > 20000)
    throw new Error("La exportación supera 20,000 elementos.");
  const kinds = [
    "task",
    "note",
    "project",
    "inbox",
    "event",
    "account",
    "transaction",
    "obligation",
    "review",
    "notification",
    "statement",
  ];
  for (const item of data.items) {
    if (
      !kinds.includes(item.kind) ||
      !item.id ||
      typeof item.title !== "string" ||
      (typeof item.version !== "number" && typeof item.version !== "string")
    )
      throw new Error("La exportación contiene elementos inválidos.");
  }
  return data.items;
}
async function markdownItem(path: string, text: string): Promise<Item> {
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", strToU8(path))),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const field = (name: string) =>
    fm?.[1]
      .match(new RegExp("^" + name + ":\\s*(.+)$", "m"))?.[1]
      .replace(/^['"]|['"]$/g, "")
      .trim();
  return newItem("note", {
    id:
      hash.slice(0, 8) +
      "-" +
      hash.slice(8, 12) +
      "-4" +
      hash.slice(13, 16) +
      "-a" +
      hash.slice(17, 20) +
      "-" +
      hash.slice(20, 32),
    title: field("title") || path.split("/").pop()!.replace(/\.md$/, ""),
    body: text,
    source: path,
    sourceHash: hash,
    verifiedAt: field("verified"),
    expiresAt: field("expires"),
  });
}
function importICS(text: string): Item[] {
  if (text.includes("RRULE:") || text.includes("RECURRENCE-ID:"))
    throw new Error(
      "Este calendario contiene recurrencias. Exporta eventos individuales: todavía no importamos series ICS.",
    );
  const out: Item[] = [];
  for (const block of text
    .replace(/\r?\n[ \t]/g, "")
    .split("BEGIN:VEVENT")
    .slice(1)) {
    const get = (name: string) =>
      block
        .match(new RegExp("^" + name + "(?:;[^:]*)?:(.*)$", "m"))?.[1]
        .trim();
    const start = get("DTSTART");
    if (!start) continue;
    const end = get("DTEND") || start;
    const date = (v: string) =>
      v.slice(0, 4) + "-" + v.slice(4, 6) + "-" + v.slice(6, 8);
    const time = (v: string) =>
      v.includes("T") ? v.slice(9, 11) + ":" + v.slice(11, 13) : undefined;
    const externalId = get("UID");
    if (!externalId)
      throw new Error("Cada evento ICS debe tener UID para evitar duplicados.");
    out.push(
      newItem("event", {
        title: (get("SUMMARY") || "Evento")
          .replaceAll("\\n", "\n")
          .replace(/\\([,;\\])/g, "$1"),
        date: date(start),
        endDate: date(end),
        time: time(start),
        endTime: time(end),
        timezone: start.endsWith("Z")
          ? "UTC"
          : block.match(/DTSTART;TZID=([^:]+):/)?.[1] || "America/Mexico_City",
        externalId,
        ...(/^[0-9a-f-]{36}@secondbrain.local$/.test(externalId)
          ? { id: externalId.split("@")[0] }
          : {}),
        body: get("DESCRIPTION"),
      }),
    );
  }
  if (!out.length) throw new Error("No se encontraron eventos compatibles.");
  return out;
}

export async function exportVault() {
  const response = await fetch("/api/v1/export");
  if (!response.ok)
    throw new Error(
      "No se pudo exportar el vault. Necesitas conexión al servidor.",
    );
  download(
    new Uint8Array(await response.arrayBuffer()),
    "second-brain-vault.zip",
    "application/zip",
  );
}
