---
name: document-production
description: Úsala cuando el encargo pida redactar, estructurar o revisar documentos y artefactos editables dentro del workspace aislado.
---

# Producción e inspección de documentos

Genera y revisa entregables reproducibles dentro del directorio de trabajo aislado preservando originales y verificando el resultado byte a byte.

## Dependencias y alcance

- MCP requeridos: `secondbrain`, `git_workspace`.
- Operaciones mínimas: `file.read`, `file.write`.
- Requiere conector `git_workspace` configurado, conectado y probado; bloqueada en perfil `investigacion`.

## Procedimiento

1. Revisa archivos previos y convenciones en el workspace sin sobrescribir ni perder versiones existentes sin respaldo local o commit previo.
2. Redacta el documento en formato limpio, editable y claro dentro del directorio de proyecto asignado (nunca fuera de `cwd` ni en rutas sensibles `.env`/`.git`).
3. Verifica tamaño, codificación UTF-8, estructura de secciones, enlaces y contenido exacto releyendo el archivo escrito.
4. Resume el contenido generado junto con su ruta relativa y hash o verificación observada para publicar versión inmutable.

## Verificación y límites

- Nunca declares exportado o enviado un documento si falta el conector externo correspondiente; prepara la entrega para revisión del propietario.
- No incluyas credenciales, tokens ni notas personales reales como ejemplos sintéticos.
