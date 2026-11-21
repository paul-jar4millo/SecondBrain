# SecondBrain

[English](README.md) · **Español**

**Un espacio de trabajo personal autohospedado donde tú y un equipo de agentes
de IA comparten una misma base de conocimiento.** Proyectos, tareas, agenda y
finanzas viven como Markdown en un vault versionado con Git; un "refugio" 3D es
la puerta de entrada; y agentes de Claude, Codex, Antigravity y DeepSeek
trabajan en tus repositorios en threads aislados, pidiendo tu aprobación antes
de cualquier acción con consecuencias reales.

**[Probar la demo →](https://paul-jar4millo.github.io/SecondBrain/?lang=es)**
(datos sintéticos, se ejecuta en el navegador)

![El refugio: loft low-poly con el equipo de agentes y el HUD](docs/assets/refuge.gif)

## Por qué

- **Tus datos siguen siendo archivos en tu propio hardware.** Markdown + YAML
  en un repositorio Git privado aparte, legible con cualquier editor u
  Obsidian. Todo corre en un contenedor autohospedado.
- **Los agentes reciben contexto, no tu disco.** Leen y escriben el vault solo
  mediante una API con permisos limitados, corren con un usuario Unix propio,
  límites de recursos y un firewall, y todo efecto externo espera tu
  aprobación.
- **El trabajo de un agente se revisa como el de un colega.** Cada tarea es un
  thread con su worktree y rama; lo rediriges, revisas el diff y lo cierras con
  pull request, merge local o descarte.

## Puntos clave

- **Un único escritor.** Cada escritura se valida por hash, se registra en
  journal y se versiona con Git.
- **Threads** con log de eventos en SQLite, streams reanudables, flujos
  Planificar → Implementar → Revisar, revisión cruzada y sub-tareas con
  aprobación.
- **Adaptadores propios** para Codex app-server, Claude Agent SDK y ACP.
- **PWA offline-first**, accesible sin WebGL, en español e inglés.
- **Entrega segura.** Despliegue solo desde tags de versión, con aprobación
  manual, verificación automática y rollback.

La arquitectura, las decisiones (ADRs) y el stack están en el
[README en inglés](README.md#architecture).

## Empezar

Requiere Node.js 24 y npm.

```sh
npm run setup
git config core.hooksPath .githooks
npm run dev            # http://127.0.0.1:5173/?demo=1
```

Instalación completa con agentes: [deployment](docs/deployment.md).

## Documentación

La documentación técnica está en inglés: [índice](docs/README.md),
[arquitectura](docs/architecture/README.md), [decisiones](docs/adr/README.md),
[roadmap](docs/roadmap.md), [API](docs/api.md),
[herramientas MCP](docs/mcp-tools.md), [despliegue](docs/deployment.md),
[operación](docs/operations.md) y [CI/CD](docs/ci-cd.md). La interfaz está en
español por defecto.

## Licencia

[MIT](LICENSE) © 2026 Paúl Jaramillo.
