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

The extraction proceeds bottom-up by dependency depth — leaves first.
The earlier draft listed "utility runners" as Phase 2 but those runners
depend on `createSimpleClient`, which depends on auth/provider/config
modules; runners are not leaves. Each phase is a separate PR.

1. **Scaffold** — create the package, wire it as a dependency. *(done)*
2. **Provider types** — `ai/providers/types.ts` (zero imports, true
   leaf: `SupportedProvider`, `ProviderConfig`, `ModelResolution`,
   `ProviderCapabilities`). *(done)*
3. **Config types** — `ai/config/types.ts` (depends only on provider
   types): `ModelShorthand`, `ThinkingLevel`, `Phase`,
   `MODEL_ID_MAP`, `THINKING_BUDGET_MAP`, etc.
4. **Shared model constants** — `shared/constants/models.ts` if it
   contains no Electron deps; otherwise carve out the pure parts.
5. **Security primitives** — `ai/security/bash-validator`,
   `command-parser`, `path-containment`, `denylist`. Should be
   self-contained TS utilities.
6. **Provider registry + factory** — `ai/providers/factory.ts`,
   `registry.ts`, `transforms.ts`, individual adapters. Pulls in
   `@ai-sdk/*` packages from npm.
7. **Auth resolver** — `ai/auth/resolver.ts`, `types.ts`. The
   non-Electron parts only — anything that reads OS keychains stays
   in the desktop app and is injected via constructor.
8. **Schema definitions** — `ai/schema/*` (Zod schemas for
   implementation plans, QA reports, PR reviews, etc.).
9. **Builtin tools** — `ai/tools/builtin/*` (Read, Write, Edit, Bash,
   Glob, Grep, etc.) plus `tools/build-registry`.
10. **AI client factory** — `ai/client/factory.ts` (`createAgentClient`,
    `createSimpleClient`). Depends on all of the above.
11. **Session runtime** — `ai/session/runner.ts`, error classification,
    continuation, stream-handler.
12. **Utility runners** — `description-improver`, `title-generator`,
    `commit-message`, `merge-resolver` (now actually movable because
    their deps live in core).
13. **Orchestration** — planner / coder / QA pipeline if still needed
    in core; some of this may stay in the desktop app since it
    coordinates IPC events.

The desktop app keeps its IPC handlers, renderer, Electron bootstrap,
PTY management, OS keychain credential storage, and Sentry main-process
hooks. Those are inherently Electron-specific.
