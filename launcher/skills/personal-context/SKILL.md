---
name: personal-context
description: Úsala cuando un encargo o decisión personal necesite contexto vigente y verificado del vault antes de planificar o responder.
---

# Contexto personal verificado

Reúne contexto del vault remoto de SecondBrain sin copiar datos personales fuera del entorno autorizado ni inventar hechos ausentes.

## Dependencias y alcance

- MCP requerido: `secondbrain`.
- Operaciones mínimas: `vault.read`, `vault.search`.
- Compatible con los perfiles: `investigacion`, `ejecucion`, `coordinacion`, `integracion`.

## Procedimiento

1. Llama primero a `brain_context` para leer `AGENTS.md`, `Home.md`, `99-Meta/Convenciones.md` y el índice operativo.
2. Busca notas pertinentes con `brain_list` y `brain_search` usando términos acotados al encargo.
3. Lee completas con `brain_read` solo las notas necesarias y anota ruta exacta y `hash` vigente.
4. Revisa si alguna nota tiene fecha o propiedad `expires` vencida; señala explícitamente cualquier dato desactualizado o faltante.
5. Si el encargo necesita aclaración que no está en el vault, usa `usuario_preguntar` con opciones claras y texto libre habilitado.

## Verificación y límites

- Cita únicamente rutas leídas y hashes observados durante la sesión.
- No modifiques notas si el perfil activo solo concede lectura.
- Nunca incluyas secretos ni transcripciones completas en el resumen.
