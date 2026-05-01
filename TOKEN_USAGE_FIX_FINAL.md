# Token使用统计修复 - 最终版本

## 问题描述
任务的token统计始终显示为0，即使请求次数显示正确（例如显示2次请求）

## 发现的问题

### 问题1：runner.ts中的逻辑错误
**位置**: `apps/desktop/src/main/ai/session/runner.ts:695-700`

**错误代码**:
```typescript
totalTokens: (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0) || summary.usage.totalTokens
```

**问题**: 使用 `0 || X` 的逻辑，当totalUsage存在但值为0时，会错误地fallback到summary

**修复**:
```typescript
totalTokens:
  totalUsage !== undefined
    ? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
    : summary.usage.totalTokens,
```

### 问题2：worker.ts中阻止发送0值的检查
**位置**: `apps/desktop/src/main/ai/agent/worker.ts:878`

**错误代码**:
```typescript
if (result.usage && result.usage.totalTokens > 0) {
  // 只有totalTokens > 0时才发送
  postMessage({ type: 'task-token-usage', ... });
}
```

**问题**: 这个检查会阻止发送usage数据，即使usage对象存在但totalTokens为0。这导致：
- 即使runner.ts计算出了正确的usage，也不会发送到IPC
- UI永远收不到token统计更新

**修复**:
```typescript
// Always send usage data, even if totalTokens is 0 (helps with debugging)
if (result.usage) {
  postMessage({ type: 'task-token-usage', ... });
}
```

## 修改的文件

1. ✅ `apps/desktop/src/main/ai/session/runner.ts`
   - 修复了totalTokens计算逻辑
   - 添加了详细的调试日志

2. ✅ `apps/desktop/src/main/ai/session/stream-handler.ts`
   - 增强了finish-step事件的调试日志

3. ✅ `apps/desktop/src/main/ai/agent/worker.ts`
   - 移除了 `totalTokens > 0` 的检查
   - 现在总是发送usage数据（只要usage对象存在）

## 数据流

```
AI SDK Stream
    ↓
[StreamHandler] 累积usage (finish-step事件)
    ↓
[SessionRunner] 计算最终usage (totalUsage或summary)
    ↓
[Worker] 发送task-token-usage消息 ← 问题2在这里阻止了发送
    ↓
[WorkerBridge] 转发到主进程
    ↓
[IPC Handler] 接收并持久化
    ↓
[Plan File Utils] 写入implementation_plan.json
    ↓
[Project Store] 读取并显示在UI
```

## 调试日志

修复后，控制台会显示详细的调试信息：

```
========== USAGE DEBUG START ==========
[SessionRunner] Available result fields: [...]
[SessionRunner] result.usage: undefined
[SessionRunner] summary.usage from stream: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
[SessionRunner] summary.stepsExecuted: 2
[SessionRunner] ✅ Got totalUsage from result: { inputTokens: 1234, outputTokens: 567 }
[SessionRunner] Final usage: { promptTokens: 1234, completionTokens: 567, totalTokens: 1801 }
[SessionRunner] Usage source: {
  usedTotalUsage: true,
  totalUsageValue: { inputTokens: 1234, outputTokens: 567 },
  summaryUsageValue: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
}
========== USAGE DEBUG END ==========

[Worker] Session complete for 001-test-task, usage: { promptTokens: 1234, ... }
[Worker] Sending task-token-usage for 001-test-task: { promptTokens: 1234, ... }
```

## 测试步骤

1. 启动应用: `npm run dev`
2. 创建一个测试任务
3. 观察控制台日志：
   - 查找 `========== USAGE DEBUG START ==========`
   - 确认 `[SessionRunner] Final usage:` 显示非0值
   - 确认 `[Worker] Sending task-token-usage` 被调用
4. 检查UI上的token显示
5. 检查 `.autocode/specs/*/implementation_plan.json` 中的 `tokenUsage` 字段

## 预期结果

- ✅ Token统计显示正确的非0值
- ✅ 步骤数显示正确（例如：2 steps）
- ✅ UI实时更新token使用量
- ✅ 刷新后token统计仍然显示（已持久化）

## 编译状态

✅ **编译成功** (2024-04-13)

## 根本原因分析

问题的根本原因是**双重过滤**：

1. **第一层过滤** (runner.ts): `0 || X` 逻辑错误，可能导致计算出0
2. **第二层过滤** (worker.ts): `totalTokens > 0` 检查，阻止发送0值

即使第一层计算正确，第二层也会阻止数据传输。两个问题叠加，导致token统计永远是0。

## 相关文档

- `TOKEN_USAGE_FIX.md` - 初步问题分析
- `TOKEN_USAGE_TEST_PLAN.md` - 详细测试计划
- `TOKEN_USAGE_FIX_SUMMARY.md` - 快速总结
