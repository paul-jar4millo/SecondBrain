/** @param {unknown} actividad */
export function inferirFase(actividad) {
  const texto = String(actividad || "").toLowerCase();
  if (/\b(test|tests|git|pytest|vitest|jest)\b/.test(texto)) return "revisar";
  if (/plan/.test(texto)) return "planificar";
  if (/search|fetch|read|grep|glob|web/.test(texto)) return "investigar";
  if (/edit|write|filechange|code/.test(texto)) return "programar";
  return null;
}
