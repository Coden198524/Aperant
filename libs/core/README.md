# @autocode/core

Headless agent core for Autocode. This package owns the parts of the
application that have no UI dependency — the AI agent layer, auth flow,
worktree management, and security primitives — so they can be shared
across multiple frontends.

## Status

🚧 **Work-in-progress** — being extracted from `apps/desktop/src/main/`
in stages. See git history on the `refactor/extract-core` branch for
the migration plan.

## Consumers

- `apps/desktop` — Electron application (production)
- `apps/vscode` — VS Code extension (planned, separate branch)

## Architectural rules

- **Pure TypeScript, no Electron, no DOM, no browser APIs.** Anything
  that needs `electron`, `ipcMain`, `BrowserWindow`, or `window` must
  live in the consuming app instead.
- **No filesystem assumptions beyond what the consumer injects.** The
  caller passes in `cwd`, `projectDir`, etc. The core does not look up
  Electron's `userData` path or read OS keychains directly — auth
  resolution accepts whatever credentials the consumer provides.
- **No process-management responsibilities.** Worker threads, child
  processes, and Electron windows are owned by the consumer.
- **All public API in `src/index.ts`.** Internal modules stay un-exported.

## How consumers import

```ts
import { CORE_PACKAGE_VERSION } from '@autocode/core';
```

The package is workspace-linked via npm workspaces (root `package.json`
declares `"workspaces": ["apps/*", "libs/*"]`). Run `npm install` from
the repo root to update the symlink after adding new exports.

## Migration plan

The extraction proceeds in phases (each phase = a separate PR):

1. **Scaffold** — create the package, wire it as a dependency. *(this commit)*
2. **Move utility runners** — `description-improver`, `title-generator`,
   `commit-message`, `merge-resolver`. These are small and self-contained.
3. **Move security primitives** — `bash-validator`, `command-parser`,
   path containment helpers.
4. **Move the AI client factory and provider registry** —
   `ai/client/factory.ts`, `ai/providers/*`, model resolution.
5. **Move the agent session runtime** — `ai/session/runner.ts`,
   `streamText` wrapper, error classification.
6. **Move builtin tools** — `ai/tools/builtin/*` (Read, Write, Edit,
   Bash, Glob, Grep, etc.).
7. **Move orchestration** — planner / coder / QA pipeline.
8. **Move auth and profile management** — what isn't Electron-specific.

The desktop app keeps its IPC handlers, renderer, Electron bootstrap,
PTY management, and OS keychain credential storage. Those are
inherently Electron-specific.
