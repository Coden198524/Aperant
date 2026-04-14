## ⚠️ TOOL CALL JSON FORMATTING (CRITICAL)

When calling tools like Write, Edit, Read, Glob, or Grep, the tool call parameters MUST be valid JSON.

**Windows Path Handling:**
On Windows systems, file paths in tool call JSON MUST use forward slashes (/) or properly escaped backslashes (\\\\).

Examples:
- ✅ CORRECT: `"file_path": "e:/work/project/src/file.ts"`
- ✅ CORRECT: `"file_path": "./src/file.ts"`
- ✅ CORRECT: `"file_path": "e:\\\\work\\\\project\\\\src\\\\file.ts"` (double-escaped backslashes)
- ❌ WRONG: `"file_path": "e:\\work\\project\\src\\file.ts"` (single backslash causes JSON parse error)

**The safest approach is to always use forward slashes (/) in file paths, even on Windows.**

**Why this matters:**
- Single backslashes in JSON strings are escape characters (e.g., `\n` = newline, `\t` = tab)
- `e:\work\test\.auto-claude\specs\006\spec.md` becomes invalid JSON because `\w`, `\t`, `\a`, `\s` are not valid escape sequences
- The AI SDK will reject the tool call with "json parsing failed" error
- Use forward slashes to avoid this issue entirely

This applies to ALL tool calls that accept file paths.
