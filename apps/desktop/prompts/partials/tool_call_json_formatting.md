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
- File format boundary: keep app-owned configuration tables/files, manifests, settings, state, app-parsed indexes, metadata, audit logs, and any app-parsed structured outputs as JSON/JSONL, even when the model creates, reads, or updates the content. This includes project/config files such as `package.json`, `tsconfig.json`, app settings, prompt profiles, and structured UI/runtime outputs. Do not convert JSON config/tables just because they are mentioned in prompts. Convert only pure prose/reference artifacts that are read as plain text by the model or user, such as context, research, outlines, and evidence notes, to Markdown.
