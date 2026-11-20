#!/usr/bin/env node
// Agent-facing CLI. Writes through the same validated, atomic vault code the
// app uses, so agents never hand-edit Markdown for structured data.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Vault, discoverVault } from "../../service/vault.mjs";
import {
  Finance,
  OPERATIONS,
  mexicoDay,
  addDays,
  UNIDENTIFIED,
  overview as computeOverview,
} from "../../service/finance.mjs";
import { parseLedgerExport } from "../../service/finance-import.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const HELP = `Second Brain · CLI para agentes (node dashboard/ops/sb.mjs <comando>)

  finance show [--json]                 Resumen financiero calculado
  finance <op> [--clave valor ...]      Cambia datos financieros (ver abajo)
  finance --json '{"op":"charge",...}'  Igual, con JSON
  finance import-registro <archivo.md> [--dry-run]
  capture "texto" [--body "detalle"]    Nota nueva en el Inbox de la app
  task "título" [--date AAAA-MM-DD] [--plan AAAA-MM-DD] [--project nombre]
  stale [--days 7]                      Notas con datos perecederos caducados

Operaciones de finanzas (importes en pesos: --amount 1234.50):
  charge   --card Gold --amount 120 --desc "Tacos" [--date] [--category] [--pending] [--note] [--ref id]
  payment  --card LikeU --amount 600 [--date] [--pending]
  refund   --card LikeU --amount 19.41 --desc "Rappi (reversa)"
  cashback --card Plata --amount 2.5
  settle   --id t028                    Marca un movimiento en proceso como aplicado
  tx-edit  --id t009 [--category X] [--desc X] [--note X] [--date X]
  tx-delete --id t009
  card-set --card Gold [--balance] [--pay] [--limit] [--cutDate] [--dueDate] [--dueEstimated false] [--cycleStart] [--payNote] [--asOf]
  card-add --name Oro --limit 8000 [--last4] [--balance] [--pay] [--cutDate] [--dueDate]
  installment-set --label "Meta Quest" --card LikeU --original 5538.6 --months 12 --monthly 461.55 --paid 11 [--estimated true]
  installment-pay --label "Meta Quest" [--count 1]
  installment-remove --label X
  commitment-set --label Claude --amount 349 [--card Gold] [--dayOfMonth 15]
  commitment-remove --label X
  cash-set --label Beca --amount 2500 [--kind savings|income|other] [--recurring true] [--available AAAA-MM-DD]
  cash-remove --label X
  income-set --monthly 3000
  question-add --text "¿Es el pago sin intereses?"   /  question-resolve --id q01
  settings [--leakCategories "Comida fuera,Rappi"] [--validityDays 7] [--staleAfterDays 3]
  reconcile                             Marca todo el estado como verificado hoy

