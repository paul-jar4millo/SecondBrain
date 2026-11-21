/** Marker created by the host migration and read by every subsequent deploy. */
export const HOST_LAYOUT_MARKER = "/etc/secondbrain/english-layout";

export const HOST_DATA_PATHS = /** @type {const} */ ([
  ["/var/lib/sb-agente/estado/lanzador", "/var/lib/sb-agent/state/launcher"],
  ["/srv/sb-agente/proyectos", "/srv/sb-agent/projects"],
  ["/srv/sb-agente/entregables", "/srv/sb-agent/deliverables"],
]);

export const HOST_UNITS = /** @type {const} */ ([
  ["secondbrain-lanzador.service", "secondbrain-launcher.service"],
  ["resumen-matutino.service", "morning-summary.service"],
  ["resumen-matutino.timer", "morning-summary.timer"],
  ["secondbrain-aviso@.service", "secondbrain-notify@.service"],
]);

export const HOST_COMMANDS = /** @type {const} */ ([
  ["/usr/local/bin/prender-pc", "/usr/local/bin/pc-wake"],
  ["/usr/local/bin/estado-pc", "/usr/local/bin/pc-status"],
]);

/**
 * Maps only managed paths, leaving possible sibling names intact.
 * @param {string} value
 * @param {boolean} [reverse]
 */
export function remapHostPath(value, reverse = false) {
  for (const pair of HOST_DATA_PATHS) {
    const [from, to] = reverse ? [pair[1], pair[0]] : pair;
    if (value === from || value.startsWith(from + "/"))
      return to + value.slice(from.length);
  }
  return value;
}

/** @param {string} name */
export function hostUnitName(name) {
  return HOST_UNITS.find(([old]) => old === name)?.[1] ?? name;
}

const replacements = [
  ...HOST_DATA_PATHS,
  ...HOST_UNITS.filter(([name]) => !name.includes("@")),
  ["secondbrain-aviso@", "secondbrain-notify@"],
  ["SB_LANZADOR_", "SB_LAUNCHER_"],
  ["SB_PROYECTOS_FILE", "SB_PROJECTS_FILE"],
  ["SB_SKILL_RESUMEN", "SB_SKILL_SUMMARY"],
  [
    "/current/ops/lanzador/resumen-matutino.sh",
    "/current/ops/launcher/morning-summary.sh",
  ],
  ["/current/ops/aviso/enviar-aviso.sh", "/current/ops/aviso/send-notice.sh"],
];

/**
 * Transforms managed settings in systemd units and drop-ins. The account,
 * its login directory, and its UID-based isolation are intentionally stable.
 * @param {string} text
 * @param {boolean} [reverse]
 */
export function hostUnitText(text, reverse = false) {
  for (const [old, next] of replacements)
    text = reverse ? text.replaceAll(next, old) : text.replaceAll(old, next);
  const legacy = "ReadWritePaths=/srv/sb-agente /var/lib/sb-agente";
  const canonical =
    "ReadWritePaths=/srv/sb-agent /var/lib/sb-agente /var/lib/sb-agent";
  return reverse
    ? text.replaceAll(canonical, legacy)
    : text.replaceAll(legacy, canonical);
}
