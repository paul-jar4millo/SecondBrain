// Validation of MCP elicitation forms (requested schema and the user's answers).
import { ErrorLanzador } from "../../errores.mjs";

const SUPPORTED_FORM_FIELD_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
]);

const ALLOWED_ROOT_SCHEMA_KEYS = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
]);

const COMMON_FIELD_KEYS = new Set([
  "type",
  "title",
  "description",
  "default",
  "enum",
  "oneOf",
  "const",
]);

const TYPE_ALLOWED_FIELD_KEYS = {
  string: new Set(["minLength", "maxLength", "pattern", "format"]),
  number: new Set([
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ]),
  integer: new Set([
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
  ]),
  boolean: /** @type {Set<string>} */ (new Set([])),
  array: new Set(["items", "minItems", "maxItems", "uniqueItems"]),
};

/** @type {Set<unknown>} */
const SUPPORTED_STRING_FORMATS = new Set([
  "email",
  "uri",
  "uuid",
  "date",
  "date-time",
]);

/** @typedef {keyof typeof TYPE_ALLOWED_FIELD_KEYS} FormFieldType */
/**
 * @typedef {object} FormFieldSchema
 * @property {FormFieldType} [type]
 * @property {unknown} [const]
 * @property {unknown[]} [enum]
 * @property {{ const: unknown }[]} [oneOf]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {string} [pattern]
 * @property {string} [format]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [exclusiveMinimum]
 * @property {number} [exclusiveMaximum]
 * @property {number} [multipleOf]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {boolean} [uniqueItems]
 * @property {FormFieldSchema} [items]
 */

/**
 * @param {unknown} pattern
 * @param {string} key
 */
function compileSchemaPattern(pattern, key) {
  if (typeof pattern !== "string" || pattern.length > 512) {
    throw new ErrorLanzador(
      `Patrón regex inválido o excesivo en campo "${key}".`,
      400,
    );
  }
  try {
    return new RegExp(pattern, "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      throw new ErrorLanzador(`Patrón regex inválido en campo "${key}".`, 400);
    }
  }
}

/**
 * @param {string} key
 * @param {string} value
 * @param {string} format
 */
