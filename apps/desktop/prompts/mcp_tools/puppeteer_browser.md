# Browser Validation Tools

Use Puppeteer MCP tools when validating web UI behavior.

## Tools
- `mcp__puppeteer__puppeteer_navigate`
- `mcp__puppeteer__puppeteer_screenshot`
- `mcp__puppeteer__puppeteer_click`
- `mcp__puppeteer__puppeteer_fill`
- `mcp__puppeteer__puppeteer_select`
- `mcp__puppeteer__puppeteer_hover`
- `mcp__puppeteer__puppeteer_evaluate`

## Validate
- Target page loads without console errors.
- Changed UI is visible and interactive.
- Main happy path works.
- Error, empty, loading, and disabled states work when relevant.
- Layout is usable on desktop and mobile widths when UI is responsive.

## QA Rule
For UI tasks, run a visual check. If no browser can be launched, mark QA failed or record the exact blocker.

## Report
Include the URL, interactions, screenshot result, console errors, and any remaining risk.
