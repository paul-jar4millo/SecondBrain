import { expect, it } from "vitest";
import { newItem } from "../src/core/model";
import { roomSummary } from "../src/features/room/room-summary";

const day = "2026-11-07";
it("uses actionable records and never exposes hidden source notes", () => {
  const data = roomSummary(
    [
      newItem("project", { title: "Activo", status: "active" }),
      newItem("project", { title: "Archivado", status: "archived" }),
      newItem("project", { title: "Pausado", status: "paused" }),
      newItem("task", { title: "Pendiente", date: day }),
      newItem("task", { title: "Tarde", date: "2026-11-06" }),
      newItem("task", { title: "Cancelada", status: "cancelled", date: day }),
      newItem("task", { title: "Borrada", deleted: true, date: day }),
      newItem("event", {
        title: "Rutina",
        date: "2026-11-06",
        endDate: "2026-11-08",
        time: "09:00",
      }),
      newItem("note", { title: "SECRETO", body: "SECRETO" }),
    ],
    day,
    { hidden: true },
  );
  expect(data.workshop.headline).toBe("1 proyecto activo");
  expect(data.library.headline).toBe("2 tareas pendientes");
  expect(data.library.lines).toEqual([
    "1 vencida · 1 para hoy",
    "Tarde",
    "Pendiente",
  ]);
  expect(data.terrace.lines).toEqual([
    "Threads por proyecto",
    "1 proyecto activo",
  ]);
  expect(JSON.stringify(data)).not.toMatch(
    /SECRETO|Archivado|Pausado|Cancelada|Borrada/,
  );
});

it("removes amounts from every summary when hidden, including stale and error states", () => {
  const finance = {
    configured: true,
    upcoming: [
      {
        type: "due" as const,
        date: "2026-11-10",
        label: "Tarjeta",
        amountMinor: 123456,
        estimated: true,
      },
    ],
  };
  expect(
    roomSummary([], day, { hidden: false, finance }).cafe.lines.join(" "),
  ).toContain("1,234.56");
  const hidden = roomSummary([], day, { hidden: true, finance }).cafe;
  expect(hidden.lines).toEqual(["Importes ocultos"]);
  expect(
    roomSummary([], day, {
      hidden: false,
      finance: { ...finance, expired: true },
    }).cafe.headline,
  ).toBe("Datos financieros vencidos");
  expect(
    roomSummary([], day, { hidden: false, finance, financeError: "failed" })
      .cafe.headline,
  ).toBe("Pagos sin actualizar");
});

it("sorts payments without treating cuts as payments or unknown amounts as zero", () => {
  const finance = {
    configured: true,
    upcoming: [
      {
        type: "cut" as const,
        date: "2026-11-08",
        label: "Corte",
        amountMinor: 999,
        estimated: false,
      },
      {
        type: "due" as const,
        date: "2026-11-12",
        label: "Después",
        amountMinor: 500,
        estimated: false,
      },
      {
        type: "due" as const,
        date: "2026-11-09",
        label: "Antes",
        estimated: false,
      },
    ],
  };
  const result = roomSummary([], day, { hidden: false, finance }).cafe;
  expect(result.headline).toBe("Pago · 9 nov");
  expect(result.lines).toEqual(["Antes", "Importe por confirmar"]);
  expect(roomSummary([], day, { hidden: false }).cafe.headline).toBe(
    "Pagos por consultar",
  );
});

it("shows dated legacy obligations in demo and masks their amounts", () => {
  const items = [
    newItem("obligation", {
      title: "Servicio",
      date: "2026-11-08",
      amountMinor: 50000,
    }),
    newItem("obligation", {
      title: "Liquidado",
      date: day,
      status: "done",
      amountMinor: 900,
    }),
  ];
  expect(roomSummary(items, day, { hidden: false }).cafe.lines).toEqual([
    "Servicio",
    "$500.00",
  ]);
  expect(roomSummary(items, day, { hidden: true }).cafe.lines).toEqual([
    "Importes ocultos",
  ]);
});
