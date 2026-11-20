import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  crearUso,
  contextoLinea,
  guardarUsoLinea,
  leerUsoCodex,
  leerUsoLinea,
  lineaUso,
  ultimoUsoCodex,
  vigente,
} from "../usage.mjs";
import { ventanasAgy, ventanasClaude } from "../engines.mjs";
import { prepararAgy, prepararClaude } from "../claude-config.mjs";

const evento = (primary, secondary, extra = {}) =>
  JSON.stringify({
    timestamp: "2026-11-09T03:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: {
        limit_id: "codex",
        primary,
        secondary,
        plan_type: "plus",
        ...extra,
      },
    },
  });
const cinco = {
  used_percent: 48,
  window_minutes: 300,
  resets_at: 1794191214,
};
const semana = {
  used_percent: 51,
  window_minutes: 10080,
  resets_at: 1794717096,
};

test("toma el último límite de la cuenta e ignora líneas rotas y otros límites", () => {
  const texto = [
    '{"cortada":',
    evento({ ...cinco, used_percent: 10 }, semana),
    evento(cinco, semana),
    evento({ ...cinco, used_percent: 99 }, semana, { limit_id: "otro" }),
    '{"type":"event_msg","payload":{"type":"token_count","rate_limits":null}}',
    "",
  ].join("\n");
  const uso = ultimoUsoCodex(texto);
  assert.equal(uso.ventanas["5h"].usado, 48);
  assert.equal(uso.ventanas.semanal.usado, 51);
  assert.equal(uso.plan, "plus");
  assert.equal(ultimoUsoCodex("texto sin límites"), null);
});

test("una ventana ya reiniciada cuenta como vacía", () => {
  const uso = ultimoUsoCodex(evento(cinco, semana));
  const despues = Date.parse(uso.ventanas["5h"].reinicia) + 1000;
  const ahora = vigente(uso, despues);
  assert.equal(ahora.ventanas["5h"].usado, 0);
  assert.equal(ahora.ventanas.semanal.usado, 51);
  assert.equal(vigente(null), null);
});

test("la línea de estado mide el contexto de Claude sin sumar facturación acumulada", () => {
  assert.deepEqual(
    contextoLinea({
      context_window: {
        current_usage: {
          input_tokens: 1000,
          cache_read_input_tokens: 220000,
          cache_creation_input_tokens: 2000,
          output_tokens: 500,
        },
      },
    }),
    { usados: 223500, limite: 400000 },
  );
  assert.equal(
    contextoLinea({ rate_limits: { five_hour: { utilization: 0.7 } } }),
    null,
  );
});

test("lee el rollout más reciente sin devolver su contenido", async (t) => {
  const raiz = await mkdtemp(path.join(tmpdir(), "sb-uso-"));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  const dia = path.join(raiz, "sessions/2026/11/09");
  await mkdir(dia, { recursive: true });
  const viejo = path.join(dia, "rollout-a.jsonl");
  const nuevo = path.join(dia, "rollout-b.jsonl");
  await writeFile(viejo, evento({ ...cinco, used_percent: 5 }, semana));
  await writeFile(
    nuevo,
    `{"type":"response_item","texto":"secreto"}\n${evento(cinco, semana)}\n`,
  );
  await utimes(viejo, new Date(1000), new Date(1000));
  const uso = await leerUsoCodex(path.join(raiz, "sessions"));
  assert.equal(uso.ventanas["5h"].usado, 48);
  assert.ok(!JSON.stringify(uso).includes("secreto"));
  assert.equal(await leerUsoCodex(path.join(raiz, "no-existe")), null);
  const leer = crearUso({
    env: { CODEX_HOME: raiz },
    ahora: () => Date.parse("2026-11-09T03:00:00Z"),
  });
  assert.equal((await leer()).codex.ventanas.semanal.usado, 51);
  assert.deepEqual(await crearUso({ env: {} })(), {});
});

