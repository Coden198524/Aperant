# Token使用统计始终为0的问题分析与修复

## 问题根源

经过代码分析，发现token统计为0的问题出在 `runner.ts` 的usage计算逻辑：

### 当前代码流程 (runner.ts:674-700)

```typescript
let totalUsage: { inputTokens?: number; outputTokens?: number } | undefined;

try {
  totalUsage = await withTimeout(result.totalUsage, POST_STREAM_TIMEOUT_MS, 'result.totalUsage');
  console.log('[SessionRunner] Got totalUsage from result:', totalUsage);
} catch (err) {
  console.warn('[SessionRunner] Failed to get totalUsage from result:', err);
  // Fall through — use summary usage collected during stream iteration.
}

// 问题在这里：当totalUsage存在但值为0时，会错误地fallback到summary
const usage: TokenUsage = {
  promptTokens: totalUsage?.inputTokens ?? summary.usage.promptTokens,
  completionTokens: totalUsage?.outputTokens ?? summary.usage.completionTokens,
  totalTokens:
    (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0) ||  // ❌ 0 || X 的逻辑错误
    summary.usage.totalTokens,
};
```

### 问题分析

1. **AI SDK 6.0.116** 的 `result.totalUsage` 返回 `{ inputTokens, outputTokens }`
2. **某些provider** (如OpenAI Responses API) 不在 `finish-step` 事件中发送usage，导致 `summary.usage` 全是0
3. **当 `totalUsage` 存在但两个值都是0时**：
   - `(0 ?? 0) + (0 ?? 0) = 0`
   - `0 || summary.usage.totalTokens` 会fallback到summary
   - 如果summary也是0，最终结果就是0

4. **逻辑错误**：`0 || X` 会把有效的0值当作falsy，错误地fallback

## 修复方案

### 方案1：修复totalTokens计算逻辑（推荐）

```typescript
const usage: TokenUsage = {
  promptTokens: totalUsage?.inputTokens ?? summary.usage.promptTokens,
  completionTokens: totalUsage?.outputTokens ?? summary.usage.completionTokens,
  totalTokens:
    // 修复：只有当totalUsage不存在时才fallback，而不是值为0时
    totalUsage !== undefined
      ? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
      : summary.usage.totalTokens,
};
```

### 方案2：增加调试日志，确认数据来源

在计算usage之前添加详细日志：

```typescript
console.log('[SessionRunner] Usage calculation:', {
  totalUsageExists: totalUsage !== undefined,
  totalUsageValue: totalUsage,
  summaryUsage: summary.usage,
  willUseTotalUsage: totalUsage !== undefined,
});
```

### 方案3：检查AI SDK的实际返回

某些provider可能在不同的字段返回usage：

```typescript
// 检查所有可能的usage字段
console.log('[SessionRunner] Checking all usage fields:', {
  'result.totalUsage': totalUsage,
  'result.usage': (result as any).usage,
  'result.experimental_providerMetadata': (result as any).experimental_providerMetadata,
  'summary.usage': summary.usage,
});
```

## 验证步骤

1. 运行一个任务，观察控制台日志
2. 查找 `[StreamHandler] finish-step received:` - 确认是否有usage数据
3. 查找 `[SessionRunner] Got totalUsage from result:` - 确认totalUsage的值
4. 查找 `[SessionRunner] Final usage:` - 确认最终计算结果
5. 查找 `[Worker] Sending task-token-usage` - 确认发送给IPC的值

## 相关文件

- `apps/desktop/src/main/ai/session/runner.ts:674-700` - usage计算逻辑
- `apps/desktop/src/main/ai/session/stream-handler.ts:244-288` - finish-step处理
- `apps/desktop/src/main/ai/agent/worker.ts:876-889` - 发送token usage
- `apps/desktop/src/main/ai/agent/worker-bridge.ts:184-201` - 接收并转发
- `apps/desktop/src/main/ipc-handlers/agent-events-handlers.ts:366-400` - 持久化
- `apps/desktop/src/main/ipc-handlers/task/plan-file-utils.ts:386-431` - 写入plan文件
