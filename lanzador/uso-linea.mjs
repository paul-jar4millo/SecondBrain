// Status line command of Ámbar and Lira: uso-linea.mjs <motor> <archivo> <firma>.
// Runs on the CLI's own redraws, so it must never fail or block the terminal.
import { guardarUsoLinea } from "./uso.mjs";

const [motor, archivo, firma = ""] = process.argv.slice(2);
try {
  let texto = "";
  for await (const parte of process.stdin) texto += parte;
  await guardarUsoLinea(motor, JSON.parse(texto), archivo);
} catch {
  /* Without readable data the previous numbers stay. */
}
process.stdout.write(firma);
