# Electron Validation Tools

Use Electron MCP tools when validating desktop UI behavior.

## Tools
- `mcp__electron__get_electron_window_info`
- `mcp__electron__take_screenshot`
- `mcp__electron__send_command_to_electron`
- `mcp__electron__read_electron_logs`

## Validate
- App window opens and the target view is reachable.
- UI changes are visible in a screenshot.
- Main, preload, and renderer logs do not show new errors.
- IPC or menu actions affected by the task work end to end.
- Layout is usable at relevant window sizes.

## QA Rule
For UI tasks, visual validation is required. If it cannot be run, mark QA failed or record the exact blocker.

## Report
Include screenshots/log findings, commands or actions used, and any remaining risk.
