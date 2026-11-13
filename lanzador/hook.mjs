// @ts-check
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function eventoHook(entrada, id) {
  const herramienta =
    entrada?.tool_name || entrada?.toolName || entrada?.tool?.name;
  if (
    typeof id !== "string" ||
    !id ||
    typeof herramienta !== "string" ||
    !herramienta.trim()
  )
    return null;
  return { id: id.slice(0, 100), herramienta: herramienta.slice(0, 100) };
}

export async function main(entrada = process.stdin) {
  try {
    let texto = "";
    // Decode incrementally so a character split between chunks stays whole.
    entrada.setEncoding("utf8");
    for await (const parte of entrada) {
      texto += parte;
      if (Buffer.byteLength(texto) > 64000) return;
    }
    const evento = eventoHook(JSON.parse(texto), process.env.SB_SESSION_ID);
    if (!evento || !process.env.SB_HOOK_TOKEN_FILE) return;
    const token = (
      await readFile(process.env.SB_HOOK_TOKEN_FILE, "utf8")
    ).trim();
    const puerto = Number(process.env.SB_LANZADOR_PORT || 8092);
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) return;
    await fetch(`http://127.0.0.1:${puerto}/eventos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(evento),
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    /* Hooks must never block the harness when the observer is unavailable. */
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
