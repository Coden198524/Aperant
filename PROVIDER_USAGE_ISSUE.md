# Provider不返回Usage的临时解决方案

## 问题
某些OpenAI兼容的provider（如你使用的gpt-5.4服务）不返回usage统计数据。

## 临时方案：基于文本长度估算

可以在 `runner.ts` 中添加fallback估算逻辑：

```typescript
// 在 runner.ts 的 executeStream 函数末尾
const usage: TokenUsage = {
  promptTokens: totalUsage?.inputTokens ?? summary.usage.promptTokens,
  completionTokens: totalUsage?.outputTokens ?? summary.usage.completionTokens,
  totalTokens:
    totalUsage !== undefined
      ? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
      : summary.usage.totalTokens,
};

// 如果所有值都是0，使用粗略估算
if (usage.totalTokens === 0 && responseText) {
  // 粗略估算：1 token ≈ 4 characters (英文)
  const estimatedTokens = Math.ceil(responseText.length / 4);
  usage.completionTokens = estimatedTokens;
  usage.totalTokens = estimatedTokens;
  console.warn('[SessionRunner] Provider did not return usage, using rough estimation:', usage);
}
```

## 推荐方案

**切换到支持usage统计的provider**：

1. **Anthropic Claude API** (官方) - 完整的usage统计
2. **OpenAI API** (官方) - 完整的usage统计
3. **其他支持usage的兼容服务**

## 如何验证provider是否支持usage

在API文档中查找：
- `usage` 字段
- `prompt_tokens` / `completion_tokens`
- `input_tokens` / `output_tokens`

如果文档中没有提到这些字段，该provider可能不支持usage统计。
