import assert from "node:assert/strict";

import { test } from "node:test";

import {
  validateAndExtractElicitationContent,
  validateRequestedSchema,
} from "../provider-controllers.mjs";

test("regresión: validator aplica pattern, multipleOf, format, uniqueItems y rechaza keywords no soportados ANTES de pedir respuesta", () => {
  const patternSchema = {
    type: "object",
    properties: { x: { type: "string", pattern: "^SI$" } },
    required: ["x"],
  };
  assert.throws(
    () => validateAndExtractElicitationContent(patternSchema, { x: "NO" }),
    (e) => e.status === 400,
  );
  assert.deepEqual(
    validateAndExtractElicitationContent(patternSchema, { x: "SI" }),
    { x: "SI" },
  );

  const numSchema = {
    type: "object",
    properties: {
      paso: {
        type: "number",
        multipleOf: 0.1,
        exclusiveMinimum: 0,
        maximum: 1,
      },
      email: { type: "string", format: "email" },
      etiquetas: {
        type: "array",
        uniqueItems: true,
        items: { type: "string" },
      },
      opcional: { type: "boolean", default: false },
    },
    required: ["paso", "email"],
  };
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.35,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0,
        email: "a@b.co",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "invalido",
      }),
    (e) => e.status === 400,
  );
  assert.throws(
    () =>
      validateAndExtractElicitationContent(numSchema, {
        paso: 0.3,
        email: "a@b.co",
        etiquetas: ["a", "a"],
      }),
    (e) => e.status === 400,
  );
  const ok = validateAndExtractElicitationContent(numSchema, {
    paso: 0.3,
    email: "a@b.co",
    etiquetas: ["a", "b"],
  });
  assert.deepEqual(ok, { paso: 0.3, email: "a@b.co", etiquetas: ["a", "b"] });
  assert.equal(Object.hasOwn(ok, "opcional"), false);

  // Unsupported keywords rejected upfront in validateRequestedSchema (before asking user)
  for (const bad of [
    {
      type: "object",
      properties: { a: { type: "string" } },
      dependencies: { a: ["b"] },
    },
    { type: "object", properties: { a: { type: "string", customKeyword: 1 } } },
    {
      type: "object",
      properties: { a: { type: "string", format: "hostname" } },
    },
    {
      type: "object",
      properties: { a: { type: "string", pattern: "[invalido" } },
    },
    { type: "object", properties: { a: { type: "number", multipleOf: 0 } } },
  ]) {
    assert.throws(
      () => validateRequestedSchema(bad),
      (e) => e.status === 400,
    );
  }
});