function validateStringFormat(key, value, format) {
  if (format === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser un email válido.`,
        400,
      );
    }
    return;
  }
  if (format === "uri") {
    try {
      const u = new URL(value);
      if (!u.protocol) throw new Error("missing scheme");
    } catch {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser una URI válida.`,
        400,
      );
    }
    return;
  }
  if (format === "uuid") {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value,
      )
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser un UUID válido.`,
        400,
      );
    }
    return;
  }
  if (format === "date") {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe tener formato YYYY-MM-DD.`,
        400,
      );
    }
    return;
  }
  if (format === "date-time") {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
        value,
      ) ||
      Number.isNaN(Date.parse(value))
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe tener formato ISO date-time válido.`,
        400,
      );
    }
  }
}

/** @param {number} num */
function decimalPlaces(num) {
  const s = String(num).toLowerCase();
  if (s.includes("e")) return 9;
  const idx = s.indexOf(".");
  return idx === -1 ? 0 : Math.min(9, s.length - idx - 1);
}

/**
 * @param {number} value
 * @param {number} divisor
 */
function isMultipleOf(value, divisor) {
  if (!Number.isFinite(value) || !Number.isFinite(divisor) || divisor <= 0) {
    return false;
  }
  if (Number.isInteger(value) && Number.isInteger(divisor)) {
    return value % divisor === 0;
  }
  const decimals = Math.max(decimalPlaces(value), decimalPlaces(divisor));
  if (decimals <= 8) {
    const scale = 10 ** decimals;
    const scaledValue = Math.round(value * scale);
    const scaledDivisor = Math.round(divisor * scale);
    if (
      scaledDivisor > 0 &&
      Math.abs(scaledValue - value * scale) < 1e-6 &&
      Math.abs(scaledDivisor - divisor * scale) < 1e-6
    ) {
      return scaledValue % scaledDivisor === 0;
    }
  }
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) < 1e-9;
}

/**
 * @param {string} key
 * @param {unknown} input
 */
function validateFormFieldSchema(key, input, depth = 0) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ErrorLanzador(
      `Esquema de campo de formulario inválido (${key}).`,
      400,
    );
  }
  const field = /** @type {Record<string, unknown>} */ (input);
  if (field.type !== undefined) {
    if (
      typeof field.type !== "string" ||
      !SUPPORTED_FORM_FIELD_TYPES.has(field.type)
    ) {
      throw new ErrorLanzador(
        `Tipo de campo de formulario no soportado en "${key}": ${String(field.type)}.`,
        400,
      );
    }
    if (depth > 0 && field.type === "array") {
      throw new ErrorLanzador(
        `Arreglos anidados no soportados en campo "${key}".`,
        400,
      );
    }
  } else if (
    field.enum === undefined &&
    field.oneOf === undefined &&
    !Object.hasOwn(field, "const")
  ) {
    throw new ErrorLanzador(
      `El campo "${key}" del formulario carece de tipo o catálogo admitido.`,
      400,
    );
  }

  const allowedForType = field.type
    ? TYPE_ALLOWED_FIELD_KEYS[/** @type {FormFieldType} */ (field.type)]
    : new Set();
  for (const propKey of Object.keys(field)) {
    if (!COMMON_FIELD_KEYS.has(propKey) && !allowedForType.has(propKey)) {
      throw new ErrorLanzador(
        `Keyword de esquema no soportado en campo "${key}": "${propKey}".`,
        400,
      );
    }
  }

  if (field.oneOf !== undefined) {
    if (
      !Array.isArray(field.oneOf) ||
      field.oneOf.length === 0 ||
      field.oneOf.some(
        (/** @type {unknown} */ opt) =>
          !opt ||
          typeof opt !== "object" ||
          Array.isArray(opt) ||
          !Object.hasOwn(opt, "const") ||
          Object.keys(opt).some(
            (ok) => !["const", "title", "description"].includes(ok),
          ),
      )
    ) {
      throw new ErrorLanzador(
        `Esquema oneOf no soportado en campo "${key}".`,
        400,
      );
    }
  }
  if (field.enum !== undefined && !Array.isArray(field.enum)) {
    throw new ErrorLanzador(`El enum de "${key}" debe ser un arreglo.`, 400);
  }

  if (field.type === "string") {
    if (
      field.minLength !== undefined &&
      (!Number.isInteger(field.minLength) ||
        /** @type {number} */ (field.minLength) < 0)
    ) {
      throw new ErrorLanzador(`minLength inválido en campo "${key}".`, 400);
    }
    if (
      field.maxLength !== undefined &&
      (!Number.isInteger(field.maxLength) ||
        /** @type {number} */ (field.maxLength) < 0)
    ) {
      throw new ErrorLanzador(`maxLength inválido en campo "${key}".`, 400);
    }
    if (field.pattern !== undefined) {
      compileSchemaPattern(field.pattern, key);
    }
    if (
      field.format !== undefined &&
      !SUPPORTED_STRING_FORMATS.has(field.format)
    ) {
      throw new ErrorLanzador(
        `Formato "${String(field.format)}" no soportado en campo "${key}".`,
        400,
      );
    }
  }

  if (field.type === "number" || field.type === "integer") {
    for (const bound of [
      "minimum",
      "maximum",
      "exclusiveMinimum",
      "exclusiveMaximum",
    ]) {
      if (
        field[bound] !== undefined &&
        (typeof field[bound] !== "number" || !Number.isFinite(field[bound]))
      ) {
        throw new ErrorLanzador(
          `Límite "${bound}" inválido en campo "${key}".`,
          400,
        );
      }
    }
    if (
      field.multipleOf !== undefined &&
      (typeof field.multipleOf !== "number" ||
        !Number.isFinite(field.multipleOf) ||
        field.multipleOf <= 0)
    ) {
      throw new ErrorLanzador(`multipleOf inválido en campo "${key}".`, 400);
    }
  }

  if (field.type === "array") {
    for (const bound of ["minItems", "maxItems"]) {
      if (
        field[bound] !== undefined &&
        (!Number.isInteger(field[bound]) ||
          /** @type {number} */ (field[bound]) < 0)
      ) {
        throw new ErrorLanzador(
          `Límite "${bound}" inválido en campo "${key}".`,
          400,
        );
      }
    }
    if (
      field.uniqueItems !== undefined &&
      typeof field.uniqueItems !== "boolean"
    ) {
      throw new ErrorLanzador(`uniqueItems inválido en campo "${key}".`, 400);
    }
    if (field.items !== undefined) {
      validateFormFieldSchema(`${key}[]`, field.items, depth + 1);
    }
  }
}

/** @param {unknown} input */
export function validateRequestedSchema(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ErrorLanzador("Esquema de formulario no soportado.", 400);
  }
  const requestedSchema = /** @type {Record<string, unknown>} */ (input);
  for (const key of Object.keys(requestedSchema)) {
    if (!ALLOWED_ROOT_SCHEMA_KEYS.has(key)) {
      throw new ErrorLanzador(
        `Keyword de esquema de formulario no soportado: "${key}".`,
        400,
      );
    }
  }
  if (requestedSchema.type !== undefined && requestedSchema.type !== "object") {
    throw new ErrorLanzador("Esquema de formulario no soportado.", 400);
  }
  if (
    requestedSchema.additionalProperties !== undefined &&
    typeof requestedSchema.additionalProperties !== "boolean"
  ) {
    throw new ErrorLanzador(
      "additionalProperties en esquema de formulario debe ser booleano.",
      400,
    );
  }
  const properties =
    requestedSchema.properties === undefined ? {} : requestedSchema.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    throw new ErrorLanzador(
      "Propiedades del esquema de formulario inválidas.",
      400,
    );
  }
  for (const [key, field] of Object.entries(properties)) {
    validateFormFieldSchema(key, field, 0);
  }
  const required = Array.isArray(requestedSchema.required)
    ? requestedSchema.required
    : [];
  if (
    requestedSchema.required !== undefined &&
    !Array.isArray(requestedSchema.required)
  ) {
    throw new ErrorLanzador("Lista `required` del formulario inválida.", 400);
  }
  for (const reqKey of required) {
    if (typeof reqKey !== "string" || !reqKey) {
      throw new ErrorLanzador("Nombre de campo requerido inválido.", 400);
    }
  }
  return {
    properties: /** @type {Record<string, FormFieldSchema>} */ (properties),
    required: /** @type {string[]} */ (required),
    schema: requestedSchema,
  };
}

/**
 * @param {string} key
 * @param {unknown} value
 * @param {FormFieldSchema} spec
 */
function validateScalarValue(key, value, spec) {
  if (Object.hasOwn(spec, "const") && value !== spec.const) {
    throw new ErrorLanzador(
      `El campo "${key}" debe coincidir con el valor fijo esperado.`,
      400,
    );
  }
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
    throw new ErrorLanzador(
      `El valor del campo "${key}" no pertenece a las opciones permitidas.`,
      400,
    );
  }
  if (Array.isArray(spec.oneOf)) {
    const allowed = spec.oneOf.map((o) => o.const);
    if (!allowed.includes(value)) {
      throw new ErrorLanzador(
        `El valor del campo "${key}" no coincide con las opciones declaradas.`,
        400,
      );
    }
  }
  if (!spec.type) return;
  if (spec.type === "string") {
    if (typeof value !== "string") {
      throw new ErrorLanzador(`El campo "${key}" debe ser texto.`, 400);
    }
    if (typeof spec.minLength === "number" && value.length < spec.minLength) {
      throw new ErrorLanzador(
        `El campo "${key}" es más corto que minLength=${spec.minLength}.`,
        400,
      );
    }
    if (typeof spec.maxLength === "number" && value.length > spec.maxLength) {
      throw new ErrorLanzador(
        `El campo "${key}" excede maxLength=${spec.maxLength}.`,
        400,
      );
    }
    if (typeof spec.pattern === "string") {
      const rx = compileSchemaPattern(spec.pattern, key);
      if (!rx.test(value)) {
        throw new ErrorLanzador(
          `El campo "${key}" no cumple el patrón requerido.`,
          400,
        );
      }
    }
    if (typeof spec.format === "string") {
      validateStringFormat(key, value, spec.format);
    }
    return;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") {
      throw new ErrorLanzador(`El campo "${key}" debe ser booleano.`, 400);
    }
    return;
  }
  if (spec.type === "integer" || spec.type === "number") {
    const ok =
      spec.type === "integer"
        ? Number.isInteger(value)
        : typeof value === "number" && Number.isFinite(value);
    if (!ok) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser ${spec.type === "integer" ? "entero" : "numérico"}.`,
        400,
      );
    }
    const number = /** @type {number} */ (value);
    if (typeof spec.minimum === "number" && number < spec.minimum) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser >= ${spec.minimum}.`,
        400,
      );
    }
    if (
      typeof spec.exclusiveMinimum === "number" &&
      number <= spec.exclusiveMinimum
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser > ${spec.exclusiveMinimum}.`,
        400,
      );
    }
    if (typeof spec.maximum === "number" && number > spec.maximum) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser <= ${spec.maximum}.`,
        400,
      );
    }
    if (
      typeof spec.exclusiveMaximum === "number" &&
      number >= spec.exclusiveMaximum
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser < ${spec.exclusiveMaximum}.`,
        400,
      );
    }
    if (
      typeof spec.multipleOf === "number" &&
      !isMultipleOf(number, spec.multipleOf)
    ) {
      throw new ErrorLanzador(
        `El campo "${key}" debe ser múltiplo de ${spec.multipleOf}.`,
        400,
      );
    }
    return;
  }
  if (spec.type === "array") {
    if (!Array.isArray(value)) {
      throw new ErrorLanzador(`El campo "${key}" debe ser una lista.`, 400);
    }
    if (typeof spec.minItems === "number" && value.length < spec.minItems) {
      throw new ErrorLanzador(
        `El campo "${key}" requiere al menos ${spec.minItems} elemento(s).`,
        400,
      );
    }
    if (typeof spec.maxItems === "number" && value.length > spec.maxItems) {
      throw new ErrorLanzador(
        `El campo "${key}" admite como máximo ${spec.maxItems} elemento(s).`,
        400,
      );
    }
    if (spec.uniqueItems) {
      const seen = new Set();
      for (const item of value) {
        const marker = `${typeof item}:${JSON.stringify(item)}`;
        if (seen.has(marker)) {
          throw new ErrorLanzador(
            `El campo "${key}" no admite elementos duplicados.`,
            400,
          );
        }
        seen.add(marker);
      }
    }
    if (spec.items) {
      value.forEach((item, idx) =>
        validateScalarValue(`${key}[${idx}]`, item, spec.items),
      );
    }
  }
}

