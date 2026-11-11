export const statusLabel: Record<string, string> = {
  pending: "Pendiente",
  doing: "En curso",
  waiting: "En espera",
  done: "Completada",
  cancelled: "Cancelada",
  active: "Activo",
  paused: "Pausado",
  archived: "Archivado",
};

export const projectStatusLabel: Record<string, string> = {
  active: "En marcha",
  pending: "En marcha",
  paused: "Pausado",
  done: "Completado",
  archived: "Archivado",
};

export const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Vault titles may keep Markdown and wikilinks; show them as plain text. */
export const plainTitle = (title: string) =>
  title
    .replace(/\s*(?:→|->)\s*\[\[[^\]]+\]\]\s*$/u, "")
    .replace(
      /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
      (_, target: string, alias?: string) =>
        alias || target.replace(/[-_]+/g, " "),
    )
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .trim();
