# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

Auto Claude is an autonomous multi-agent coding framework that plans, builds, and validates software for you. It's a TypeScript-first Electron desktop application with a self-contained AI agent layer (Vercel AI SDK v6). A lightweight Python sidecar provides the optional Graphiti memory system.

> **Deep-dive reference:** [ARCHITECTURE.md](shared_docs/ARCHITECTURE.md) | **Frontend contributing:** [apps/desktop/CONTRIBUTING.md](apps/desktop/CONTRIBUTING.md)

## Product Overview

Auto Claude is a desktop application (+ CLI) where users describe a goal and AI agents autonomously handle planning, implementation, and QA validation. All work happens in isolated git worktrees so the main branch stays safe.

**Core workflow:** User creates a task → Spec creation pipeline assesses complexity and writes a specification → Planner agent breaks it into subtasks → Coder agent implements (can spawn parallel subagents) → QA reviewer validates → QA fixer resolves issues → User reviews and merges.

**Main features:**

- **Autonomous Tasks** — Multi-agent pipeline (planner, coder, QA) that builds features end-to-end
- **Kanban Board** — Visual task management from planning through completion
- **Agent Terminals** — Up to 12 parallel AI-powered terminals with task context injection
- **Insights** — AI chat interface for exploring and understanding your codebase
- **Roadmap** — AI-assisted feature planning with strategic roadmap generation
- **Ideation** — Discover improvements, performance issues, and security vulnerabilities
- **GitHub/GitLab Integration** — Import issues, AI-powered investigation, PR/MR review and creation
- **Changelog** — Generate release notes from completed tasks
- **Memory System** — Graphiti-based knowledge graph retains insights across sessions
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Flexible Authentication** — Use a Claude Code subscription (OAuth) or API profiles with any Anthropic-compatible endpoint (e.g., Anthropic API, z.ai for GLM models)
- **Multi-Account Swapping** — Register multiple Claude accounts; when one hits a rate limit, Auto Claude automatically switches to an available account
- **Cross-Platform** — Native desktop app for Windows, macOS, and Linux with auto-updates

## Critical Rules

**Vercel AI SDK only** — All AI interactions use the Vercel AI SDK v6 (`ai` package) via the TypeScript agent layer in `apps/desktop/src/main/ai/`. NEVER use `@anthropic-ai/sdk` or `anthropic.Anthropic()` directly. Use `createProvider()` from `ai/providers/factory.ts` and `streamText()`/`generateText()` from the `ai` package. Provider-specific adapters (e.g., `@ai-sdk/anthropic`, `@ai-sdk/openai`) are managed through the provider registry.

**i18n required** — All frontend user-facing text uses `react-i18next` translation keys. Hardcoded strings in JSX/TSX break localization for non-English users. Add keys to both `en/*.json` and `fr/*.json`.

**Platform abstraction** — Never use `process.platform` directly. Import from `apps/desktop/src/main/platform/`. CI tests all three platforms.

**No time estimates** — Provide priority-based ordering instead of duration predictions.

**PR target** — Always target the `develop` branch for PRs, not `main`. Main is reserved for releases.

**No console.log in production code** — `console.log` output is invisible in bundled Electron apps. Use Sentry for error tracking in production; reserve `console.log` for development only.

## Work Approach: Orchestrator-First

You are an orchestrator. Your primary role is to understand what needs to be done, break it into workstreams, and delegate execution to agent teams. This keeps your context window focused on coordination and decision-making rather than filling up with implementation details.

<orchestrator_pattern>
When given a task, follow this pattern:

1. **Investigate first** — Read the actual code before forming any hypothesis. Use targeted searches (Glob, Grep, Read) for simple lookups. For broader exploration, spawn an Explore agent.

2. **Plan the approach** — Identify what needs to change, which files are involved, and whether work can be parallelized. For multi-step tasks, create a task list to track workstreams.

