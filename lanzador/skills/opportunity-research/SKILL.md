---
name: opportunity-research
description: Úsala cuando se busquen oportunidades externas vigentes y sea necesario evaluar encaje sin automatizar envíos ni postulaciones.
---

# Búsqueda y filtrado de oportunidades

Evalúa oportunidades externas vigentes contra el perfil sintético o autorizado, preparando borradores inspeccionables sin ejecutar envíos ni postulaciones automáticas.

## Dependencias y alcance

- MCP requeridos: `secondbrain`, `web_search`.
- Operaciones mínimas: `vault.read`, `web.read`.
- Si `web_search` no está conectado ni probado, queda en `no_utilizable` con causa explícita.

## Procedimiento

1. Consulta el criterio del encargo y contexto autorizado con `brain_search` / `brain_read`.
2. Busca oportunidades vigentes en fuentes primarias verificadas con `web_search`, registrando fecha límite, fuente y requisitos reales.
3. Evalúa el encaje punto por punto señalando brechas y datos faltantes sin fabricarlos.
4. Entrega comparativa o borrador preparado para revisión; si el perfil y el ejecutor habilitan la preparación de efectos, prepara la acción para aprobación explícita antes de cualquier envío.

## Verificación y límites

- Ningún envío o postulación se ejecuta automáticamente desde esta skill.
- Comprueba que todas las URLs y fechas reportadas provengan de consultas realmente observadas.