const AHORA = Date.parse("2026-11-09T03:00:00Z");
const entradaClaude = {
  session_id: "secreto-claude",
  cwd: "/ruta/secreta",
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1794200000 },
    seven_day: { used_percentage: 100, resets_at: 1794717096 },
  },
};
const entradaAgy = {
  email: "persona@example.test",
  model: { id: "gemini-3-pro" },
  quota: {
    "gemini-5h": {
      remaining_fraction: 0.75,
      reset_time: "2026-11-09T05:00:00Z",
      reset_in_seconds: 7200,
    },
    "gemini-weekly": {
      remaining_fraction: 0.9378,
      reset_time: "2026-11-12T05:00:00Z",
    },
    "3p-5h": { remaining_fraction: 0.1, reset_time: "2026-11-09T04:00:00Z" },
    "3p-weekly": { remaining_amount: 3, reset_time: "2026-11-12T04:00:00Z" },
  },
};
const carpetaTemporal = async (t) => {
  const raiz = await mkdtemp(path.join(tmpdir(), "sb-uso-linea-"));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  return raiz;
};

test("traduce las ventanas de Claude sin inventar las que faltan", () => {
  const ventanas = ventanasClaude(entradaClaude.rate_limits);
  assert.equal(ventanas["5h"].usado, 23.5);
  assert.equal(ventanas["5h"].reinicia, new Date(1794200000000).toISOString());
  assert.equal(ventanas["5h"].agotada, false);
  assert.equal(ventanas.semanal.agotada, true);
  assert.deepEqual(Object.keys(ventanasClaude({ seven_day: {} })), []);
  assert.deepEqual(ventanasClaude(undefined), {});
});

test("traduce la cuota de Antigravity según la familia del modelo", () => {
  const gemini = ventanasAgy(entradaAgy.quota, "gemini-3-pro");
  assert.equal(gemini["5h"].usado, 25);
  assert.equal(gemini.semanal.usado, 6.2);
  assert.equal(gemini.semanal.reinicia, "2026-11-12T05:00:00.000Z");
  // A bucket measured in amounts has no percentage to show.
  assert.deepEqual(Object.keys(ventanasAgy(entradaAgy.quota, "Claude Opus")), [
    "5h",
  ]);
  assert.equal(ventanasAgy(entradaAgy.quota, "gpt-5")["5h"].usado, 90);
  assert.deepEqual(
    ventanasAgy(
      { "gemini-5h": { remaining_fraction: 0.5, disabled: true } },
      "auto",
    ),
    {},
  );
  assert.deepEqual(ventanasAgy(undefined, null), {});
});

test("guarda solo números y conserva lo último si llega una entrada sin límites", async (t) => {
  const archivo = path.join(await carpetaTemporal(t), "nueva/sb-uso.json");
  assert.equal(await guardarUsoLinea("claude", { cwd: "/x" }, archivo), false);
  assert.equal(await leerUsoLinea(archivo), null);
  assert.equal(
    await guardarUsoLinea("claude", entradaClaude, archivo, AHORA),
    true,
  );
  const crudo = await readFile(archivo, "utf8");
  assert.ok(!crudo.includes("secreto"));
  assert.ok(!crudo.includes("/ruta"));
  await guardarUsoLinea("claude", { rate_limits: {} }, archivo, AHORA + 1000);
  assert.equal(
    (await leerUsoLinea(archivo)).actualizado,
    new Date(AHORA).toISOString(),
  );
  // A window the CLI drops stays recorded for `vigente` to empty it.
  await guardarUsoLinea(
    "claude",
    { rate_limits: { five_hour: entradaClaude.rate_limits.five_hour } },
    archivo,
    AHORA + 2000,
  );
  assert.equal((await leerUsoLinea(archivo)).ventanas.semanal.usado, 100);
  await writeFile(archivo, "{roto");
  assert.equal(await leerUsoLinea(archivo), null);
  await writeFile(
    archivo,
    JSON.stringify({
      ventanas: { "5h": { usado: "mucho" }, otra: { usado: 1 } },
    }),
  );
  assert.equal(await leerUsoLinea(archivo), null);
  assert.equal(await guardarUsoLinea("codex", entradaClaude, archivo), false);
});

