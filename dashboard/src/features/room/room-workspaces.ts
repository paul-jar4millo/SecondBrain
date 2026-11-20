// Project contexts for assignments and reference boards in the shared refuge.

export const GENERAL = "general";

const FIJOS = [
  { id: GENERAL, titulo: "Sala general", detalle: "Sin proyecto" },
  {
    id: "mundo-hipotetico",
    titulo: "Mundo Hipotético",
    detalle: "Canal de videos",
  },
];

/** Lista de espacios a partir de los elementos del vault; los archivados van al final. */
export function espaciosDe(
  items: {
    id: string;
    kind: string;
    title: string;
    deleted?: boolean;
    area?: string;
    status?: string;
    vaultPath?: string;
  }[],
) {
  const proyectos = items
    .filter((x) => x.kind === "project" && !x.deleted)
    .map((x) => ({
      id: x.id,
      titulo: x.title,
      detalle: x.area || "Proyecto personal",
      archivado: ["archived", "done"].includes(x.status || ""),
    }))
    .sort(
      (a, b) =>
        Number(a.archivado) - Number(b.archivado) ||
        a.titulo.localeCompare(b.titulo, "es"),
    );
  const hasMundo = items.some(
    (x) =>
      x.kind === "project" &&
      !x.deleted &&
      x.vaultPath === "01-Proyectos/Proyecto-Mundo-Hipotetico.md",
  );
  return [
    ...FIJOS.filter((x) => x.id !== "mundo-hipotetico" || !hasMundo),
    ...proyectos,
  ];
}
