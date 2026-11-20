// Status line command of Ámbar and Lira: usage-line.mjs <motor> <archivo> <firma>.
// Runs on the CLI's own redraws, so it must never fail or block the terminal.
import { saveUsageLine } from "./usage.mjs";

const [engine, file, signature = ""] = process.argv.slice(2);
try {
  let text = "";
  for await (const part of process.stdin) text += part;
  await saveUsageLine(engine, JSON.parse(text), file);
} catch {
  /* Without readable data the previous numbers stay. */
}
process.stdout.write(signature);
