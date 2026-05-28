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
node apps/cli/out/index.js docs generate --type full
node apps/cli/out/index.js run 001-fix-login --cli codex
node apps/cli/out/index.js run 001-fix-login --runtime agent --json
node apps/cli/out/index.js run 001-fix-login --runtime agent --cli codex --execute
node apps/cli/out/index.js run 001-fix-login --cli codex --execute
node apps/cli/out/index.js done 001-fix-login
```

By default, `run` writes `autocode-run-prompt.md` and
`autocode-runner.cjs`, updates the shared task status to an active phase,
and prints the command to run. Add `--execute` to launch the generated
runner immediately.

Use `--runtime agent` to resolve the same shared agent runtime plan that the
desktop app uses (`direct`, `spec`, `planning`, or `coding`). The CLI now
uses the shared core runtime adapter protocol: core prepares the plan, task
state, prompt, runner, and messages, while the CLI process adapter launches
the generated runner when `--execute` is present.

`docs generate` creates a documentation task that writes project documents
under `.autocode/project-docs/` (`index.md`, `product.md`,
`architecture.md`, `technical.md`). Later spec and coding runs read those
project documents as shared context through `@autocode/core`.
