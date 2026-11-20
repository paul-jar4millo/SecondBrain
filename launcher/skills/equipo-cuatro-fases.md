---
name: equipo-cuatro-fases
description: Coordina investigación, planificación, implementación y revisión con agentes de distintos motores.
---

# Equipo de cuatro fases

El líder decide la formación según el encargo y conserva la responsabilidad del resultado. Las agentes no tienen roles fijos: si el usuario dijo quién hace qué, respétalo; si no, elige el motor según lo que pida cada parte del trabajo. La secuencia es una guía, no una obligación: usa solo las fases necesarias y comunica dependencias claras.

1. Identifica el objetivo, el proyecto y los criterios de aceptación. Lee las instrucciones del proyecto.
2. Usa `equipo_encargar` para asignar un brief autocontenido a otro motor. Solicita evidencia, archivos afectados y límites de la revisión. No incluyas secretos.
3. Usa `equipo_mensaje` y `equipo_bandeja` para resolver dudas; `equipo_esperar` devuelve el resultado o un estado pendiente. Cada sesión puede pedir ayuda dentro de los límites del equipo.
4. Comparte resultados útiles con `equipo_entregar`. Integra y verifica el trabajo contra los criterios de aceptación; no afirmes que algo pasó sin evidencia.
5. Comunica al usuario qué quedó hecho, cómo se verificó y qué sigue pendiente. Las operaciones financieras de agentes requieren aprobación en la sala.

Los mensajes y entregables son contexto operativo del equipo. Guarda en el vault solo hechos o decisiones confirmados y pertinentes mediante las herramientas de SecondBrain, siguiendo sus reglas y revisión por hash.
