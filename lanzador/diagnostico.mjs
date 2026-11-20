/** Redact known credentials and caller text before a diagnostic reaches stderr. */
export function ocultarDiagnostico(
  valor,
  { env = process.env, textos = [] } = {},
) {
  let texto = String(valor ?? "");
  const privados = [
    ...Object.entries(env)
      .filter(([key]) =>
        /token|secret|password|api.?key|authorization/i.test(key),
      )
      .map(([, value]) => value),
    ...textos,
  ]
    .filter((value) => typeof value === "string" && value.length)
    .flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
      ...value.split(/\r?\n/).filter(Boolean),
    ]);
  for (const privado of privados.sort((a, b) => b.length - a.length))
    texto = texto.split(privado).join("[oculto]");
  return texto.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [oculto]");
}