test("cada motor con dato real aparece; el resto no recibe barras", async (t) => {
  const raiz = await carpetaTemporal(t);
  const claudeDir = path.join(raiz, "claude");
  const home = path.join(raiz, "home");
  const env = { AGENTES_CLAUDE_DIR: claudeDir, HOME: home };
  const reloj = () => AHORA;
  assert.deepEqual(await crearUso({ env, ahora: reloj })(), {});
  await guardarUsoLinea(
    "claude",
    entradaClaude,
    path.join(claudeDir, "sb-uso.json"),
    AHORA,
  );
  await guardarUsoLinea(
    "agy",
    entradaAgy,
    path.join(home, ".gemini/antigravity-cli/sb-uso.json"),
    AHORA,
  );
  const uso = await crearUso({ env, ahora: reloj })();
  assert.deepEqual(Object.keys(uso).sort(), ["agy", "claude"]);
  assert.equal(uso.claude.ventanas["5h"].usado, 23.5);
  assert.equal(uso.agy.ventanas["5h"].usado, 25);
  const tarde = await crearUso({
    env,
    ahora: () => Date.parse("2026-11-09T06:00:00Z"),
  })();
  assert.equal(tarde.agy.ventanas["5h"].usado, 0);
  assert.equal(tarde.agy.ventanas.semanal.usado, 6.2);
});

test("el comando de la línea guarda el uso e imprime la firma, incluso con datos rotos", async (t) => {
  const archivo = path.join(await carpetaTemporal(t), "sb-uso.json");
  const script = fileURLToPath(new URL("../usage-line.mjs", import.meta.url));
  const correr = (entrada) =>
    new Promise((resolve, reject) => {
      const hijo = execFile(
        process.execPath,
        [script, "agy", archivo, "Lira · Antigravity"],
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      hijo.stdin.end(entrada);
    });
  assert.equal(await correr("{roto"), "Lira · Antigravity");
  assert.equal(await leerUsoLinea(archivo), null);
  assert.equal(await correr(JSON.stringify(entradaAgy)), "Lira · Antigravity");
  assert.equal((await leerUsoLinea(archivo)).ventanas["5h"].usado, 25);
  assert.ok(!(await readFile(archivo, "utf8")).includes("persona"));
});

test("Ámbar y Lira miden sin pisar una línea propia; Marina no mide", async (t) => {
  const raiz = await carpetaTemporal(t);
  const leer = async (archivo) => JSON.parse(await readFile(archivo, "utf8"));
  const ambar = path.join(raiz, "claude");
  await mkdir(ambar);
  const opciones = { firma: "Ámbar · Claude", medir: true };
  await prepararClaude(ambar, "/w/p", opciones);
  const ajustes = path.join(ambar, "settings.json");
  assert.match(
    (await leer(ajustes)).statusLine.command,
    /usage-line\.mjs.*'claude'/,
  );
  // A new release moves the script: the line follows it.
  const propia = await leer(ajustes);
  propia.statusLine.command = "node /vieja/uso-linea.mjs";
  await writeFile(ajustes, JSON.stringify(propia));
  await prepararClaude(ambar, "/w/p", opciones);
  assert.ok(!(await leer(ajustes)).statusLine.command.includes("/vieja"));
  const personal = { type: "command", command: "mi-linea.sh" };
  await writeFile(ajustes, JSON.stringify({ statusLine: personal }));
  await prepararClaude(ambar, "/w/p", opciones);
  assert.deepEqual((await leer(ajustes)).statusLine, personal);

  const marina = path.join(raiz, "deepseek");
  await mkdir(marina);
  await prepararClaude(marina, "/w/p", { firma: "Marina · DeepSeek" });
  const lineaMarina = (await leer(path.join(marina, "settings.json")))
    .statusLine.command;
  assert.ok(!lineaMarina.includes("uso-linea"));

  const home = path.join(raiz, "home");
  const carpeta = path.join(home, ".gemini/antigravity-cli");
  await mkdir(carpeta, { recursive: true });
  await prepararAgy(home, "/w/p");
  const lira = await leer(path.join(carpeta, "settings.json"));
  assert.equal(lira.statusLine.stack_with_default, true);
  assert.equal(
    lira.statusLine.command,
    lineaUso("agy", carpeta, "Lira · Antigravity").command,
  );
  await writeFile(
    path.join(carpeta, "settings.json"),
    JSON.stringify({ statusLine: personal, trustedWorkspaces: ["/w/p"] }),
  );
  await prepararAgy(home, "/w/p");
  assert.deepEqual(
    (await leer(path.join(carpeta, "settings.json"))).statusLine,
    personal,
  );
});
