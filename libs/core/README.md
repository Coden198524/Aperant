# @autocode/core

Headless agent core for Autocode. This package owns the parts of the
application that have no UI dependency: shared types, task file protocol,
workspace summaries, CLI runner planning, and future agent runtime
primitives. Desktop, CLI, and editor frontends consume it instead of
duplicating those rules.

## Status

Work in progress. Code is being extracted from `apps/desktop/src/main/`
in stages. The current package is already consumed by desktop, CLI, and
VS Code for shared types and the `.autocode/specs` task protocol.

## Consumers

- `apps/desktop` - Electron desktop application.
- `apps/cli` - headless command-line frontend.
- `apps/vscode` - VS Code extension.

## Current shared APIs

- Provider/model config types used by the desktop agent layer.
- Workspace summary detection for frontend status surfaces.
- Shared `.autocode/specs/<task-id>/` task creation, listing, status,
  logs, and run prompt/runner generation.
- Shared command security primitives: command parsing, denylist checks,
  path containment, project security profiles, tool input validation, and
  secret scanning.
- Shared structured output schemas for implementation plans, QA signoff,
  PR/MR review, triage, insights, complexity assessment, and constrained
  AI SDK output objects.
- Shared project analysis APIs for stack detection, framework detection,
  project indexing, command registry lookup, and dynamic project security
  profiles.
- Shared auth/provider boundary types, provider environment mappings,
  provider-account parsing, and host adapter contracts for settings,
  OAuth token files, OAuth browser launching, and provider account lookup.
- Shared provider routing helpers for model-provider detection, Anthropic
  and OpenAI-compatible URL normalization, Codex/Responses API routing,
  no-SDK provider endpoint defaults, and provider model creation plans.
- Shared provider transform helpers for thinking config normalization, tool
  ID sanitization, prompt-cache thresholds, and cache breakpoint selection.
- Shared agent configuration and tool/MCP policy: agent types, default
  thinking levels, allowed tool names, MCP server name mapping, and
  required-server resolution.
- Shared tool policy primitives: tool permissions, execution defaults,
  file-path argument sanitization, read-only tool usage budgets, duplicate
  call detection, and write-path allowlist checks.
- Shared tool output truncation policy: size and line limits, preview
  generation, spillover hint text, and safe output filenames. Host runtimes
  still own writing spillover files.
- Shared search policy for Glob/Grep tools: ignored directories, glob result
  summaries, ripgrep argument construction, fallback match formatting, binary
  detection, portable path formatting, and grep output truncation. Host
  runtimes still own filesystem traversal and process execution.
- Shared Read tool policy: default line limits by workflow mode, large-file
  previews, line-number formatting, legacy text decoding, image/PDF response
  formatting, task log summaries, and portable path normalization. Host
  runtimes still own file handles, cache access, and security checks.
- Shared Write/Edit tool policy: file mutation path normalization, JSON
  content validation, write success formatting, exact replacement planning,
  edit error messages, occurrence counting, and replace-all semantics. Host
  runtimes still own directory creation, file reads/writes, cache invalidation,
  and security checks.
- Shared Bash tool policy: timeout clamping, output truncation, compiler error
  compaction, Windows fast-failure rules, denied/background messages, and
  execution result formatting. Host runtimes still own shell selection,
  process execution, abort handling, and command security hooks.
- Shared tool registry policy: builtin registration order, optional WebSearch
  registration, Autocode tool registration names, per-agent tool selection, and
  SpawnSubagent executor gating. Host runtimes still own concrete tool
  implementations and AI SDK binding.
- Platform adapter interfaces for host-specific workspace, terminal,
  notification, task execution, secrets, and git integrations.

## Architectural rules

- Pure TypeScript, no Electron, no DOM, no browser APIs. Anything that
  needs `electron`, `ipcMain`, `BrowserWindow`, or `window` must live in
  the consuming app instead.
- No filesystem assumptions beyond what the consumer injects. The caller
  passes in `cwd`, `projectDir`, etc. The core does not look up Electron's
  `userData` path or read OS keychains directly. Auth resolution accepts
  credentials the consumer provides.