3. **Delegate execution** — Spawn agent teams to do the implementation work. Each agent gets a clear, self-contained assignment with all the context it needs: relevant file paths, the specific change to make, and acceptance criteria. Run independent workstreams in parallel.

4. **Verify and integrate** — Review agent outputs, run tests, and ensure changes work together. Fix integration issues or spawn follow-up agents as needed.
</orchestrator_pattern>

**When to delegate vs. do directly:**
- Delegate: multi-file changes, research across the codebase, independent parallel workstreams, tasks that would consume significant context
- Do directly: single-file edits, simple bug fixes, quick lookups, tasks where you already have the context

**Giving agents good assignments** — Each agent works with a fresh context. Include: the specific goal, relevant file paths, code patterns to follow, and what "done" looks like. Agents perform better with explicit, complete instructions than with vague references to "the current task."

**Minimal changes only** — Prefer the simplest approach (e.g., prompt-only changes, single guard clause) before suggesting multi-component solutions. If the user asks for X, implement X — don't bundle additional fixes they didn't request.

**Default to action** — When the user's intent implies making changes, implement them rather than only suggesting. If something is unclear, read the relevant code to fill in the gaps rather than asking. Only ask when genuine ambiguity remains about what the user wants.

## Context Management

Your context window will be automatically compacted as it approaches its limit, allowing you to continue working indefinitely. Do not stop tasks early due to context concerns — instead, persist progress and keep going.

**For long-running tasks:** Use git commits, task lists, and structured notes to track state. When context compacts, review git log and any progress files to re-orient. Focus on incremental progress — complete one component before moving to the next, and commit working states along the way.

**Parallel tool calls** — When reading multiple files, running independent searches, or executing unrelated commands, make all calls in parallel rather than sequentially. This significantly speeds up investigation and implementation.

## Development Workflows

### Working on Frontend Components

1. **Start dev server**: `npm run dev` (runs from `apps/desktop/`)
2. **Edit component** in `src/renderer/`
3. **HMR applies changes** automatically (no refresh needed)
4. **Check i18n**: If adding UI text, add translation keys to `src/shared/i18n/locales/{en,fr}/*.json`
5. **Run tests**: `npm test` to verify changes don't break existing functionality
6. **Before commit**: `npm run lint:fix && npm run typecheck`

### Working on AI Agent Layer

1. **Edit agent code** in `src/main/ai/`
2. **Restart dev server**: Changes to main process require rebuild (Ctrl+C and `npm run dev` again)
3. **Check tool definitions**: Update Zod schemas in `src/main/ai/tools/` if modifying tool inputs
4. **Update prompts**: Agent behavior controlled by `.md` files in `apps/desktop/prompts/`
5. **Test orchestration**: Run `npm test` to verify agent pipeline logic

### Working on IPC Communication

1. **Main process handlers**: Edit `src/main/ipc-handlers/` modules
2. **Renderer calls**: Update `window.electronAPI.*` calls in `src/renderer/`
3. **Type safety**: Ensure handler signatures match preload exports in `src/preload/`
4. **Restart dev server**: IPC changes require main process restart
5. **Test E2E**: Run `npm run build && npm run test:e2e` to verify full integration

### Debugging

**Frontend (React/Renderer):**
- Inspect with DevTools: Press `Ctrl+Shift+I` in dev mode
- Use React DevTools browser extension (works in Electron)
- Check console for i18n missing key warnings

**Main Process:**
- Run with `npm run dev:debug` to enable verbose logging
- Check `~/.config/aperant/logs/` for production logs (platform-specific)
- Use `console.log` for dev-only debugging (not visible in bundled app)
- Use Sentry integration for production error tracking

**Agent Sessions:**
- Check `.auto-claude/specs/XXX-name/` for spec output and logs
- Review `src/main/ai/session/error-classifier.ts` for error handling patterns
- Monitor worker thread execution via `src/main/agent/worker-bridge.ts`

