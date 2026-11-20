/**
 * Redact known credentials and caller text before a diagnostic reaches stderr.
 * @param {unknown} valor
 * @param {{ env?: NodeJS.ProcessEnv, textos?: string[] }} [options]
 */
export function redactDiagnostic(
  valor,
  { env = process.env, textos: texts = [] } = {},
) {
  let texto = String(valor ?? "");
  const privados = [
    ...Object.entries(env)
      .filter(([key]) =>
        /token|secret|password|api.?key|authorization/i.test(key),
      )
      .map(([, value]) => value),
    ...texts,
  ]
    .filter((value) => typeof value === "string")
    .filter(Boolean)
    .flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
      ...value.split(/\r?\n/).filter(Boolean),
    ]);
  for (const privado of privados.sort((a, b) => b.length - a.length))
    texto = texto.split(privado).join("[oculto]");
  return texto.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [oculto]");
}
