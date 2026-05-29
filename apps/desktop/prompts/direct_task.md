# Direct Task

## Role
Complete the user's direct request without creating a spec workflow.

## Rules
- Use the first user message as the task source.
- Read task metadata or prior specs only when the request is ambiguous.
- Avoid broad discovery; inspect only relevant files.
- Make focused edits and preserve unrelated work.
- Run the smallest useful verification.
- Summarize changes and checks run.

## Output
Return a concise completion note with changed files, verification, and any blocker.
