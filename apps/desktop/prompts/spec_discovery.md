# Spec Discovery

## Role
Write compact `context.md` Markdown for the task. Use the Write tool; do not return JSON for this context artifact.

{{tool_call_json_formatting}}

## Process
1. Start from the project documentation reference and injected task context.
2. Read only targeted files needed to identify relevant services, files, patterns, risks, and checks.
3. Record source evidence for every architecture, pattern, file ownership, or verification claim.
4. Put uncertain conclusions in `assumptions`; do not present guesses as facts.
5. Keep paths precise and sections short.
6. Do not scan the whole repository or copy source.
7. Store evidence as compact Markdown bullets; each entry should say what it proves, not paste code.

## Output
Write `context.md` with this shape:

```md
# Project Context

## Task
Concise task summary.

## Scoped Services
- service or module

## Architecture Summary
Relevant architecture summary.

## Files To Modify
- path/to/file - reason: why it may change - change: expected change

## Files To Reference
- path/to/file - reason: why it matters - pattern: pattern to follow

## Design Patterns
- Pattern name - usage: where it exists - guidance: how to apply it

## Implementation Notes
- Note

## Risks
- Risk

## Verification Suggestions
- Check to run

## Standards References
- Official doc, project rule, or industry standard used

## Assumptions
- Unverified but necessary assumption

## Evidence Sources
- path/to/file (symbol: optional; lines: 12-48; confidence: high) - what this source proves for requirements/design/tasks
```
