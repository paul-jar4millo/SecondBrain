import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/**
 * @param {{ tool_name?: unknown, toolName?: unknown, tool?: { name?: unknown } }} entry
 * @param {unknown} id
 */
export function eventHook(entry, id) {
  const herramienta = entry?.tool_name || entry?.toolName || entry?.tool?.name;
  if (
    typeof id !== "string" ||
    !id ||
    typeof herramienta !== "string" ||
    !herramienta.trim()
  )
    return null;
  return { id: id.slice(0, 100), herramienta: herramienta.slice(0, 100) };
}

export async function main(entry = process.stdin) {
  try {
    let text = "";
    // Decode incrementally so a character split between chunks stays whole.
    entry.setEncoding("utf8");
    for await (const part of entry) {
      text += part;
      if (Buffer.byteLength(text) > 64000) return;
    }
    const event = eventHook(JSON.parse(text), process.env.SB_SESSION_ID);
    if (!event || !process.env.SB_HOOK_TOKEN_FILE) return;
    const token = (
      await readFile(process.env.SB_HOOK_TOKEN_FILE, "utf8")
    ).trim();
    const port = Number(process.env.SB_LANZADOR_PORT || 8092);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    await fetch(`http://127.0.0.1:${port}/eventos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* Hooks must never block the harness when the observer is unavailable. */
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
