---
name: integration-builder
description: Úsala cuando el encargo implique evaluar, probar en entorno aislado o proponer la activación de un nuevo conector o herramienta.
---

# Diseño y prueba aislada de integraciones

Evalúa alternativas, dependencias y costo de una integración en entorno sintético aislado antes de proponer su activación al propietario.

## Dependencias y alcance

- MCP requeridos: `secondbrain`, `git_workspace`.
- Operaciones mínimas: `connector.probe`, `shell.test`.
- Disponible exclusivamente en el perfil `integracion`.

## Procedimiento

1. Inventaria el contrato oficial de la herramienta/MCP (transporte, scopes mínimos requeridos, autenticación, licencia y política de costo R14).
2. Evalúa si una herramienta nativa o CLI existente cubre la necesidad sin ampliar la superficie MCP.
3. Implementa y valida pruebas negativas y de contrato usando fixtures temporales o servidores HTTP sintéticos locales; nunca conectes cuentas reales ni gastes saldo facturado sin autorización explícita.
4. Verifica aislamiento de credenciales (sin tokens globales ni secretos heredados en el entorno de la agente).
5. Redacta la propuesta de activación detallando pruebas pasadas, rutas no controlables y condiciones de reversión.

## Verificación y límites

- Prohibido declarar conectada o probada una integración cuya prueba solo usó mocks o credenciales ausentes.
- Toda ruta de escritura externa sin control real permanece en preparación manual o `no_disponible`.
