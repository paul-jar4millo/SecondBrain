import { newItem, today, shiftDay, type Item } from "./model";
export function demoData(): Item[] {
  const d = today();
  const project = newItem("project", {
    title: "Un espacio para mis ideas",
    body: "Tener un lugar al que volver para pensar, organizarme y encontrar lo que necesito.",
    area: "Personal",
    status: "active",
    date: shiftDay(d, 14),
  });
  const study = newItem("project", {
    title: "Cerrar el semestre",
    area: "Estudio",
    body: "Ordenar entregas, reservar tiempo y llegar con calma al cierre.",
    status: "active",
    date: shiftDay(d, 28),
  });
  const a = newItem("account", {
    title: "Cuenta del día a día",
    accountType: "asset",
    currency: "MXN",
  });
  const c = newItem("account", {
    title: "Tarjeta personal",
    accountType: "credit",
    currency: "MXN",
  });
  return [
    project,
    study,
    a,
    c,
    newItem("task", {
      title: "Darle forma a mi próxima semana",
      status: "pending",
      priority: true,
      plannedDate: d,
      projectId: project.id,
    }),
    newItem("task", {
      title: "Revisar el borrador de la entrega",
      status: "pending",
      priority: true,
      date: d,
      projectId: study.id,
    }),
    newItem("task", {
      title: "Reservar un momento para leer",
      status: "pending",
      priority: true,
      plannedDate: d,
      area: "Personal",
    }),
    newItem("task", {
      title: "Organizar referencias del proyecto",
      status: "pending",
      date: shiftDay(d, 1),
      projectId: project.id,
    }),
    newItem("task", {
      title: "Elegir el tema de la presentación",
      status: "done",
      plannedDate: d,
      projectId: study.id,
    }),
    newItem("event", {
      title: "Un bloque para avanzar",
      date: d,
      endDate: d,
      time: "10:00",
      endTime: "11:30",
      timezone: "America/Mexico_City",
      projectId: study.id,
      body: "Revisar el borrador y anotar los siguientes pasos.",
    }),
    newItem("event", {
      title: "Salir a caminar",
      date: d,
      endDate: d,
      time: "18:00",
      endTime: "18:30",
      timezone: "America/Mexico_City",
      body: "Un poco de aire al terminar el día.",
    }),
    newItem("event", {
      title: "Revisión de la semana",
      date: shiftDay(d, 2),
      endDate: shiftDay(d, 2),
      time: "17:00",
      endTime: "17:20",
      timezone: "America/Mexico_City",
    }),
    newItem("inbox", {
      title: "Una idea para el próximo proyecto",
      body: "¿Y si empiezo por resolver un problema pequeño que tengo todos los días?",
      status: "unprocessed",
    }),
    newItem("inbox", {
      title: "Volver a leer sobre diseño de sistemas",
      status: "unprocessed",
    }),
    newItem("inbox", {
      title: "Revisar las suscripciones del mes",
      status: "unprocessed",
    }),
    newItem("note", {
      title: "Menos cosas, con más intención",
      body: "# Menos cosas, con más intención\n\nNo necesito un sistema perfecto. Necesito un lugar al que volver.\n\n## Para esta semana\n\n- Elegir qué merece mi atención.\n- Dejar espacio entre compromisos.\n- Anotar las ideas antes de olvidarlas.\n\nUna buena pregunta al terminar el día: **¿qué hizo que hoy valiera la pena?**",
      area: "Personal",
      tags: ["reflexiones"],
      projectId: project.id,
    }),
    newItem("note", {
      title: "Mi revisión semanal",
      body: "## Revisión semanal\n\n1. Vaciar lo que quedó en el inbox.\n2. Revisar proyectos y elegir una siguiente acción.\n3. Mirar la agenda de las próximas dos semanas.\n4. Comprobar pagos y compromisos.",
      area: "Personal",
      tags: ["rutinas"],
    }),
    newItem("note", {
      title: "Ideas que quiero explorar",
      body: "## En algún momento\n\n- Una pequeña biblioteca personal.\n- Aprender haciendo un proyecto real.\n- Documentar lo que descubro para poder volver a ello.",
      area: "Aprendizaje",
      tags: ["ideas"],
    }),
    newItem("transaction", {
      title: "Saldo de apertura",
      accountId: a.id,
      transactionType: "opening",
      amountMinor: 250000,
      date: d,
      status: "confirmed",
    }),
    newItem("transaction", {
      title: "Libreta y material",
      accountId: c.id,
      transactionType: "expense",
      amountMinor: 18500,
      date: d,
      category: "Personal",
      status: "confirmed",
    }),
    newItem("transaction", {
      title: "Café y una pausa",
      accountId: a.id,
      transactionType: "expense",
      amountMinor: 6500,
      date: d,
      category: "Comida",
      status: "confirmed",
    }),
    newItem("obligation", {
      title: "Revisar pago de tarjeta",
      date: shiftDay(d, 4),
      amountMinor: 18500,
      status: "pending",
      accountId: c.id,
    }),
  ];
}
