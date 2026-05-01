# Token使用统计修复 - 测试计划

## 修复内容

修复了 `apps/desktop/src/main/ai/session/runner.ts:695-700` 中的逻辑错误：

### 修复前
```typescript
totalTokens:
  (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0) ||  // ❌ 错误
  summary.usage.totalTokens,
```

**问题**：当 `totalUsage` 存在但值为0时，`0 || X` 会错误地fallback到summary

### 修复后
```typescript
totalTokens:
  // FIX: Only fallback to summary when totalUsage is undefined, not when it's 0
  // The previous logic `0 || X` incorrectly treated valid 0 values as falsy
  totalUsage !== undefined
    ? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
    : summary.usage.totalTokens,
```

**改进**：只有当 `totalUsage` 为 `undefined` 时才fallback，而不是值为0时

## 测试步骤

### 1. 启动应用并观察日志

```bash
npm run dev
```

### 2. 创建一个测试任务

创建一个简单的任务，例如："创建一个hello world函数"

### 3. 观察控制台日志

在任务执行过程中，查找以下关键日志：

#### A. Stream Handler日志（每个step）
```
[StreamHandler] finish-step received: {
  stepNumber: 1,
  usage: { promptTokens: 1234, completionTokens: 567, ... },
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801
}

[StreamHandler] Cumulative usage after step 1: {
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801
}
```

**预期**：如果provider支持finish-step事件，应该看到非0的usage值

#### B. Session Runner日志（session结束时）
```
[SessionRunner] Available result fields: ['fullStream', 'text', 'totalUsage', ...]
[SessionRunner] result.usage: undefined
[SessionRunner] result.experimental_providerMetadata: {...}
[SessionRunner] Got totalUsage from result: { inputTokens: 1234, outputTokens: 567 }
[SessionRunner] Final usage: {
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801
}
[SessionRunner] Usage source: {
  usedTotalUsage: true,
  totalUsageValue: { inputTokens: 1234, outputTokens: 567 },
  summaryUsageValue: { promptTokens: 1234, completionTokens: 567, totalTokens: 1801 }
}
```

**预期**：
- `usedTotalUsage: true` 表示使用了 `result.totalUsage`
- `totalTokens` 应该是 `inputTokens + outputTokens` 的和
- 值应该非0（除非真的没有使用任何token）

#### C. Worker日志（发送到IPC）
```
[Worker] Session complete for 001-test-task, usage: {
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801,
  stepsExecuted: 5
}
[Worker] Sending task-token-usage for 001-test-task: {
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801,
  stepsExecuted: 5
}
```

**预期**：usage值应该非0

#### D. IPC Handler日志（接收并持久化）
```
[agent-events-handlers] Received task-token-usage for 001-test-task: {
  promptTokens: 1234,
  completionTokens: 567,
  totalTokens: 1801,
  stepsExecuted: 5
}
```

**预期**：接收到的usage值应该非0

### 4. 检查UI显示

在任务卡片上，应该看到：
- **Token使用量**：显示非0的数值（例如："1.8K tokens"）
- **步骤数**：显示执行的步骤数（例如："5 steps"）

### 5. 检查持久化数据

打开 `.autocode/specs/001-test-task/implementation_plan.json`，检查 `tokenUsage` 字段：

```json
{
  "tokenUsage": {
    "promptTokens": 1234,
    "completionTokens": 567,
    "totalTokens": 1801,
    "stepsExecuted": 5
  }
}
```

**预期**：所有值应该非0

## 测试场景

### 场景1：正常的Anthropic Claude任务
- **Provider**: Anthropic
- **Model**: Claude Opus 4.6
- **预期**: 应该从 `finish-step` 事件获取usage，summary和totalUsage都有值

### 场景2：OpenAI Responses API
- **Provider**: OpenAI
- **Model**: gpt-5.3-codex (如果使用Responses API)
- **预期**: 
  - `finish-step` 可能不包含usage（summary为0）
  - 应该从 `result.totalUsage` 获取usage
  - 最终usage应该非0

### 场景3：其他provider
- **Provider**: Google, Bedrock, Azure等
- **预期**: 根据provider的实现，应该从某个来源获取到usage

## 回归测试

确保修复没有破坏现有功能：

1. ✅ 任务可以正常创建和执行
2. ✅ Token统计显示正确
3. ✅ 任务状态正常更新
4. ✅ 日志文件正常生成
5. ✅ 应用刷新后token统计仍然显示

## 已知问题

如果测试后仍然显示0，可能的原因：

1. **Provider不支持usage统计** - 某些自定义endpoint可能不返回usage
2. **AI SDK版本问题** - 确认使用的是 `ai@6.0.116`
3. **Promise超时** - `result.totalUsage` 超时（10秒），检查网络延迟
4. **Stream未完成** - Stream提前中断，未收到完整的usage数据

## 调试技巧

如果问题仍然存在，添加更多日志：

```typescript
// 在 stream-handler.ts 的 handleFinishStep 中
console.log('[StreamHandler] Raw part.usage:', JSON.stringify(part.usage, null, 2));

// 在 runner.ts 的 executeStream 中
console.log('[SessionRunner] Stream summary:', JSON.stringify(summary, null, 2));
```

## 相关Issue

- 修复了 `0 || X` 的逻辑错误，该错误会将有效的0值当作falsy处理
- 改进了日志输出，便于诊断usage数据来源
