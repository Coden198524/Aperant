# Multi-frontend refactor plan

Autocode is being split into host frontends and shared headless packages.
The goal is that PC/Electron, CLI, and VS Code can share task semantics,
security rules, project analysis, model/auth resolution, and eventually the
agent runtime without copying desktop-specific code.

## Completed slices

1. Core boundary guard:
   - `@autocode/core` has `npm run check:boundaries`.
   - The guard rejects Electron, IPC, BrowserWindow, PTY, safeStorage, and
     renderer communication references in core source.
   - Normal core builds no longer delete `dist`, so consumer typechecks keep
     resolving `@autocode/core` while a build refreshes files.

2. Security primitives:
   - Security implementation now lives under `libs/core/src/security`.
   - Desktop security modules are compatibility shims that re-export the core
     implementation through the old import paths.
   - Core smoke covers command parsing, denylist rejection, bash hook behavior,
     path containment, and secret scanning.

3. Schema extraction:
   - Pure Zod schemas and output schemas now live under
     `libs/core/src/schema`.
   - Desktop schema modules are compatibility shims for existing imports.
   - File read/write helpers remain in desktop for now:
     `plan-shards.ts`, `plan-compaction.ts`, and `structured-output.ts`.
   - `zod` is a direct core dependency.
   - Core smoke covers implementation plan coercion, QA signoff coercion,
     language validation, and output schema lookup.

4. Project analysis extraction:
   - Stack detection, framework detection, command registry, project security
     profiles, and project indexing now live under `libs/core/src/project`.
   - Desktop project analysis modules are compatibility shims for existing
     imports.
   - CLI `info --json` exposes `projectIndex`, and VS Code renders project
     type, service count, and source count from the shared index.
   - Core smoke covers stack/framework detection, project index generation,
     index file writing, and dynamic project security profile creation.

5. Auth/provider interface split:
   - Shared auth resolver types, provider environment/settings mappings,
     provider-account parsing, queue sorting, and Z.AI endpoint routing now
     live under `libs/core/src/auth`.
   - Core defines host adapter contracts for settings, provider accounts,
     OAuth token refresh, OAuth token files, and OAuth browser launching.
   - Desktop `ai/auth/types.ts` is a compatibility shim; Electron
     `app.getPath`, keychain token refresh, and OAuth fetch injection remain
     in desktop runtime code.
   - Core smoke covers environment auth, settings auth, no-auth providers,
     provider-account auth, queue sorting, and provider name mapping.

6. Provider factory boundary prep:
   - Pure provider routing helpers now live under `libs/core/src/providers`.
   - Core owns model-provider detection, Anthropic OAuth token detection,
     Anthropic/OpenAI-compatible URL normalization, OpenAI/Codex Responses API
     routing, OpenAI-compatible alternate URL construction, and Ollama/DeepSeek
     endpoint defaults.
   - Core also produces provider model creation plans: SDK adapter selection,
     fetch strategy, model invocation method, normalized endpoint options, and
     prompt-cache capability flags.
   - Desktop `providers/factory.ts` now translates those plans into AI SDK
     calls. `providers/openai-base-url.ts`, worker fallback logic, and provider
     queue error messaging reuse the shared helpers.
   - AI SDK provider constructors and fetch adapters remain in desktop for now.

7. Provider transforms:
   - Provider thinking config transforms, adaptive-model helpers, thinking
     level sanitization, tool ID normalization, and prompt-cache breakpoint
     helpers now live in `libs/core/src/providers/transforms.ts`.
   - Desktop `providers/transforms.ts` is a compatibility shim for existing
     imports.
   - Core smoke covers adaptive thinking kwargs, DeepSeek `xhigh` mapping,
     `xhigh` sanitization, OpenAI-compatible tool ID truncation, and Anthropic
     cache breakpoint selection.

8. Agent/tool policy config:
   - Agent configs, default thinking levels, shared tool name constants, MCP
     tool constants, MCP server name mapping, and required-server resolution now
     live in `libs/core/src/config/agent-configs.ts`.
   - Desktop `config/agent-configs.ts` is a compatibility shim.
   - Desktop `tools/registry.ts` now keeps only local tool registration/binding
     and delegates MCP settings resolution to core.
   - Core smoke covers coder tool policy, `direct_task` thinking, MCP name
     mapping, memory filtering, desktop-style browser-to-electron resolution,
     and per-agent MCP removal overrides.

9. Tool policy primitives:
   - Tool permissions, execution defaults, tool metadata, usage counters,
     file-path argument sanitization, read-only usage guards, duplicate call
     detection, and write-path allowlist checks now live under
     `libs/core/src/tools`.
   - Desktop `tools/types.ts` re-exports shared policy types while keeping
     desktop-only context fields such as security profile and file cache.
   - Desktop `Tool.define` still owns AI SDK `tool()` binding, security hooks,
     and output truncation, but delegates policy decisions to core.
   - Core smoke covers path sanitization, signature normalization, duplicate
     read-only guard messages, permissions/default execution options, and
     write-path denial messages.

10. Tool output truncation policy:
   - Truncation limits, preview generation, output filename sanitization, and
     spillover hint text now live in `libs/core/src/tools/truncation.ts`.
   - Desktop `tools/truncation.ts` keeps the host-specific responsibility of
     creating `.autocode/tool-output` and writing full spillover files.
   - Core smoke covers sanitized output names, line-limit truncation plans,
     successful spillover hints, and write-failure hints.
   - Desktop tests cover unchanged small output and large-output spillover file
     creation.

11. Glob/Grep search policy:
   - Shared ignored-directory rules, glob summary generation, ripgrep argument
     planning, fallback match formatting, binary detection, portable path
     formatting, and grep output truncation now live in
     `libs/core/src/tools/search.ts`.
   - Desktop `Glob` and `Grep` still own filesystem access, ripgrep process
     execution, minimatch fallback filtering, path containment, and host-level
     output spillover.
   - Core smoke covers ignored-path checks, glob summaries, ripgrep argument
     construction, fallback formatting, binary detection, type filtering, and
     grep output truncation.
   - Desktop Glob/Grep tests continue to cover tool behavior through the
     existing tool definitions.

12. Read tool policy:
   - Shared line limits, large-file preview notes, line-number formatting,
     legacy text decoding, image/PDF response formatting, task-log summaries,
     and portable path normalization now live in `libs/core/src/tools/read.ts`.
   - Desktop `Read` still owns path containment, file handles, cache lookup,
     mtime tracking, and reading bytes from disk.
   - Core smoke covers path normalization, media detection, line-limit
     selection, large-file notes, line-number output, task-log summaries, and
     media response formatting.
   - Desktop Read tests continue to cover cached reads, workflow line caps,
     large files, legacy decoding, active task-log summaries, image/PDF files,
     and path security.

## Next slices

13. Runtime package:
   - After security, schema, project, and auth boundaries are stable, move AI
     client creation, tools, session runner, and lightweight orchestration into
     a runtime layer.
   - Keep `@autocode/core` light; use a runtime subpath/package for heavy
     dependencies such as AI SDK providers and MCP clients.
   - Acceptance: CLI and VS Code can choose between file-protocol-only mode and
     full agent runtime mode.