- No process-management responsibilities. Worker threads, child processes,
  and Electron windows are owned by the consumer.
- All public API lives in `src/index.ts`. Internal modules stay un-exported.

## How consumers import

```ts
import { CORE_PACKAGE_VERSION } from '@autocode/core';
```

The package is workspace-linked via npm workspaces. The root
`package.json` declares `"workspaces": ["apps/*", "libs/*"]`.

## Migration plan

The extraction proceeds bottom-up by dependency depth: leaves first.
Each phase should be safe for all consumers before more desktop logic is
moved into core.

1. **Scaffold** - create the package, wire it as a dependency. Done.
2. **Provider types** - `ai/providers/types.ts` with `SupportedProvider`,
   `ProviderConfig`, `ModelResolution`, and `ProviderCapabilities`. Done.
3. **Config types** - model shorthands, thinking levels, phase config,
   model maps, and provider reasoning helpers. Done.
4. **Workspace/task protocol** - workspace summary, `.autocode/specs`
   task store, logs, and CLI runner planning. Done.
5. **Security primitives** - command parsing, path containment, denylist,
   secret scanning, and shell validation utilities. Done.
6. **Schema definitions** - structured output and validation schemas. Done.
7. **Project analysis** - stack detection, framework detection, command
   registry, and project indexing. Done.
8. **Shared model constants** - move pure pieces from
   `shared/constants/models.ts`.
9. **Auth/provider interface split** - shared resolver types, settings/env
   helpers, provider account queue parsing, and host adapter contracts. Done.
10. **Provider routing helpers** - pure model-provider detection,
    Anthropic/OpenAI endpoint normalization, and Responses/Codex routing.
    Done.
11. **Provider factory creation plans** - pure SDK adapter selection,
    fetch strategy selection, model invocation routing, and prompt-cache
    capability flags. Done.
12. **Provider transforms** - thinking config normalization, tool ID
    sanitization, prompt-cache thresholds, and cache breakpoint selection.
    Done.
13. **Agent/tool policy config** - agent configs, tool name constants,
    default thinking levels, and MCP server resolution. Done.
14. **Tool policy primitives** - permissions, execution defaults, path
    argument sanitization, read-only usage guards, duplicate call detection,
    and write-path allowlist checks. Done.
15. **Tool output truncation policy** - shared truncation limits, preview
    generation, spillover hint text, and output filename sanitization. Done.
16. **Glob/Grep search policy** - shared ignored directories, glob summary
    generation, ripgrep argument planning, fallback match formatting, binary
    detection, portable path formatting, and grep output truncation. Done.
17. **Read tool policy** - shared line limits, line-number formatting,
    large-file preview notes, legacy text decoding, image/PDF response
    formatting, task log summaries, and portable path normalization. Done.
18. **Write/Edit tool policy** - shared file mutation path normalization,
    JSON validation, write result formatting, exact edit planning, occurrence
    counting, edit validation errors, and replace-all semantics. Done.
19. **Bash tool policy** - shared timeout clamping, output truncation,
    compiler error compaction, Windows fast-failure rules,
    denied/background messages, and execution result formatting. Done.
20. **Tool registry policy** - shared builtin registration order, optional
    WebSearch registration, Autocode tool registration names, per-agent tool
    selection, and SpawnSubagent executor gating. Done.
21. **Provider registry adapters** - AI SDK provider constructors stay in
    consuming runtimes and translate shared core plans into concrete SDK
    instances.
22. **Auth resolver** - non-Electron resolver logic only. OS keychain reads
    stay in the consuming app and are injected.
23. **Builtin tools** - remaining host bindings
    construction.
24. **AI client factory** - shared client creation once dependencies are
    extracted.
25. **Session runtime** - runner, error classification, continuation, and
    stream handling.
26. **Utility runners** - commit messages, title generation, changelog,
    merge resolver, and similar leaf runners.
27. **Orchestration** - planner, coder, and QA pipeline where it is truly
    frontend-independent.

The desktop app keeps its IPC handlers, renderer, Electron bootstrap, PTY
management, OS keychain credential storage, and Sentry main-process hooks.
Those pieces are inherently Electron-specific.
