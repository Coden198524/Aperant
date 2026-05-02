## ⚠️ TOOL CALL JSON FORMATTING (CRITICAL)

When calling tools like Write, Edit, Read, Glob, or Grep, the tool call parameters MUST be valid JSON.

Tool inputs must be JSON objects, not strings that contain JSON.
- Correct: `{"file_path": "e:/work/project/spec.md", "content": "..."}`
- Wrong: `"{\"file_path\": \"e:/work/project/spec.md\", \"content\": \"...\"}"`

### 1. Windows Path Handling

On Windows systems, file paths in tool call JSON MUST use forward slashes (/) or properly escaped backslashes (\\\\).

Examples:
- ✅ CORRECT: `"file_path": "e:/work/project/src/file.ts"`
- ✅ CORRECT: `"file_path": "./src/file.ts"`
- ✅ CORRECT: `"file_path": "e:\\\\work\\\\project\\\\src\\\\file.ts"` (double-escaped backslashes)
- ❌ WRONG: `"file_path": "e:\\work\\project\\src\\file.ts"` (single backslash causes JSON parse error)

**The safest approach is to always use forward slashes (/) in file paths, even on Windows.**

**Why this matters:**
- Single backslashes in JSON strings are escape characters (e.g., `\n` = newline, `\t` = tab)
- `e:\work\test\.autocode\specs\006\spec.md` becomes invalid JSON because `\w`, `\t`, `\a`, `\s` are not valid escape sequences
- The AI SDK will reject the tool call with "json parsing failed" error
- Use forward slashes to avoid this issue entirely

### 2. Content Size Limits for Write Tool

**CRITICAL**: The Write tool has output token limits. If your content is too large, the JSON will be truncated mid-generation, causing "json parsing failed" errors.

**Symptoms of content truncation:**
- Error: "json parsing failed: text: {\"file_path\": \"...\", \"content\": \"..." (incomplete JSON)
- Error: "json parsing failed: text: {\"file_path\": \".../spec.md\"" (the JSON stopped before `"content"`)
- The error shows the JSON was cut off before the closing `}`

**Solutions:**
1. **Keep content concise** - Aim for under 10,000 characters per Write call
2. **Summarize instead of copying** - Extract key points, not full documentation
3. **Limit code snippets** - 2-3 lines max, not entire files
4. **Use multiple smaller files** - Split large content into `part1.json`, `part2.json`, etc.
5. **Link to sources** - Use URLs instead of copying full content

**If you get "json parsing failed" on a Write tool call:**
- Do not repeat the same malformed call
- Retry with one valid JSON object that includes BOTH keys: `{"file_path":"e:/work/project/.autocode/specs/001/spec.md","content":"# ...\n..."}`
- If the error text stops immediately after `"file_path"`, your tool JSON omitted or truncated the `"content"` key
- Reduce the content size and try again
- For an existing `spec.md`, prefer Edit for targeted corrections instead of rewriting the whole file with Write
- For a missing `spec.md`, write a compact 20-60 line spec first; do not copy large context blocks, full source files, long code blocks, or large tables
- Consider splitting large outputs into multiple smaller writes only when the orchestrator explicitly allows those files

This applies to ALL tool calls that accept file paths or large content parameters.
