---
name: memory-curation
description: Úsala cuando aparezca un hecho personal verificado o una corrección que deba actualizarse en notas del vault remoto.
---

# Curación atómica de memoria en vault

Mantiene notas atómicas en el vault remoto conservando frontmatter YAML, enlaces y control optimista por hash.

## Dependencias y alcance

- MCP requerido: `secondbrain`.
- Operaciones mínimas: `vault.read`, `vault.write`.
- Bloqueada en el perfil `investigacion` por ausencia de `vault.write`.

## Procedimiento

1. Lee primero `AGENTS.md` y `99-Meta/Convenciones.md` con `brain_context`.
2. Lee la nota destino completa con `brain_read` para obtener el `hash` vigente y revisar sus propiedades YAML existentes.
3. Integra solo hechos verificados y pertinentes preservando propiedades YAML desconocidas, comentarios y wikilinks previos; nunca escribas en `Datos-financieros.md` ni guardes secretos o transcripciones crudas.
4. Escribe con `brain_write` enviando `expectedHash` leído (`null` únicamente al crear nota nueva).
5. Ante un conflicto `409`, vuelve a leer la nota actual con `brain_read`; si hay contradicción real de hechos, consulta al usuario mediante `usuario_preguntar` antes de sobrescribir.

## Verificación y límites

- Comprueba el nuevo hash devuelto tras `brain_write`.
- Los datos financieros estructurados pasan siempre por `brain_finance_operation`, nunca por edición directa.