/**
 * Validates elicitation form content strictly against requestedSchema.
 * Never fabricates defaults or `false` values for omitted fields.
 * @param {unknown} requestedSchema
 * @param {unknown} providedContent
 */
export function validateAndExtractElicitationContent(
  requestedSchema,
  providedContent,
  mode = "form",
) {
  if (mode && mode !== "form") {
    throw new ErrorLanzador(
      `Modo de elicitación no soportado: "${mode}". Solo se admite "form".`,
      400,
    );
  }
  if (requestedSchema === undefined || requestedSchema === null) {
    if (providedContent === undefined || providedContent === null) return {};
    if (typeof providedContent !== "object" || Array.isArray(providedContent)) {
      throw new ErrorLanzador(
        "El contenido del formulario debe ser un objeto.",
        400,
      );
    }
    return structuredClone(providedContent);
  }
  const { properties, required, schema } =
    validateRequestedSchema(requestedSchema);
  if (providedContent === undefined || providedContent === null) {
    if (required.length > 0) {
      throw new ErrorLanzador(
        `Faltan campos obligatorios en el formulario: ${required.join(", ")}.`,
        400,
      );
    }
    return {};
  }
  if (typeof providedContent !== "object" || Array.isArray(providedContent)) {
    throw new ErrorLanzador(
      "El contenido del formulario debe ser un objeto.",
      400,
    );
  }
  const content = /** @type {Record<string, unknown>} */ (providedContent);
  for (const reqKey of required) {
    if (
      !Object.hasOwn(content, reqKey) ||
      content[reqKey] === undefined ||
      content[reqKey] === null
    ) {
      throw new ErrorLanzador(
        `Falta campo obligatorio en el formulario: "${reqKey}".`,
        400,
      );
    }
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(content)) {
      if (!Object.hasOwn(properties, key)) {
        throw new ErrorLanzador(
          `Campo no permitido en el formulario: "${key}".`,
          400,
        );
      }
    }
  }
  for (const [key, val] of Object.entries(content)) {
    if (val === undefined) continue;
    if (val === null) {
      throw new ErrorLanzador(`El campo "${key}" no admite valor nulo.`, 400);
    }
    if (Object.hasOwn(properties, key)) {
      validateScalarValue(key, val, properties[key]);
    }
  }
  return structuredClone(providedContent);
}