Reglas: un pago no es gasto; "en proceso" no cambia el saldo hasta settle;
sin categoría conocida, el cargo queda "${UNIDENTIFIED}" (pregunta, no inventes).
`;

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg
        .slice(2)
        .replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[key] = true;
      else {
        flags[key] = next;
        i++;
      }
    } else positional.push(arg);
  }
  return { flags, positional };
}
const fail = (message) => {
  console.error("Error: " + message);
  process.exit(1);
};
const money = (n) =>
  new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" }).format(
    (n || 0) / 100,
  );

async function open() {
  const root = await discoverVault(
    process.env.VAULT_ROOT || "/srv/secondbrain/vault",
  );
  const data = process.env.DATA_DIR || path.join(appRoot, ".data");
  return new Vault(root, path.join(data, "operations"));
}

function render(o) {
  if (!o.configured)
    return "Sin datos financieros. Usa: finance import-registro <archivo> o finance init.";
  const out = [];
  out.push(
    `Finanzas · verificado ${o.reconciledAt}${o.expired ? " (CADUCADO)" : ", vigente hasta " + o.expiresAt}`,
  );
  out.push(
    `Crédito usado ${money(o.totals.usedMinor)} de ${money(o.totals.limitMinor)} (${(o.totals.usedPct * 100).toFixed(1)}%) · cargos de los ciclos ${money(o.totals.cycleChargesMinor)}`,
  );
  for (const c of o.cards)
    out.push(
      `  ${c.name} ····${c.last4 || "????"}  saldo ${money(c.balanceMinor)} / ${money(c.limitMinor)}  a pagar ${c.payMinor === undefined ? "?" : money(c.payMinor)}  corte ${c.cutDate || "?"}  límite ${c.dueDate || "?"}${c.dueEstimated ? "~" : ""}  (al ${c.asOf || "?"})`,
    );
  const f = o.flow;
  out.push(
    `Flujo: entradas ${money(f.inflowsMinor)} − por pagar ${money(f.payMinor)} − compromisos ${money(f.commitmentsMinor)} = margen ${money(f.marginMinor)}`,
  );
  if (o.alerts.length) {
    out.push("Avisos:");
    for (const a of o.alerts) out.push(`  [${a.level}] ${a.text}`);
  }
  if (o.questions.length) {
    out.push("Preguntas abiertas:");
    for (const q of o.questions) out.push(`  ${q.id}: ${q.text}`);
  }
  return out.join("\n");
}

async function main() {
  const { flags, positional } = parse(process.argv.slice(2));
  const [area, command, ...rest] = positional;
  if (!area || flags.help || area === "help") return console.log(HELP);
  const vault = await open();
  const today = mexicoDay();

  if (area === "finance") {
    const finance = new Finance(vault);
    if (command === "show" || (command === undefined && !flags.json)) {
      const o = await finance.overview(today);
      return console.log(flags.json ? JSON.stringify(o, null, 2) : render(o));
    }
    if (command === "ops") return console.log(OPERATIONS.join("\n"));
    if (command === "import-registro") {
      const file = rest[0];
      if (!file) fail("Indica el archivo del registro.");
      const parsed = parseLedgerExport(await readFile(file, "utf8"), today);
      const view = computeOverview(parsed.data, today);
      const checks = [
        [
          "cargos del ciclo",
          view.totals.cycleChargesMinor,
          parsed.expected.cycleChargesMinor,
        ],
        ["crédito usado", view.totals.usedMinor, parsed.expected.usedMinor],
        ["por pagar", view.totals.payMinor, parsed.expected.payMinor],
        ["margen", view.flow.marginMinor, parsed.expected.marginMinor],
      ];
      for (const [name, got, want] of checks)
        console.log(
          `${got === want || want === undefined ? "OK " : "DIFIERE"} ${name}: ${money(got)}${want !== undefined && got !== want ? " (esperado " + money(want) + ")" : ""}`,
        );
      if (checks.some(([, got, want]) => want !== undefined && got !== want))
        fail(
          "El importe calculado no coincide con los indicadores del registro; no se escribió nada.",
        );
      if (flags.dryRun)
        return console.log(
          `Simulación: ${parsed.data.transactions.length} movimientos, ${parsed.data.cards.length} tarjetas.`,
        );
      await finance.create(parsed.data, today);
      return console.log(
        `Importado: ${parsed.data.transactions.length} movimientos, ${parsed.data.cards.length} tarjetas, ${parsed.data.installments.length} mensualidades.`,
      );
    }
    let op;
    if (typeof flags.json === "string") op = JSON.parse(flags.json);
    else {
      const { json, ...rest2 } = flags;
      op = { op: command, ...rest2 };
      if (op.pending) {
        op.status = "pending";
        delete op.pending;
      }
    }
    const { result, overview: view } = await finance.run(op, today);
    console.log(JSON.stringify(result, null, 2));
    console.log(
      `\nMargen: ${money(view.flow.marginMinor)} · crédito usado ${money(view.totals.usedMinor)} (${(view.totals.usedPct * 100).toFixed(1)}%) · avisos: ${view.alerts.length}`,
    );
    return;
  }

  if (area === "capture") {
    const title = [command, ...rest].filter(Boolean).join(" ").trim();
    if (!title) fail('Escribe el texto: capture "idea o dato".');
    const now = new Date().toISOString();
    const saved = await vault.mutate({
      mutationId: randomUUID(),
      baseVersion: 0,
      entity: {
        id: randomUUID(),
        kind: "inbox",
        title: title.slice(0, 200),
        body:
          typeof flags.body === "string"
            ? flags.body
            : title.length > 200
              ? title
              : "",
        status: "unprocessed",
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    return console.log(`Inbox: ${saved.vaultPath}`);
  }

  if (area === "task") {
    const title = [command, ...rest].filter(Boolean).join(" ").trim();
    if (!title) fail('Escribe el título: task "algo por hacer".');
    const snapshot = await vault.read();
    let projectId;
    if (typeof flags.project === "string") {
      const hit = snapshot.items.find(
        (i) =>
          i.kind === "project" &&
          i.title.toLowerCase().includes(flags.project.toLowerCase()),
      );
      if (!hit) fail("No existe el proyecto " + flags.project);
      projectId = hit.id;
    }
    const now = new Date().toISOString();
    const saved = await vault.mutate({
      mutationId: randomUUID(),
      baseVersion: 0,
      entity: {
        id: randomUUID(),
        kind: "task",
        title,
        status: "pending",
        date: typeof flags.date === "string" ? flags.date : undefined,
        plannedDate: typeof flags.plan === "string" ? flags.plan : undefined,
        projectId,
        version: 0,
        createdAt: now,
        updatedAt: now,
      },
    });
    return console.log(`Tarea: ${saved.vaultPath}`);
  }

  if (area === "stale") {
    const days = Number(flags.days ?? 7);
    const limit = addDays(today, days);
    const rows = (await vault.read()).items
      .filter(
        (i) =>
          i.sourceKind === "document" && i.expiresAt && i.expiresAt <= limit,
      )
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    if (!rows.length) return console.log("Nada caduca en " + days + " días.");
    for (const r of rows)
      console.log(
        `${r.expiresAt < today ? "CADUCADO" : "caduca  "} ${r.expiresAt}  ${r.vaultPath}  (verificado ${r.verifiedAt || "?"})`,
      );
    return;
  }
  fail("Comando desconocido. Usa --help.");
}
main().catch((error) => fail(error.message || String(error)));
