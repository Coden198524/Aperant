# Autocode VS Code Extension

This workspace hosts the VS Code frontend for Autocode. It runs in the
VS Code extension host and imports shared headless code from
`@autocode/core`.

## Current Scope

- Adds an Autocode Activity Bar container.
- Adds an `Autocode` sidebar webview.
- Shows workspace summary data from `@autocode/core`.
- Lists Autocode tasks from the project data directory.
- Creates tasks in the same `.autocode/specs/<task-id>/` file protocol used by the desktop app.
- Creates project documentation tasks that write shared context under
  `.autocode/project-docs/` for later spec and coding phases.
- Resolves the shared agent runtime start plan from `@autocode/core` before
  launching a task, so VS Code sees the same `direct` / `spec` / `planning` /
  `coding` decision as the desktop runtime adapter.
- Starts a task through the shared core runtime adapter protocol: core prepares
  the plan, task state, prompt, runner, and messages, while VS Code supplies
  the terminal and notification adapters.
- Opens the latest task plan file and reveals task folders from VS Code.

The VS Code frontend intentionally stays thin: rich desktop orchestration,
PTY management, and auth flows still live in `apps/desktop`, while shared
task files and run planning live in `@autocode/core`.

## Development

From the repository root:

```bash
npm run build:core
npm run build:vscode
```

For watch mode:

```bash
npm run dev:vscode
```

To run the extension, open `apps/vscode` in VS Code and start an Extension
Development Host. The extension entry is `out/extension.js`.

Useful commands in the Extension Development Host:

- `Autocode: Open Panel`
- `Autocode: Create Task`
- `Autocode: Generate Project Documentation`
- `Autocode: Start Latest Task`
- `Autocode: Refresh Workspace`
- `Autocode: Open Latest Plan File`
- `Autocode: Reveal Latest Task Folder`

Created tasks are written under the active workspace's `.autocode/specs/`
directory by default. Change `autocode.projectDataDir` only when the project
uses a different project-relative data directory.

Task start uses `autocode.preferredCLI` and defaults to `claude-code`. The
extension asks `@autocode/core` for a complete runtime start request, then
launches the generated runner in a VS Code terminal. The generated runner
writes `autocode-run-result.json` and updates `implementation_plan.md` when
the CLI exits, so task status remains visible to other clients.
