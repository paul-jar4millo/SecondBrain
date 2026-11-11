import { describe, expect, it } from "vitest";
import { newItem } from "../src/core/model";
import { describeDraft, parsePrompt } from "../src/core/prompt";
import {
  agentRequest,
  projectPrompt,
  taskPrompt,
} from "../src/core/agent-prompt";

// Saturday.
const day = "2026-11-07";
const semester = newItem("project", {
  title: "Cerrar el semestre",
  status: "active",
});
const items = [semester];
const one = (text: string, options = {}) =>
  parsePrompt(text, items, day, options)[0];

describe("parsePrompt", () => {
  it("creates a plain task from a phrase", () => {
    expect(one("comprar pan")).toMatchObject({
      kind: "task",
      title: "Comprar pan",
      status: "pending",
    });
  });
  it("uses the page defaults when the phrase has no date or project", () => {
    expect(
      one("comprar pan", { plannedDate: day, projectId: "p1" }),
    ).toMatchObject({ plannedDate: day, projectId: "p1" });
  });
  it("reads relative days without eating a time of day", () => {
    expect(one("Llamar al banco mañana")).toMatchObject({
      title: "Llamar al banco",
      plannedDate: "2026-11-08",
    });
    expect(one("pasado mañana lavar el coche").plannedDate).toBe("2026-11-09");
    expect(one("correr por la mañana")).toMatchObject({
      title: "Correr por la mañana",
    });
    expect(one("correr por la mañana").plannedDate).toBeUndefined();
  });
  it("treats weekdays as the next occurrence, never today", () => {
    expect(one("pagar renta el lunes").plannedDate).toBe("2026-11-09");
    expect(one("pagar renta el sábado").plannedDate).toBe("2026-11-14");
  });
  it("reads numeric and written dates, rolling past ones to next year", () => {
    expect(one("entregar acta 12 de noviembre").plannedDate).toBe("2026-11-12");
    expect(one("renovar seguro 3 de enero").plannedDate).toBe("2027-01-03");
    expect(one("ver notas 20/11").plannedDate).toBe("2026-11-20");
  });
  it("ignores impossible dates instead of inventing one", () => {
    const draft = one("revisar 31 de febrero");
    expect(draft.plannedDate).toBeUndefined();
    expect(draft.title).toBe("Revisar 31 de febrero");
  });
  it("uses the due date only for deadlines", () => {
    const draft = one("Entregar reporte antes del viernes");
    expect(draft).toMatchObject({
      title: "Entregar reporte",
      date: "2026-11-13",
    });
    expect(draft.plannedDate).toBeUndefined();
  });
  it("links an existing project, accents and case aside", () => {
    expect(one("revisar borrador para cerrar el SEMESTRE")).toMatchObject({
      title: "Revisar borrador",
      projectId: semester.id,
    });
  });
  it("ignores finished or deleted projects", () => {
    const list = [
      newItem("project", { title: "Viejo", status: "done" }),
      newItem("project", { title: "Borrado", deleted: true }),
    ];
    expect(
      parsePrompt("algo para Viejo", list, day)[0].projectId,
    ).toBeUndefined();
    expect(parsePrompt("algo Borrado", list, day)[0].projectId).toBeUndefined();
  });
  it("turns a time into a one-hour event, defaulting to today", () => {
    expect(one("Dentista mañana a las 10:30")).toMatchObject({
      kind: "event",
      title: "Dentista",
      date: "2026-11-08",
      endDate: "2026-11-08",
      time: "10:30",
      endTime: "11:30",
    });
    expect(one("gym a las 5 pm")).toMatchObject({
      date: day,
      time: "17:00",
      endTime: "18:00",
    });
  });
  it("keeps a late event inside a valid end", () => {
    expect(one("Cena a las 23:30")).toMatchObject({
      endDate: "2026-11-08",
      endTime: "00:30",
    });
  });
  it("makes an all-day event with an exclusive end", () => {
    expect(one("reunión con Ana el lunes")).toMatchObject({
      kind: "event",
      title: "Reunión con Ana",
      date: "2026-11-09",
      endDate: "2026-11-10",
    });
  });
  it("leaves a meeting word without a date as a task", () => {
    expect(one("preparar reunión").kind).toBe("task");
  });
  it("creates projects and attaches the following lines to them", () => {
    const [project, first, second] = parsePrompt(
      "Nuevo proyecto: Mudanza\n- Cotizar camión\n- Empacar libros el lunes",
      items,
      day,
    );
    expect(project).toMatchObject({
      kind: "project",
      title: "Mudanza",
      status: "active",
    });
    expect(project.id).toBeTruthy();
    expect(first).toMatchObject({
      title: "Cotizar camión",
      projectId: project.id,
    });
    expect(second).toMatchObject({
      title: "Empacar libros",
      projectId: project.id,
      plannedDate: "2026-11-09",
    });
  });
  it("strips polite commands", () => {
    expect(one("recuérdame comprar pan").title).toBe("Comprar pan");
    expect(one("Crea una tarea: comprar pan").title).toBe("Comprar pan");
  });
  it("marks priority only while the three slots last", () => {
    expect(one("urgente pagar luz")).toMatchObject({
      title: "Pagar luz",
      priority: true,
    });
    const full = Array.from({ length: 3 }, () =>
      newItem("task", { title: "x", priority: true, status: "pending" }),
    );
    const draft = parsePrompt("urgente pagar luz", full, day)[0];
    expect(draft.title).toBe("Pagar luz");
    expect(draft.priority).toBeUndefined();
    const lines = parsePrompt("urgente a1\nurgente b2", full.slice(1), day);
    expect(lines.map((x) => x.priority)).toEqual([true, undefined]);
  });
  it("returns nothing for empty text or a phrase with only a date", () => {
    expect(parsePrompt("   \n ", items, day)).toEqual([]);
    expect(parsePrompt("mañana", items, day)).toEqual([]);
  });
});

