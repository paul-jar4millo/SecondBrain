import {
  active,
  dateLabel,
  projectName,
  shiftDay,
  uid,
  type Item,
} from "./model";

/**
 * Local, rule-based reading of a Spanish phrase. It costs nothing and sends
 * nothing anywhere; the bar always previews the result before saving.
 */
export type PromptDraft = Partial<Item> & {
  kind: "task" | "event" | "project";
  title: string;
};
export interface PromptOptions {
  /** Applied when the phrase has no date of its own (the Hoy page). */
  plannedDate?: string;
  /** Applied when the phrase names no project (a project's own page). */
  projectId?: string;
}

const LEFT = "(?<![\\p{L}\\p{N}])";
const RIGHT = "(?![\\p{L}\\p{N}])";
const word = (source: string) => new RegExp(LEFT + source + RIGHT, "iu");
const MONTHS = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
// Index matches Date.getUTCDay().
const WEEKDAYS = [
  "domingo",
  "lunes",
  "martes",
  "mi[eé]rcoles",
  "jueves",
  "viernes",
  "s[aá]bado",
];
const DEADLINE =
  "(?:antes\\s+del?|para\\s+el|para|vence\\s+el|vence|l[ií]mite\\s+el)\\s+";
const ON = "(?:(?:el|este|el\\s+pr[oó]ximo|pr[oó]ximo)\\s+)?";
const PRIORITY = word("(?:urgente|importante|prioridad|prioritari[oa])");
const EVENT_WORD = word(
  "(?:reuni[oó]n|cita|junta|evento|cumplea[nñ]os|examen|entrevista)",
);
const LEAD = new RegExp(
  "^(?:por\\s+favor\\s+)?(?:(?:crea|crear|a[nñ]ade|a[nñ]adir|agrega|agregar|apunta|anota)\\s+)?" +
    "(?:(?:una?\\s+)?(?:nueva\\s+)?(?:tarea|pendiente)\\s*(?:[:,-]\\s*|\\s+)|" +
    "(?:recu[eé]rdame|recordarme|recordar)\\s+(?:que\\s+)?(?:debo\\s+|tengo\\s+que\\s+)?)",
  "iu",
);
const PROJECT = new RegExp(
  "^(?:(?:crea|crear|abre|abrir|empieza|empezar|inicia|iniciar)\\s+)?(?:un\\s+)?(?:nuevo\\s+)?proyecto\\s*(?:[:,-]\\s*|\\s+)(.+)$",
  "iu",
);

const cut = (text: string, match: RegExpExecArray) =>
  text.slice(0, match.index) + " " + text.slice(match.index + match[0].length);

const validDay = (year: number, month: number, date: number) => {
  const value = new Date(Date.UTC(year, month - 1, date));
  return value.getUTCMonth() === month - 1 && value.getUTCDate() === date
    ? value.toISOString().slice(0, 10)
    : undefined;
};
/** Next valid occurrence of a month and day, on or after `day`. */
function calendarDay(day: string, month: number, date: number) {
  const year = Number(day.slice(0, 4));
  const current = validDay(year, month, date);
  if (!current) return undefined;
  return current >= day ? current : validDay(year + 1, month, date);
}
function nextWeekday(day: string, target: number) {
  const now = new Date(day + "T12:00:00Z").getUTCDay();
  return shiftDay(day, (target - now + 7) % 7 || 7);
}

type DateRule = [
  source: string,
  read: (groups: string[], day: string) => string | undefined,
];
const DATE_RULES: DateRule[] = [
  ["pasado\\s+ma[nñ]ana", (_, day) => shiftDay(day, 2)],
  // "por la mañana" is a time of day, not tomorrow.
  ["(?<!la\\s)(?<!las\\s)ma[nñ]ana", (_, day) => shiftDay(day, 1)],
  ["hoy", (_, day) => day],
  ["en\\s+(\\d{1,2})\\s+d[ií]as?", ([n], day) => shiftDay(day, Number(n))],
  [
    "(?:la\\s+)?(?:pr[oó]xima\\s+semana|semana\\s+que\\s+viene)",
    (_, day) => nextWeekday(day, 1),
  ],
  [
    `(?:el\\s+)?(\\d{1,2})\\s+de\\s+(${MONTHS.join("|")})`,
    ([date, month], day) =>
      calendarDay(day, MONTHS.indexOf(month.toLowerCase()) + 1, Number(date)),
  ],
  [
    "(?:el\\s+)?(\\d{1,2})/(\\d{1,2})",
    ([date, month], day) => calendarDay(day, Number(month), Number(date)),
  ],
  ...WEEKDAYS.map((name, index): DateRule => [
    ON + name,
    (_, day) => nextWeekday(day, index),
  ]),
];

function takeDate(text: string, day: string) {
  for (const [source, read] of DATE_RULES) {
    const match = word(`(${DEADLINE})?(?:${source})`).exec(text);
    if (!match) continue;
    const value = read(match.slice(2), day);
    if (value) return { value, deadline: !!match[1], rest: cut(text, match) };
  }
  return { rest: text };
}

