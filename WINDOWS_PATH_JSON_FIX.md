# Windows 路径 JSON 解析错误修复

## 问题描述

用户报告在使用 Aperant 时经常遇到以下错误：

```
Tool 'Write' failed: invalid input for tool write: json parsing failed
text: {"file_path": "e:\\work\\game\\testcodex\\test\\.auto-claude\\specs\\006-build-web-based-sudoku-game\\spec.md"
error message: expected ',' or '}' after property value in json at position 110
```

## 根本原因

AI 模型在生成工具调用时，Windows 路径中的反斜杠 (`\`) 没有正确转义。在 JSON 中，反斜杠是转义字符，必须写成 `\\` 才能表示字面反斜杠。

**错误示例：**
```json
{
  "file_path": "e:\work\project\src\file.ts"
}
```

**正确示例：**
```json
{
  "file_path": "e:/work/project/src/file.ts"
}
```
或
```json
{
  "file_path": "e:\\work\\project\\src\\file.ts"
}
```

## 解决方案

在所有会调用工具的 prompt 文件中添加明确的 JSON 格式指导，要求 AI 始终使用正斜杠 (`/`) 而不是反斜杠 (`\`)。

### 修改的文件

**Build 阶段 (Planning → Coding → QA):**
1. ✅ **apps/desktop/prompts/planner.md** - 规划阶段
2. ✅ **apps/desktop/prompts/coder.md** - 编码阶段
3. ✅ **apps/desktop/prompts/qa_reviewer.md** - QA 审查阶段
4. ✅ **apps/desktop/prompts/qa_fixer.md** - QA 修复阶段

**Spec 阶段 (需求收集 → 规格编写):**
5. ✅ **apps/desktop/prompts/spec_gatherer.md** - 需求收集阶段
6. ✅ **apps/desktop/prompts/spec_writer.md** - 规格编写阶段
7. ✅ **apps/desktop/prompts/spec_researcher.md** - 研究验证阶段
8. ✅ **apps/desktop/prompts/spec_critic.md** - 规格审查阶段
9. ✅ **apps/desktop/prompts/validation_fixer.md** - 验证修复阶段

**总计：9 个 prompt 文件已修改**

### 格式指导内容

所有 prompt 文件现在都包含以下关键指导：

```markdown
## ⚠️ CRITICAL: JSON FORMATTING FOR TOOL CALLS

**When calling ANY tool (Write, Read, Edit, etc.), you MUST use proper JSON formatting:**

1. **ALWAYS use forward slashes (/) in file paths**
   - ✅ CORRECT: `"file_path": "src/components/Button.tsx"`
   - ❌ WRONG: `"file_path": "src\\components\\Button.tsx"`

2. **NEVER use backslashes (\) in paths** - even on Windows
   - The system handles path conversion automatically
   - Backslashes cause JSON parsing errors
```

## 为什么这样做有效

1. **明确性**：在 prompt 的显著位置（开头）明确说明规则
2. **视觉强调**：使用 ⚠️ 符号和 "CRITICAL" 标记吸引注意
3. **具体示例**：提供正确和错误的对比示例
4. **简单规则**：统一使用正斜杠，避免复杂的转义规则
5. **系统支持**：Node.js 和 Windows 都支持正斜杠路径

## 验证

构建成功完成，所有修改已应用到应用程序中。

下次运行任务时，AI 模型将看到这些指导并生成正确格式的工具调用。

## 预期效果

- ✅ 消除 "json parsing failed" 错误
- ✅ 提高工具调用成功率
- ✅ 减少任务失败和重试
- ✅ 改善用户体验

## 后续监控

如果问题仍然出现，可能需要：
1. 在更多 prompt 文件中添加指导（如 spec_writer.md, coder_recovery.md 等）
2. 在工具层面添加路径自动转换逻辑
3. 在 AI SDK 层面添加 JSON 验证和修复
