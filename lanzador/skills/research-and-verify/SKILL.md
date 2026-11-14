---
name: research-and-verify
description: Úsala cuando el encargo requiera investigar información externa o comparar opciones con fuentes primarias comprobables.
---

# Investigación y verificación de fuentes

Delimitación, consulta y contraste de evidencia externa combinada con el contexto del vault sin inventar citas ni estados completos.

## Dependencias y alcance

- MCP requeridos: `secondbrain`, `web_search`.
- Operaciones mínimas: `vault.read`, `web.read`.
- Si `web_search` no está conectado ni probado, esta skill no es utilizable automáticamente; solicita fuentes aportadas por el usuario o informa el límite exacto.

## Procedimiento

1. Delimita la pregunta concreta y confirma en el vault (`brain_search`, `brain_read`) qué criterios ya existen.
2. Consulta fuentes primarias mediante el conector `web_search` verificado; registra URL exacta, fecha de publicación y vigencia.
3. Contrasta afirmaciones contradictorias antes de sintetizar conclusiones.
4. Si una fuente no responde o falla la búsqueda, reporta explícitamente qué quedó sin comprobar.

## Verificación y límites

- Ninguna afirmación crítica debe presentarse sin fuente observada y fecha.
- No ejecutes efectos externos, envíos ni gastos en APIs facturadas durante la investigación.
