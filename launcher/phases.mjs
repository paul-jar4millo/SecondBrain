/** @param {unknown} activity */
export function inferPhase(activity) {
  const text = String(activity || "").toLowerCase();
  if (/\b(test|tests|git|pytest|vitest|jest)\b/.test(text)) return "revisar";
  if (/plan/.test(text)) return "planificar";
  if (/search|fetch|read|grep|glob|web/.test(text)) return "investigar";
  if (/edit|write|filechange|code/.test(text)) return "programar";
  return null;
}
