import { active, dateLabel, money, type Item } from "../../core/model";
import { taskOverview } from "../../core/overview";
import type { FinanceOverview } from "../finance/useFinance";

export interface ZoneSummary {
  headline: string;
  lines: string[];
}
export type RoomSummary = Record<
  "workshop" | "library" | "garden" | "cafe" | "terrace",
  ZoneSummary
>;
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;
export function roomSummary(
  items: Item[],
  day: string,
  options: {
    hidden: boolean;
    finance?: FinanceOverview;
    financeError?: string;
  },
): RoomSummary {
  const tasks = taskOverview(items, day);
  const projects = active(items, "project").filter(
    (p) =>
      !["archived", "done", "cancelled", "paused"].includes(p.status || ""),
  );
  const pending = active(items, "task")
    .filter((t) => !["done", "cancelled"].includes(t.status || ""))
    .sort((a, b) =>
      (a.date || a.plannedDate || "9999").localeCompare(
        b.date || b.plannedDate || "9999",
      ),
    );
  const { finance, financeError, hidden } = options;
  const legacy = [
    ...active(items, "obligation"),
    ...active(items, "statement").map((s) => ({
      ...s,
      date: s.dueDate,
      amountMinor: s.noInterestMinor,
    })),
  ]
    .filter(
      (p) =>
        !["done", "cancelled"].includes(p.status || "") &&
        p.date &&
        !p.validationErrors?.length,
    )
    .map((p) => ({
      type: "due" as const,
      date: p.date!,
      label: p.title,
      amountMinor: p.amountMinor,
      estimated: false,
    }));
  let cafe: ZoneSummary = {
    headline: "Pagos por consultar",
    lines: ["Abre Finanzas para revisar"],
  };
  if (financeError)
    cafe = {
      headline: "Pagos sin actualizar",
      lines: ["Revisa la conexión en Finanzas"],
    };
  else if (finance?.expired)
    cafe = {
      headline: "Datos financieros vencidos",
      lines: ["Actualiza antes de usar los importes"],
    };
  else if (finance?.configured || legacy.length) {
    const next = (finance?.configured ? finance.upcoming : legacy)
      ?.filter((p) => p.type === "due")
      .sort((a, b) => a.date.localeCompare(b.date))[0];
    cafe = next
      ? {
          headline: `${next.date < day ? "Pago vencido" : "Pago"} · ${dateLabel(next.date)}`,
          lines: hidden
            ? ["Importes ocultos"]
            : [
                next.label,
                `${next.amountMinor === undefined ? "Importe por confirmar" : money(next.amountMinor)}${next.estimated ? " · estimado" : ""}`,
              ],
        }
      : {
          headline: "Sin pagos con fecha",
          lines: ["Revisa pendientes en Finanzas"],
        };
  }
  // Keep source Markdown and financial raw data out of the render payload.
  return {
    workshop: {
      headline: count(projects.length, "proyecto activo", "proyectos activos"),
      lines: projects.length
        ? projects.slice(0, 3).map((p) => p.title)
        : ["Crea tu próximo proyecto"],
    },
    library: {
      headline: count(tasks.pending, "tarea pendiente", "tareas pendientes"),
      lines: [
        `${count(tasks.overdue, "vencida", "vencidas")} · ${tasks.today} para hoy`,
        ...pending.slice(0, 2).map((t) => t.title),
      ],
    },
    garden: {
      headline: "Maletín",
      lines: ["Archivos compartidos con el equipo"],
    },
    terrace: {
      headline: "Tu equipo",
      lines: [
        "Conversaciones por proyecto",
        count(projects.length, "proyecto activo", "proyectos activos"),
      ],
    },
    cafe,
  };
}
