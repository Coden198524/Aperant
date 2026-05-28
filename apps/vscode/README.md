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
- Starts a task by using `@autocode/core` to write a shared run prompt,
  then launches the configured CLI in a VS Code terminal.
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
- `Autocode: Start Latest Task`
- `Autocode: Refresh Workspace`
- `Autocode: Open Latest Plan File`
- `Autocode: Reveal Latest Task Folder`

Created tasks are written under the active workspace's `.autocode/specs/`
directory by default. Change `autocode.projectDataDir` only when the project
uses a different project-relative data directory.

Task start uses `autocode.preferredCLI` and defaults to `claude-code`. The
extension creates a prompt file in the task directory and passes that file to
the selected CLI from the VS Code terminal. The generated runner writes
`autocode-run-result.json` and updates `implementation_plan.json` when the CLI
exits, so task status remains visible to other clients.
