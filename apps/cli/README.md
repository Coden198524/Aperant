# Autocode CLI

Headless command-line frontend for Autocode. It uses the same
`@autocode/core` task files as the desktop app and VS Code extension:
`.autocode/specs/<task-id>/`.

## Development

From the repository root:

```bash
npm run build:cli
node apps/cli/out/index.js info
```

Useful commands:

```bash
node apps/cli/out/index.js info
node apps/cli/out/index.js tasks
node apps/cli/out/index.js create --title "Fix login" --description "Repair OAuth callback handling"
node apps/cli/out/index.js run 001-fix-login --cli codex
node apps/cli/out/index.js run 001-fix-login --runtime agent --json
node apps/cli/out/index.js run 001-fix-login --cli codex --execute
node apps/cli/out/index.js done 001-fix-login
```

By default, `run` writes `autocode-run-prompt.md` and
`autocode-runner.cjs`, updates the shared task status to an active phase,
and prints the command to run. Add `--execute` to launch the generated
runner immediately.

Use `--runtime agent` to resolve the same shared agent runtime plan that the
desktop app uses (`direct`, `spec`, `planning`, or `coding`). This currently
prints the adapter-ready plan for CLI integration work; full agent execution
still requires a host runtime adapter.