const TIME = word(
  "(?:(?:a\\s+las?|de\\s+las?)\\s+(\\d{1,2})(?::(\\d{2}))?(?:\\s*(am|pm))?|(\\d{1,2}):(\\d{2})(?:\\s*(am|pm))?|(\\d{1,2})\\s*(am|pm))",
);
function takeTime(text: string) {
  const m = TIME.exec(text);
  if (!m) return { rest: text };
  let hour = Number(m[1] ?? m[4] ?? m[7]);
  const minute = Number(m[2] ?? m[5] ?? 0);
  const meridiem = (m[3] ?? m[6] ?? m[8] ?? "").toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return { rest: text };
  return { hour, minute, rest: cut(text, m) };
}

const ACCENTS: Record<string, string> = {
  a: "[aá]",
  e: "[eé]",
  i: "[ií]",
  o: "[oó]",
  u: "[uúü]",
  n: "[nñ]",
};
const fold = (value: string) =>
  value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function takeProject(text: string, items: Item[]) {
  const projects = active(items, "project")
    .filter((p) => !["done", "archived"].includes(p.status || "") && p.title)
    .sort((a, b) => b.title.length - a.title.length);
  for (const project of projects) {
    const title = fold(project.title)
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/[aeioun]/g, (c) => ACCENTS[c])
      .replace(/\s+/g, "\\s+");
    const match = word(
      `(?:(?:para|en|de|del)\\s+(?:el\\s+)?(?:proyecto\\s+)?|proyecto\\s+)?${title}`,
    ).exec(text);
    if (match) return { id: project.id, rest: cut(text, match) };
  }
  return { rest: text };
}

const clean = (text: string) => {
  const value = text
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
    .replace(/\s+(?:el|la|los|las|para|de|del|a|en|y)$/iu, "")
    .trim();
  return value.charAt(0).toUpperCase() + value.slice(1);
};
const pad = (value: number) => String(value).padStart(2, "0");

function parseLine(
  source: string,
  items: Item[],
  day: string,
  options: PromptOptions,
  slots: { priority: number },
): PromptDraft | null {
  const line = source.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
  if (!line) return null;
  const project = PROJECT.exec(line);
  if (project) {
    const title = clean(project[1]);
    return title
      ? { id: uid(), kind: "project", title, status: "active" }
      : null;
  }
  let text = line.replace(LEAD, "");
  const wantsPriority = PRIORITY.test(text);
  text = text.replace(PRIORITY, " ");
  const linked = takeProject(text, items);
  const time = takeTime(linked.rest);
  const when = takeDate(time.rest, day);
  const title = clean(when.rest);
  if (!title) return null;
  const projectId = linked.id || options.projectId;
  const link = projectId ? { projectId } : {};
  if (time.hour !== undefined) {
    const date = when.value || day;
    const nextHour = time.hour + 1;
    return {
      kind: "event",
      title,
      date,
      endDate: nextHour > 23 ? shiftDay(date, 1) : date,
      time: `${pad(time.hour)}:${pad(time.minute)}`,
      endTime: `${pad(nextHour % 24)}:${pad(time.minute)}`,
      ...link,
    };
  }
  if (when.value && EVENT_WORD.test(title))
    return {
      kind: "event",
      title,
      date: when.value,
      endDate: shiftDay(when.value, 1),
      ...link,
    };
  const planned = when.value || options.plannedDate;
  const useSlot = wantsPriority && slots.priority > 0;
  if (useSlot) slots.priority -= 1;
  return {
    kind: "task",
    title,
    status: "pending",
    ...(when.deadline
      ? { date: when.value }
      : planned
        ? { plannedDate: planned }
        : {}),
    ...(useSlot ? { priority: true } : {}),
    ...link,
  };
}

/** One draft per line. Lines after a new project belong to that project. */
export function parsePrompt(
  text: string,
  items: Item[],
  day: string,
  options: PromptOptions = {},
): PromptDraft[] {
  const taken = active(items, "task").filter(
    (t) => t.priority && !["done", "cancelled"].includes(t.status || ""),
  ).length;
  const slots = { priority: Math.max(0, 3 - taken) };
  const drafts: PromptDraft[] = [];
  let context = options;
  for (const line of text.split("\n")) {
    const draft = parseLine(line, items, day, context, slots);
    if (!draft) continue;
    drafts.push(draft);
    if (draft.kind === "project") context = { ...context, projectId: draft.id };
  }
  return drafts;
}

const KIND_LABEL = { task: "Tarea", event: "Evento", project: "Proyecto" };
/** Short facts for the preview, in the order they read aloud. */
export function describeDraft(draft: PromptDraft, items: Item[], day: string) {
  const when = draft.date || draft.plannedDate;
  const project = projectName(items, draft.projectId);
  return [
    KIND_LABEL[draft.kind],
    ...(when ? [when === day ? "Hoy" : dateLabel(when)] : []),
    ...(draft.time ? [draft.time] : []),
    ...(draft.kind === "task" && draft.date ? ["Fecha límite"] : []),
    ...(draft.priority ? ["Prioridad"] : []),
    ...(project ? [project] : []),
  ];
}
