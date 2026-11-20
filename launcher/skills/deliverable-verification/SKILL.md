---
name: deliverable-verification
description: Úsala antes de cerrar un encargo para comprobar criterios de aceptación contra archivos, artefactos y hashes realmente observados.
---

# Verificación de entregables

Comprueba la evidencia real de salida antes de afirmar que un criterio o prueba quedó completo.

## Dependencias y alcance

- MCP requerido: `secondbrain`.
- Operaciones mínimas: `file.read`.

## Procedimiento

1. Recupera los criterios de aceptación exactos del encargo y las rutas o artefactos generados en el workspace.
2. Lee directamente los archivos o salidas finales y verifica integridad, formato, completitud y correspondencia con lo pedido.
3. Para cada criterio, clasifica el resultado observado: cumplido con evidencia, fallido o no comprobable en este entorno.
4. Registra límites reales (por ejemplo, proveedores sin sesión, ausencia de conector externo o pruebas solo sintéticas).

## Verificación y límites

- Prohibido reportar «todo verificado» por inferencia o sin haber leído el archivo y la salida posterior al último cambio.
- No debilites aserciones ni ocultes casos omitidos o bloqueados.