describe("describeDraft", () => {
  it("names what will be created in plain words", () => {
    const draft = one("Dentista el lunes a las 10 para cerrar el semestre");
    expect(describeDraft(draft, items, day)).toEqual([
      "Evento",
      "9 nov",
      "10:00",
      "Cerrar el semestre",
    ]);
    expect(describeDraft(one("comprar pan hoy"), items, day)).toEqual([
      "Tarea",
      "Hoy",
    ]);
  });
});

describe("agent prompts", () => {
  it("gives the agent the task, its project and the vault rules", () => {
    const task = newItem("task", {
      title: "Revisar borrador",
      body: "Falta la conclusión",
      date: "2026-11-12",
      projectId: semester.id,
      vaultPath: "01-Proyectos/Semestre.md",
    });
    const text = taskPrompt(task, items);
    for (const part of [
      "Revisar borrador",
      "Cerrar el semestre",
      "Falta la conclusión",
      "2026-11-12",
      "01-Proyectos/Semestre.md",
      "brain_context",
    ])
      expect(text).toContain(part);
  });
  it("plans a project from its open tasks, without finished ones or notes", () => {
    const list = [
      ...items,
      newItem("task", { title: "Abierta", projectId: semester.id }),
      newItem("task", {
        title: "Cerrada",
        status: "done",
        projectId: semester.id,
      }),
      newItem("note", { title: "Privada", projectId: semester.id }),
    ];
    const text = projectPrompt(semester, list, day);
    expect(text).toContain("Cerrar el semestre");
    expect(text).toContain("Abierta");
    expect(text).not.toContain("Cerrada");
    expect(text).not.toContain("Privada");
  });
  it("wraps a free request", () => {
    expect(agentRequest("Ordena mi semana")).toContain("Ordena mi semana");
    expect(agentRequest("Ordena mi semana")).toContain("brain_context");
  });
});
