# Tool Call JSON

When calling tools, pass valid JSON parameters.

Use this shape:

```json
{
  "file_path": "path/to/file",
  "content": "text"
}
```

Rules:
- Use double quotes for JSON keys and strings.
- Escape backslashes in Windows paths or use forward slashes.
- Escape newlines inside string values as `\n`.
- Keep large writes small enough that the tool call is not truncated.
- If a tool call fails due malformed JSON, retry with a smaller valid payload.