**Electron CDP (Chrome DevTools Protocol):**
- Start with `npm run dev:mcp` (enables remote debugging on port 9222)
- Use for E2E testing or AI-assisted QA validation
- MCP tools: `take_screenshot`, `click_by_text`, `fill_input`, `get_page_structure`

## Known Gotchas

**Electron path resolution** — For bug fixes in the Electron app, check path resolution differences between dev and production builds (`app.isPackaged`, `process.resourcesPath`). Paths that work in dev often break when Electron is bundled for production — verify both contexts. Use `app.getPath()` for system paths instead of hardcoding.

**Native dependencies** — `@lydell/node-pty` requires native compilation. Prebuilt binaries are downloaded automatically on install. If prebuilts aren't available for your Electron version, you'll need build tools (Visual Studio Build Tools on Windows, CMake on macOS/Linux). See [CONTRIBUTING.md](CONTRIBUTING.md#windows-users) for setup.

**Worker thread isolation** — Agent sessions run in worker threads to avoid blocking the main process. Be careful with Electron API access in workers — use `app.isPackaged` checks and avoid direct `electron.app` references. Worker crashes often stem from accessing main-process-only APIs.

**HMR limitations** — Hot Module Replacement works for renderer code, but main process and IPC changes require server restart. Watch for stale module state if changes don't appear.

**Memory system communication** — Graphiti (memory system) runs as a separate MCP sidecar process. Connection failures are silent; check logs at `.auto-claude/logs/mcp.log` if memory features don't work.

**i18n missing keys** — Dev mode logs warnings for missing translation keys. Ensure ALL new UI text is added to BOTH `en/*.json` and `fr/*.json` or the app won't render properly for French users.

### Resetting PR Review State

To fully clear all PR review data so reviews run fresh, delete/reset these three things in `.auto-claude/github/`:

1. `rm .auto-claude/github/pr/logs_*.json` — review log files
2. `rm .auto-claude/github/pr/review_*.json` — review result files
3. Reset `pr/index.json` to `{"reviews": [], "last_updated": null}`
4. Reset `bot_detection_state.json` to `{"reviewed_commits": {}}` — this is the gatekeeper; without clearing it, the bot detector skips already-seen commits

## Project Structure

```
autonomous-coding/
├── apps/
│   └── desktop/                 # Electron desktop application (sole app)
│       ├── prompts/             # Agent system prompts (.md)
│       └── src/
│           ├── main/            # Electron main process
│           │   ├── ai/          # TypeScript AI agent layer (Vercel AI SDK v6)
│           │   │   ├── providers/   # Multi-provider registry + factory (9+ providers)
│           │   │   ├── tools/       # Builtin tools (Read, Write, Edit, Bash, Glob, Grep, etc.)
│           │   │   ├── security/    # Bash validator, command parser, path containment
│           │   │   ├── config/      # Agent configs (25+ types), phase config, model resolution
│           │   │   ├── session/     # streamText() agent loop, error classification, progress
│           │   │   ├── agent/       # Worker thread executor + bridge
│           │   │   ├── orchestration/ # Build pipeline (planner → coder → QA)
│           │   │   ├── runners/     # Utility runners (insights, roadmap, PR review, etc.)
│           │   │   ├── mcp/         # MCP client integration
│           │   │   ├── client/      # Client factory convenience constructors
│           │   │   └── auth/        # Token resolution (reuses claude-profile/)
│           │   ├── agent/       # Agent queue, process, state, events
│           │   ├── claude-profile/ # Multi-profile credentials, token refresh, usage
│           │   ├── terminal/    # PTY daemon, lifecycle, Claude integration
│           │   ├── platform/    # Cross-platform abstraction
│           │   ├── ipc-handlers/# 40+ handler modules by domain
│           │   ├── services/    # Session recovery, profile service
│           │   └── changelog/   # Changelog generation and formatting
│           ├── preload/         # Electron preload scripts (electronAPI bridge)
│           ├── renderer/        # React UI
│           │   ├── components/  # UI components (onboarding, settings, task, terminal, github, etc.)
│           │   ├── stores/      # 24+ Zustand state stores
│           │   ├── contexts/    # React contexts (ViewStateContext)
│           │   ├── hooks/       # Custom hooks (useIpc, useTerminal, etc.)
│           │   ├── styles/      # CSS / Tailwind styles
│           │   └── App.tsx      # Root component
│           ├── shared/          # Shared types, i18n, constants, utils
│           │   ├── i18n/locales/# en/*.json, fr/*.json
│           │   ├── constants/   # themes.ts, etc.
│           │   ├── types/       # 19+ type definition files
│           │   └── utils/       # ANSI sanitizer, shell escape, provider detection
│           └── types/           # TypeScript type definitions
├── guides/                      # Documentation
└── scripts/                     # Build and utility scripts
```

## Commands Quick Reference

### Setup & Installation
```bash
npm run install:all              # Install all dependencies from root
cd apps/desktop && npm install   # Install desktop app deps only (runs postinstall script)
```

**Note:** The postinstall script (`scripts/postinstall.cjs`) handles platform-specific setup for native dependencies.

### Development
```bash
npm run dev                      # Start dev server with hot reload (HMR)
npm run dev:debug               # Dev mode with verbose logging (DEBUG=true)
npm run dev:mcp                 # Dev mode with Electron remote debugging (port 9222)
npm run build                   # Build production assets
npm start                       # Build and run production
```

### Testing

```bash
# Unit & integration tests (Vitest)
cd apps/desktop
npm test                        # Run all tests once
npm run test:unit               # Unit tests only (excludes integration/E2E)
npm run test:integration        # Integration tests only
npm run test:watch              # Watch mode (re-run on file changes)
npm run test:coverage           # Coverage report

# E2E tests (Playwright)
npm run build                   # Must build first
npm run test:e2e                # Run Playwright E2E tests
```

### Code Quality
```bash
npm run lint                    # Run Biome linter
npm run lint:fix                # Auto-fix lint issues
npm run format                  # Format code with Biome
npm run typecheck               # TypeScript type checking
```

### Packaging & Distribution
```bash
npm run package                 # Package for current platform
npm run package:mac             # Package for macOS (all archs)
npm run package:win             # Package for Windows
npm run package:linux           # Package for Linux (AppImage, deb, flatpak)
npm run package:flatpak         # Linux Flatpak only
```

### Releases
```bash
node scripts/bump-version.js patch|minor|major  # Bump version
git push && gh pr create --base main             # PR to main triggers release
```

See [RELEASE.md](RELEASE.md) for full release process.

## AI Agent Layer (`apps/desktop/src/main/ai/`)

All AI agent logic lives in TypeScript using the Vercel AI SDK v6. This replaces the previous Python `claude-agent-sdk` integration.

### Architecture Overview

- **Provider Layer** (`providers/`) — Multi-provider support via `createProviderRegistry()`. Supports Anthropic, OpenAI, Google, Bedrock, Azure, Mistral, Groq, xAI, and Ollama. Provider-specific transforms handle thinking token normalization and prompt caching.
- **Session Runtime** (`session/`) — `runAgentSession()` uses `streamText()` with `stopWhen: stepCountIs(N)` for agentic tool-use loops. Includes error classification (429/401/400) and progress tracking.
- **Worker Threads** (`agent/`) — Agent sessions run in `worker_threads` to avoid blocking the Electron main process. The `WorkerBridge` relays `postMessage()` events to the existing `AgentManagerEvents` interface.
- **Build Orchestration** (`orchestration/`) — Full planner → coder → QA pipeline. Parallel subagent execution via `Promise.allSettled()`.
- **Tools** (`tools/`) — 8 builtin tools (Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch) defined with Zod schemas via AI SDK `tool()`.
- **Security** (`security/`) — Bash validator, command parser, and path containment ported from Python with identical allowlist behavior.
- **Config** (`config/`) — `AGENT_CONFIGS` registry (25+ agent types), phase-aware model resolution, thinking budgets.

### Key Patterns

```typescript
// Agent session using streamText()
import { streamText, stepCountIs } from 'ai';

const result = streamText({
  model: provider,
  system: systemPrompt,
  messages: conversationHistory,
  tools: toolRegistry.getToolsForAgent(agentType),
  stopWhen: stepCountIs(1000),
  onStepFinish: ({ toolCalls, text, usage }) => {
    progressTracker.update(toolCalls, text);
  },
});

// Tool definition with Zod schema
import { tool } from 'ai';
import { z } from 'zod';

const readTool = tool({
  description: 'Read a file from the filesystem',
  inputSchema: z.object({
    file_path: z.string(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  }),
  execute: async ({ file_path, offset, limit }) => { /* ... */ },
});
```

### Agent Prompts (`apps/desktop/prompts/`)

| Prompt | Purpose |
|--------|---------|
| planner.md | Implementation plan with subtasks |
| coder.md / coder_recovery.md | Subtask implementation / recovery |
| qa_reviewer.md / qa_fixer.md | Acceptance validation / issue fixes |
| spec_gatherer/researcher/writer/critic.md | Spec creation pipeline |
| complexity_assessor.md | AI-based complexity assessment |

### Spec Directory Structure

Each spec in `.auto-claude/specs/XXX-name/` contains: `spec.md`, `requirements.json`, `context.json`, `implementation_plan.json`, `qa_report.md`, `QA_FIX_REQUEST.md`

### Memory System (Graphiti)

Graph-based semantic memory accessed via a Python MCP sidecar (lives outside `apps/desktop/`). The AI layer connects to it via `createMCPClient` from `@ai-sdk/mcp`. Configured through the Electron app's onboarding/settings UI. See [ARCHITECTURE.md](shared_docs/ARCHITECTURE.md#memory-system) for details.

## Frontend Development

### Tech Stack

React 19, TypeScript (strict), Electron 40, Vercel AI SDK v6, Zustand 5, Tailwind CSS v4, Radix UI, xterm.js 6, Vite 7, Vitest 4, Biome 2, Motion (Framer Motion)

### Path Aliases (tsconfig.json)

| Alias | Maps to |
|-------|---------|
| `@/*` | `src/renderer/*` |
| `@shared/*` | `src/shared/*` |
| `@preload/*` | `src/preload/*` |
| `@features/*` | `src/renderer/features/*` |
| `@components/*` | `src/renderer/shared/components/*` |
| `@hooks/*` | `src/renderer/shared/hooks/*` |
| `@lib/*` | `src/renderer/shared/lib/*` |

### State Management (Zustand)

All state lives in `src/renderer/stores/`. Key stores:

- `project-store.ts` — Active project, project list
- `task-store.ts` — Tasks/specs management
- `terminal-store.ts` — Terminal sessions and state
- `settings-store.ts` — User preferences
- `github/issues-store.ts`, `github/pr-review-store.ts` — GitHub integration
- `insights-store.ts`, `roadmap-store.ts`, `kanban-settings-store.ts`

Main process also has stores: `src/main/project-store.ts`, `src/main/terminal-session-store.ts`

### Styling

- **Tailwind CSS v4** with `@tailwindcss/postcss` plugin
- **7 color themes** (Default, Dusk, Lime, Ocean, Retro, Neo + more) defined in `src/shared/constants/themes.ts`
- Each theme has light/dark mode variants via CSS custom properties
- Utility: `clsx` + `tailwind-merge` via `cn()` helper
- Component variants: `class-variance-authority` (CVA)

### IPC Communication

Main ↔ Renderer communication via Electron IPC:
- **Handlers:** `src/main/ipc-handlers/` — organized by domain (github, gitlab, ideation, context, etc.)
- **Preload:** `src/preload/` — exposes safe APIs to renderer
- Pattern: renderer calls via `window.electronAPI.*`, main handles in IPC handler modules

### Agent Management (`src/main/agent/`)

The frontend manages agent lifecycle end-to-end:
- **`agent-queue.ts`** — Queue routing, prioritization, spec number locking
- **`agent-process.ts`** — Spawns worker threads via `WorkerBridge` for agent execution
- **`agent-state.ts`** — Tracks running agent state and status
- **`agent-events.ts`** — Agent lifecycle events and state transitions (structured events from worker threads)

### Claude Profile System (`src/main/claude-profile/`)

Multi-profile credential management for switching between Claude accounts:
- **`credential-utils.ts`** — OS credential storage (Keychain/Windows Credential Manager)
- **`token-refresh.ts`** — OAuth token lifecycle and automatic refresh
- **`usage-monitor.ts`** — API usage tracking and rate limiting per profile
- **`profile-scorer.ts`** — Scores profiles by usage and availability

### Terminal System (`src/main/terminal/`)

Full PTY-based terminal integration:
- **`pty-daemon.ts`** / **`pty-manager.ts`** — Background PTY process management
- **`terminal-lifecycle.ts`** — Session creation, cleanup, event handling
- **`claude-integration-handler.ts`** — Claude SDK integration within terminals
- Renderer: xterm.js 6 with WebGL, fit, web-links, serialize addons. Store: `terminal-store.ts`

## Testing Strategy

### Test Organization

Tests live in `src/__tests__/` organized by type:

```
src/__tests__/
├── unit/              # Isolated component & utility tests
├── integration/       # Tests involving multiple modules
└── e2e/              # End-to-end Playwright tests (renderer + main process)
```

### Running Tests

```bash
# All tests
npm test

# Unit tests only (fast feedback loop)
npm run test:unit

# Integration tests
npm run test:integration

# Watch mode (re-run on file changes)
npm run test:watch

# Single test file
npm test -- path/to/test.ts

# Tests matching a pattern
npm test -- --grep "pattern"

# With coverage
npm run test:coverage
```

### Test Patterns

**Component Tests** — Use React Testing Library, test behavior not implementation:
```typescript
import { render, screen } from '@testing-library/react';

test('displays task name', () => {
  render(<TaskCard task={{ name: 'Build feature' }} />);
  expect(screen.getByText('Build feature')).toBeInTheDocument();
});
```

**Agent Logic Tests** — Mock Claude AI SDK `streamText()` and tool execution:
```typescript
import { streamText } from 'ai';

vi.mock('ai', () => ({
  streamText: vi.fn().mockResolvedValue({ text: '...' }),
}));
```

**IPC Tests** — Test handler functions directly without Electron:
```typescript
const result = await handleGetProjectInfo(projectPath);
expect(result).toEqual(expectedValue);
```

### Test Quality

- **Pre-commit checks** run via Husky; failing tests block commits
- **CI runs on all platforms** — tests must pass on Windows, macOS, and Linux
- **Coverage targets** — aim for >80% on critical paths (agent logic, IPC handlers, stores)
- **No flaky tests** — if tests fail randomly, investigate timing/async issues first
- **New features** should include tests before PR submission

## Code Quality

### Frontend
- **Linting:** Biome (`npm run lint` / `npm run lint:fix`)
- **Type checking:** `npm run typecheck` (strict mode)
- **Pre-commit:** Husky + lint-staged runs Biome on staged `.ts/.tsx/.js/.jsx/.json`
- **Testing:** Vitest + React Testing Library + jsdom


## Agent Configuration & Prompts

Agent behavior is controlled by two systems:

### 1. Agent Config Registry (`src/main/ai/config/agent-configs.ts`)

Defines 25+ agent types with:
- Model selection (thinking budget, context window)
- Tool availability
- System prompt file
- Step limits and timeout
- Temperature and sampling params

**Common agent types:**
- `spec_gatherer` — Collect requirements from user descriptions
- `complexity_assessor` — Evaluate task complexity
- `planner` — Break tasks into subtasks
- `coder` — Implement subtasks
- `qa_reviewer` — Validate implementation
- `qa_fixer` — Fix QA issues

**Adding a new agent:**
1. Create system prompt: `apps/desktop/prompts/your-agent.md`
2. Register in `AGENT_CONFIGS`: 
```typescript
const YOUR_AGENT: AgentConfig = {
  name: 'your_agent',
  model: models.claude.default,
  systemPrompt: 'your-agent.md',
  tools: ['read', 'write', 'bash'],
  stepLimit: 100,
};
```

### 2. System Prompts (`apps/desktop/prompts/`)

Markdown files that define agent behavior. Key patterns:
- **Use backtick examples** for showing code
- **Structure with headers** (## Overview, ## Tools, ## Output Format)
- **Include constraints** (file paths, scope limits)
- **End with clear success criteria**

**Critical prompts:**
- `planner.md` — Must output JSON subtasks in `[IMPLEMENTATION_PLAN]` block
- `coder.md` — Must track progress with `[PROGRESS: X/Y]` markers
- `qa_reviewer.md` — Must validate against acceptance criteria

**Prompt patterns to avoid:**
- Avoid asking agent to "think" (wastes tokens when thinking mode is off)
- Avoid ambiguous output formats (use structured JSON/YAML)
- Avoid mixing concerns (one prompt = one clear job)

## Store Management (Zustand)

Frontend state lives in `src/renderer/stores/`. Each store is a Zustand slice managing a single domain:

**Common patterns:**
```typescript
// Define store
interface TaskStore {
  tasks: Task[];
  activeTask: string | null;
  setActiveTask: (id: string) => void;
}

export const useTaskStore = create<TaskStore>((set) => ({
  tasks: [],
  activeTask: null,
  setActiveTask: (id) => set({ activeTask: id }),
}));

// Use in component
const { tasks, activeTask, setActiveTask } = useTaskStore();
```

**Store patterns:**
- Keep stores shallow — complex logic goes in IPC handlers
- Use separate stores per domain (don't combine unrelated state)
- Subscribe to IPC events for external updates (e.g., agent progress)
- Clear store on project change to avoid stale data

**Main process stores** — Also use Zustand in `src/main/project-store.ts` and `src/main/terminal-session-store.ts` for persistent state.

## Spec System Architecture

Specs are the record of work. Each spec in `.auto-claude/specs/XXX-task-name/` is immutable once complete:

```
.auto-claude/specs/001-build-calculator/
├── spec.md                  ← User requirements (input)
├── requirements.json        ← Parsed requirements
├── context.json            ← Project context snapshot
├── implementation_plan.json ← Planner output (subtasks)
├── qa_report.md            ← QA validation results
└── QA_FIX_REQUEST.md       ← Issues to fix (if QA fails)
```

**Spec lifecycle:**
1. **Creation** — User provides task → spec_gatherer writes `spec.md`
2. **Planning** — planner writes `implementation_plan.json`
3. **Coding** — coder implements subtasks, stores progress
4. **QA** — qa_reviewer writes `qa_report.md`
5. **Fixes** — If issues found, qa_fixer writes `QA_FIX_REQUEST.md`
6. **Archive** — Completed spec is read-only

**Accessing spec data:**
```typescript
// Load spec
const specPath = join(projectDir, '.auto-claude/specs/001-task-name');
const spec = JSON.parse(readFileSync(join(specPath, 'spec.json'), 'utf8'));
const plan = JSON.parse(readFileSync(join(specPath, 'implementation_plan.json'), 'utf8'));
```

## Provider System

Multi-provider support via `@ai-sdk/*` adapters. Providers configured through settings UI or `.env`.

**Supported providers:**
- Anthropic (Claude 3.5 Sonnet, Claude 4)
- OpenAI (GPT-4, o1)
- Google (Gemini)
- AWS Bedrock
- Azure OpenAI
- Groq, Mistral, xAI, Ollama
- OpenRouter (meta-provider)

**Provider resolution** (`src/main/ai/providers/factory.ts`):
1. Check Claude Code OAuth token (default)
2. Fall back to API profiles from `src/main/claude-profile/`
3. Rate limit? Auto-swap to next available profile
4. Match model family (Claude → Anthropic, GPT → OpenAI)

**Using a provider in agent code:**
```typescript
const provider = createProvider('claude'); // or 'gpt-4', 'gemini', etc.
const result = await streamText({
  model: provider,
  system: prompt,
  messages: history,
  tools: toolRegistry.getToolsForAgent('coder'),
});
```

## Orchestration Pipeline

Full build flow in `src/main/ai/orchestration/build-orchestrator.ts`:

**Phases** (sequential):
1. **Spec Creation** — Gather user input, assess complexity
2. **Planning** — Break into subtasks
3. **Coding** — Implement all subtasks (batch or serial)
4. **QA** — Validate implementation
5. **QA Fix** — Resolve issues if found
6. **Merge** — Integrate back to main branch

**Batch vs. Serial Execution:**
- **Batch mode** (default): Group independent subtasks, process in 2-4 batches (max 4 per batch)
- **Serial mode** (fallback): Execute subtasks one-by-one if conflicts detected
- **Conflict detection** (`orchestration/conflict-detector.ts`): Analyzes `filesToModify` and `filesToCreate` to identify subtasks that touch the same files

**Progress tracking** — Events emitted:
- `orchestration-phase-update` — Phase changed
- `execution-state-update` — Subtask completed
- `orchestration-complete` — Build finished

**Token usage tracking** — Each agent session has a `sessionId` for accurate token counting across continuation calls. The `stepsExecuted` counter persists through `addUsage()` calls to track multi-turn conversations.

## i18n Guidelines

All frontend UI text uses `react-i18next`. Translation files: `apps/desktop/src/shared/i18n/locales/{en,fr}/*.json`

**Namespaces:** `common`, `navigation`, `settings`, `dialogs`, `tasks`, `errors`, `onboarding`, `welcome`

```tsx
import { useTranslation } from 'react-i18next';
const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.githubPRs')}</span>     // CORRECT
<span>GitHub PRs</span>                             // WRONG

// With interpolation:
<span>{t('errors:task.parseError', { error })}</span>
```

When adding new UI text: add keys to ALL language files, use `namespace:section.key` format.

## Cross-Platform

Supports Windows, macOS, Linux. CI tests all three.

**Platform modules:** `apps/desktop/src/main/platform/`

| Function | Purpose |
|----------|---------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection |
| `getPathDelimiter()` | `;` (Win) or `:` (Unix) |
| `findExecutable(name)` | Cross-platform executable lookup |
| `requiresShell(command)` | `.cmd/.bat` shell detection (Win) |

Use `findExecutable()` and `joinPaths()` instead of hardcoded paths. See [ARCHITECTURE.md](shared_docs/ARCHITECTURE.md#cross-platform-development) for extended guide.

## E2E Testing (Electron MCP)

QA agents can interact with the running Electron app via Chrome DevTools Protocol:

1. Start app: `npm run dev:debug` (debug mode for AI self-validation via Electron MCP)
2. Enable Electron MCP in settings
3. QA runs automatically through the TypeScript agent pipeline

Tools: `take_screenshot`, `click_by_text`, `fill_input`, `get_page_structure`, `send_keyboard_shortcut`, `eval`. See [ARCHITECTURE.md](shared_docs/ARCHITECTURE.md#end-to-end-testing) for full capabilities.

## Running the Application

```bash
# Desktop app
npm start          # Production build + run
npm run dev        # Development mode with HMR
npm run dev:debug  # Debug mode with verbose output
npm run dev:mcp    # Electron MCP server for AI debugging

# Project data: .auto-claude/specs/ (gitignored)
```
