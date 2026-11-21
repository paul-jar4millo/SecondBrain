# Product

SecondBrain lets one person organize projects, tasks, calendar and finances
from a personal space connected to their own Markdown knowledge base, and
delegate work to a small team of AI agents without giving up control.

## Experience

The entry point is a blue 3D loft with a game-like HUD. Tools open over the
scene and keep the user's position. **Projects** is the priority tool.
**Tasks** also collects unsorted ideas; plain notes do not appear in regular
navigation.

A sentence typed in the PromptBar (Create in the HUD) is parsed locally into a
reviewable action. **Finance** can upload screenshots to the briefcase and
prepare a thread for an agent; balances typed by the owner are saved
immediately and the thread only starts when sent. **Threads** is where agent
work happens: one thread is one task, on a repository (its own worktree and
branch) or in a scratch folder. No model runs until the first message is
sent. The owner can steer a running turn, answer questions inline, review the
diff and close the thread by pull request, local merge or discard. The inbox
collects everything that waits for the owner.

## Agents

Four base characters represent Claude, Codex, Antigravity and DeepSeek. The
launcher executes their CLIs outside the HTTP process. A thread can follow a
flow (for example Plan → Implement → Review): agents hand the thread to the
next stage, a second agent reviews read-only for at most three rounds, and
subtasks need the owner's approval. The refuge represents observed threads
and events. Copies of the same engine get different colors.

## Data and boundaries

The service writes the Markdown vault with hash revisions and no SQL mirror.
The vault has its own repository. The briefcase and threads are operational
state, not notes.

Finance privacy applies to figures and charts everywhere, including boards in
the 3D world. Without WebGL every tool stays usable. The "world" panel reads a
published video package; producing videos needs a separate engine.

Design: [DESIGN](DESIGN.md). Technical contracts:
[architecture](docs/architecture/README.md) and [MCP tools](docs/mcp-tools.md).
