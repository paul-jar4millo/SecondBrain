import { mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
try {
  let text = "";
  // Decode incrementally so a character split between chunks stays whole.
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1000000) process.exit(0);
  }
  const e = JSON.parse(text);
  const native = e.session_id || e.conversationId;
  const session = process.env.SB_SESSION_ID;
  if (/^[a-f0-9-]{36}$/i.test(native) && /^[a-f0-9-]{36}$/i.test(session)) {
    const dir = path.join(process.env.HOME, "estado/lanzador/links");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, native + ".json");
    const tmp = file + "." + process.pid;
    await writeFile(
      tmp,
      JSON.stringify({
        id: session,
        native,
        cwd: e.cwd || e.workspacePaths?.[0],
        estado: process.argv[2] === "stop" ? "terminada" : "trabajando",
      }),
      { mode: 0o600 },
    );
    await rename(tmp, file);
  }
} catch {
  /* Observation must not interrupt the native agent. */
}
