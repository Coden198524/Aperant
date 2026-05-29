# API Validation Tools

Use API checks when the task touches HTTP handlers, RPC, IPC, webhooks, clients, auth, or data contracts.

## Validate
- Endpoint or method accepts expected inputs.
- Success response shape matches the contract.
- Error cases return safe, expected status and body.
- Auth, permissions, validation, and rate limits still apply.
- Callers or generated clients are updated when contracts changed.

## Suggested Checks
- Targeted unit or integration tests.
- Existing API test command.
- Minimal curl/request smoke test when safe.
- Contract/schema/typecheck if available.

## Report
List checked routes or methods, commands run, response evidence, and remaining risks.
