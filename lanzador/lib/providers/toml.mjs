// Minimal TOML reader for Codex configuration files.

const TOML_HEX4_RE = /^[0-9A-Fa-f]{4}$/;
const TOML_HEX8_RE = /^[0-9A-Fa-f]{8}$/;
const TOML_BARE_KEY_CH_RE = /^[A-Za-z0-9_-]$/;
const TOML_VALUE_CH_RE = /^[A-Za-z0-9_+.:TZtz-]$/;

/** @typedef {import("./toml-types.mjs").TomlTable} TomlTable */
/** @typedef {import("./toml-types.mjs").TomlValue} TomlValue */
/** @typedef {{ enabled: boolean }} CodexMcpEntry */

/** @param {unknown} tomlText */
function parseTomlDocument(tomlText) {
  if (typeof tomlText !== "string") {
    throw new Error("config.toml inválido");
  }
  const src = tomlText.startsWith("\uFEFF") ? tomlText.slice(1) : tomlText;
  const len = src.length;
  let pos = 0;

  /** @param {string} ch */
  const assertSafeCodeUnit = (ch) => {
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new Error("Carácter de control no válido en config.toml");
    }
  };

  const skipHorizontalWs = () => {
    while (pos < len && (src[pos] === " " || src[pos] === "\t")) pos++;
  };

  const skipCommentIfPresent = () => {
    if (pos < len && src[pos] === "#") {
      pos++;
      while (pos < len && src[pos] !== "\n" && src[pos] !== "\r") {
        assertSafeCodeUnit(src[pos]);
        pos++;
      }
    }
  };

  const skipWsAndNewlines = () => {
    while (pos < len) {
      const ch = src[pos];
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        pos++;
      } else if (ch === "#") {
        skipCommentIfPresent();
      } else {
        break;
      }
    }
  };

  const decodeEscape = () => {
    if (pos >= len) {
      throw new Error("Secuencia de escape TOML incompleta en config.toml");
    }
    const esc = src[pos++];
    switch (esc) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "f":
        return "\f";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "u": {
        const hex = src.slice(pos, pos + 4);
        if (!TOML_HEX4_RE.test(hex)) {
          throw new Error("Escape \\uXXXX TOML inválido en config.toml");
        }
        pos += 4;
        const cp = parseInt(hex, 16);
        if (cp >= 0xd800 && cp <= 0xdfff) {
          throw new Error("Punto de código Unicode surrogate inválido en TOML");
        }
        return String.fromCodePoint(cp);
      }
      case "U": {
        const hex = src.slice(pos, pos + 8);
        if (!TOML_HEX8_RE.test(hex)) {
          throw new Error("Escape \\UXXXXXXXX TOML inválido en config.toml");
        }
        pos += 8;
        const cp = parseInt(hex, 16);
        if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
          throw new Error("Punto de código Unicode fuera de rango en TOML");
        }
        return String.fromCodePoint(cp);
      }
      default:
        throw new Error(`Escape TOML no soportado "\\${esc}" en config.toml`);
    }
  };

  const readBasicString = () => {
    pos++; // consume '"'
    let out = "";
    while (pos < len) {
      const ch = src[pos];
      if (ch === '"') {
        pos++;
        return out;
      }
      if (ch === "\r" || ch === "\n") {
        throw new Error("Cadena TOML sin cierre en config.toml");
      }
      if (ch === "\\") {
        pos++;
        out += decodeEscape();
        continue;
      }
      assertSafeCodeUnit(ch);
      out += ch;
      pos++;
    }
    throw new Error("Cadena TOML sin cierre en config.toml");
  };

  const readMultilineBasicString = () => {
    pos += 3; // consume '"""'
    if (src.startsWith("\r\n", pos)) pos += 2;
    else if (src[pos] === "\n") pos++;
    let out = "";
    while (pos < len) {
      if (src.startsWith('"""', pos)) {
        let quotes = 0;
        while (pos + quotes < len && src[pos + quotes] === '"' && quotes < 5) {
          quotes++;
        }
        if (quotes >= 3) {
          const extra = quotes - 3;
          pos += quotes;
          return out + '"'.repeat(extra);
        }
      }
      const ch = src[pos];
      if (ch === "\\") {
        pos++;
        // Line-ending backslash trims trailing horizontal whitespace + newlines.
        let look = pos;
        while (look < len && (src[look] === " " || src[look] === "\t")) look++;
        if (look < len && (src[look] === "\r" || src[look] === "\n")) {
          pos = look;
          while (
            pos < len &&
            (src[pos] === " " ||
              src[pos] === "\t" ||
              src[pos] === "\r" ||
              src[pos] === "\n")
          ) {
            pos++;
          }
          continue;
        }
        out += decodeEscape();
        continue;
      }
      if (ch !== "\r" && ch !== "\n") {
        assertSafeCodeUnit(ch);
      }
      out += ch;
      pos++;
    }
    throw new Error("Cadena multilínea TOML sin cierre en config.toml");
  };

  const readLiteralString = () => {
    pos++; // consume "'"
    let out = "";
    while (pos < len) {
      const ch = src[pos];
      if (ch === "'") {
        pos++;
        return out;
      }
      if (ch === "\r" || ch === "\n") {
        throw new Error("Cadena literal TOML sin cierre en config.toml");
      }
      assertSafeCodeUnit(ch);
      out += ch;
      pos++;
    }
    throw new Error("Cadena literal TOML sin cierre en config.toml");
  };

  const readMultilineLiteralString = () => {
    pos += 3; // consume "'''"
    if (src.startsWith("\r\n", pos)) pos += 2;
    else if (src[pos] === "\n") pos++;
    let out = "";
    while (pos < len) {
      if (src.startsWith("'''", pos)) {
        let quotes = 0;
        while (pos + quotes < len && src[pos + quotes] === "'" && quotes < 5) {
          quotes++;
        }
        if (quotes >= 3) {
          pos += quotes;
          return out + "'".repeat(quotes - 3);
        }
      }
      const ch = src[pos];
      if (ch !== "\r" && ch !== "\n") {
        assertSafeCodeUnit(ch);
      }
      out += ch;
      pos++;
    }
    throw new Error("Cadena literal multilínea TOML sin cierre en config.toml");
  };

  const readKeySegment = () => {
    if (pos >= len) {
      throw new Error("Clave TOML vacía en config.toml");
    }
    if (src[pos] === '"') {
      if (src.startsWith('"""', pos)) {
        throw new Error("Clave TOML multilínea no válida en config.toml");
      }
      return readBasicString();
    }
    if (src[pos] === "'") {
      if (src.startsWith("'''", pos)) {
        throw new Error("Clave TOML multilínea no válida en config.toml");
      }
      return readLiteralString();
    }
    let token = "";
    while (pos < len && TOML_BARE_KEY_CH_RE.test(src[pos])) {
      token += src[pos++];
    }
    if (!token) {
      throw new Error("Clave TOML no soportada en config.toml");
    }
    return token;
  };

  const readKeyPath = () => {
    const parts = [];
    while (true) {
      skipHorizontalWs();
      parts.push(readKeySegment());
      skipHorizontalWs();
      if (pos < len && src[pos] === ".") {
        pos++;
        continue;
      }
      break;
    }
    return parts;
  };

  const INLINE_META = new WeakSet();
  const ARRAY_TABLE_META = new WeakSet();

  /** @returns {TomlTable} */
  const makeTable = (inline = false) => {
    const obj = Object.create(null);
    if (inline) INLINE_META.add(obj);
    return obj;
  };

  /**
   * @param {TomlTable} baseTable
   * @param {string[]} parts
   * @param {TomlValue} value
   */
  const setNestedValue = (baseTable, parts, value) => {
    let cur = baseTable;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      if (INLINE_META.has(cur) && i === 0) {
        // Inline tables cannot be re-opened later unless writing inside them cleanly.
      }
      let next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      if (next === undefined) {
        next = makeTable(false);
        Object.defineProperty(cur, seg, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      } else if (Array.isArray(next) && ARRAY_TABLE_META.has(next)) {
        next = /** @type {TomlTable[]} */ (next)[next.length - 1];
      } else if (!next || typeof next !== "object") {
        throw new Error("Conflicto de tipos de clave TOML en config.toml");
      }
      cur = /** @type {TomlTable} */ (next);
    }
    const leaf = parts[parts.length - 1];
    Object.defineProperty(cur, leaf, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };

  /**
   * @param {TomlTable} root
   * @param {string[]} parts
   * @param {boolean} isArrayTable
   * @returns {TomlTable}
   */
  const navigateTableHeader = (root, parts, isArrayTable) => {
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLast = i === parts.length - 1;
      const existing = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      if (isLast && isArrayTable) {
        if (existing === undefined) {
          /** @type {TomlTable[]} */
          const arr = [];
          ARRAY_TABLE_META.add(arr);
          const elem = makeTable(false);
          arr.push(elem);
          Object.defineProperty(cur, seg, {
            value: arr,
            enumerable: true,
            writable: true,
            configurable: true,
          });
          return elem;
        }
        if (!Array.isArray(existing) || !ARRAY_TABLE_META.has(existing)) {
          throw new Error("Conflicto de arreglo de tablas TOML en config.toml");
        }
        const elem = makeTable(false);
        existing.push(elem);
        return elem;
      }
      if (existing === undefined) {
        const next = makeTable(false);
        Object.defineProperty(cur, seg, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
        cur = next;
      } else if (Array.isArray(existing) && ARRAY_TABLE_META.has(existing)) {
        cur = /** @type {TomlTable[]} */ (existing)[existing.length - 1];
      } else if (
        existing &&
        typeof existing === "object" &&
        !INLINE_META.has(existing)
      ) {
        cur = /** @type {TomlTable} */ (existing);
      } else {
        throw new Error("Conflicto de tabla TOML en config.toml");
      }
    }
    return cur;
  };

  /** @returns {TomlValue[]} */
  const readArray = () => {
    pos++; // '['
    const arr = [];
    while (pos < len) {
      skipWsAndNewlines();
      if (pos < len && src[pos] === "]") {
        pos++;
        return arr;
      }
      arr.push(readValue());
      skipWsAndNewlines();
      if (pos < len && src[pos] === ",") {
        pos++;
        continue;
      }
      skipWsAndNewlines();
      if (pos < len && src[pos] === "]") {
        pos++;
        return arr;
      }
      throw new Error("Arreglo TOML mal formado o sin cierre en config.toml");
    }
    throw new Error("Arreglo TOML sin cierre en config.toml");
  };

  const readInlineTable = () => {
    pos++; // '{'
    const tbl = makeTable(true);
    let first = true;
    while (pos < len) {
      skipWsAndNewlines();
      if (pos < len && src[pos] === "}") {
        pos++;
        return tbl;
      }
      if (!first) {
        if (src[pos] !== ",") {
          throw new Error("Falta coma en tabla inline TOML de config.toml");
        }
        pos++;
        skipWsAndNewlines();
        if (pos < len && src[pos] === "}") {
          pos++;
          return tbl;
        }
      }
      first = false;
      const kp = readKeyPath();
      skipHorizontalWs();
      if (pos >= len || src[pos] !== "=") {
        throw new Error("Falta '=' en tabla inline TOML de config.toml");
      }
      pos++;
      skipHorizontalWs();
      const val = readValue();
      setNestedValue(tbl, kp, val);
    }
    throw new Error("Tabla inline TOML sin cierre en config.toml");
  };

  /** @returns {TomlValue} */
  function readValue() {
    skipHorizontalWs();
    if (pos >= len) {
      throw new Error("Valor TOML faltante en config.toml");
    }
    if (src.startsWith('"""', pos)) return readMultilineBasicString();
    if (src[pos] === '"') return readBasicString();
    if (src.startsWith("'''", pos)) return readMultilineLiteralString();
    if (src[pos] === "'") return readLiteralString();
    if (src[pos] === "[") return readArray();
    if (src[pos] === "{") return readInlineTable();

    let scalar = "";
    while (
      pos < len &&
      src[pos] !== " " &&
      src[pos] !== "\t" &&
      src[pos] !== "\r" &&
      src[pos] !== "\n" &&
      src[pos] !== "#" &&
      src[pos] !== "," &&
      src[pos] !== "]" &&
      src[pos] !== "}"
    ) {
      scalar += src[pos++];
    }
    // Support RFC 3339 timestamps with space separator before time/zone
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(scalar) &&
      pos + 2 < len &&
      src[pos] === " " &&
      /\d{2}:\d{2}/.test(src.slice(pos + 1, pos + 6))
    ) {
      scalar += src[pos++];
      while (
        pos < len &&
        !["\t", "\r", "\n", "#", ",", "]", "}", " "].includes(src[pos])
      ) {
        scalar += src[pos++];
      }
    }
    if (!scalar) {
      throw new Error("Valor TOML inesperado en config.toml");
    }
    if (scalar === "true") return true;
    if (scalar === "false") return false;
    for (const ch of scalar) {
      if (!TOML_VALUE_CH_RE.test(ch)) {
        throw new Error(
          `Valor escalar TOML no válido (${scalar}) en config.toml`,
        );
      }
    }
    return scalar;
  }

  const expectEndOfStatement = () => {
    skipHorizontalWs();
    skipCommentIfPresent();
    if (pos < len) {
      if (src[pos] === "\r") {
        pos++;
        if (pos < len && src[pos] === "\n") pos++;
      } else if (src[pos] === "\n") {
        pos++;
      } else {
        throw new Error(
          "Contenido inesperado al final de línea TOML en config.toml",
        );
      }
    }
  };

  const root = makeTable(false);
  let currentTable = root;

  while (pos < len) {
    skipWsAndNewlines();
    if (pos >= len) break;
    if (src[pos] === "[") {
      const isArray = src.startsWith("[[", pos);
      pos += isArray ? 2 : 1;
      const parts = readKeyPath();
      skipHorizontalWs();
      if (isArray) {
        if (!src.startsWith("]]", pos)) {
          throw new Error(
            "Cabecera de arreglo de tablas TOML sin cierre en config.toml",
          );
        }
        pos += 2;
        if (parts.length === 1 && parts[0] === "mcp_servers") {
          throw new Error(
            "Arreglo de tablas [[mcp_servers]] no verificable en Codex",
          );
        }
      } else {
        if (src[pos] !== "]") {
          throw new Error("Cabecera de tabla TOML sin cierre en config.toml");
        }
        pos++;
      }
      expectEndOfStatement();
      currentTable = navigateTableHeader(root, parts, isArray);
      continue;
    }

    const kp = readKeyPath();
    skipHorizontalWs();
    if (pos >= len || src[pos] !== "=") {
      throw new Error("Asignación TOML inválida (falta '=') en config.toml");
    }
    pos++;
    const val = readValue();
    expectEndOfStatement();
    setNestedValue(currentTable, kp, val);
  }

  return root;
}

/**
 * @param {unknown} tomlText
 * @returns {Map<string, CodexMcpEntry>}
 */
export function parseCodexMcpServerEntries(tomlText) {
  const root = parseTomlDocument(tomlText);
  const section = root.mcp_servers;
  if (section === undefined) return new Map();
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(
      "Definición no verificable de mcp_servers en config.toml de Codex",
    );
  }
  const entries = new Map();
  for (const key of Object.keys(section)) {
    const val = section[key];
    if (!val || typeof val !== "object" || Array.isArray(val)) {
      throw new Error(
        `Definición no verificable de servidor MCP "${key}" en config.toml`,
      );
    }
    entries.set(key, { enabled: val.enabled !== false });
  }
  return entries;
}

/** @param {unknown} tomlText */
export function parseCodexMcpServerKeys(tomlText) {
  return new Set(parseCodexMcpServerEntries(tomlText).keys());
}
