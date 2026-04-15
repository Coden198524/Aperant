# 批量执行系统循环处理修复

## 问题描述

批量执行系统 (`executeBatches`) 只处理一轮子任务，然后就返回，导致剩余的待处理子任务没有被并行处理。

## 根本原因

`batch-executor.ts` 中的 `executeBatches` 函数缺少外层循环，只执行了一次批量处理周期：

```typescript
// 旧代码：只执行一轮
export async function executeBatches(config: BatchExecutorConfig): Promise<BatchExecutorResult> {
  // 加载计划
  const plan = await loadImplementationPlan(config.specDir);
  
  // 获取待处理子任务
  const pendingSubtasks = getPendingSubtasks(plan);
  
  // 执行一轮批次处理
  // ... 然后返回
  
  return { success, totalCompleted, totalFailed };
}
```

## 解决方案

在 `executeBatches` 函数中添加外层循环，循环执行直到没有更多待处理子任务：

```typescript
export async function executeBatches(config: BatchExecutorConfig): Promise<BatchExecutorResult> {
  let totalCompleted = 0;
  let totalFailed = 0;
  let roundNumber = 0;

  // 外层循环：直到没有待处理子任务
  while (true) {
    roundNumber++;
    log(`[BatchExecutor] Round ${roundNumber}`);

    // 重新加载计划
    const plan = await loadImplementationPlan(config.specDir);
    
    // 获取待处理子任务
    const pendingSubtasks = getPendingSubtasks(plan);
    if (pendingSubtasks.length === 0) {
      log('[BatchExecutor] No more pending subtasks');
      break; // 所有子任务完成，退出循环
    }

    // 执行本轮批次处理
    // ... 处理冲突检测、批量大小计算、并行执行等
    
    totalCompleted += roundCompleted;
    totalFailed += roundFailed;

    // 如果有失败，停止循环
    if (roundFailed > 0) {
      log(`[BatchExecutor] Stopping due to failures`);
      break;
    }
  }

  return { success, totalCompleted, totalFailed };
}
```

## 关键改进点

1. **外层循环** - `while (true)` 循环重复执行批次处理
2. **计划重新加载** - 每轮开始时重新加载 `implementation_plan.json`，反映之前的进度
3. **轮次跟踪** - 添加 `roundNumber` 来标识每一轮的处理
4. **退出条件**：
   - 没有待处理子任务 → 成功完成
   - 执行中有失败 → 停止处理（由串行回退机制处理）
   - 用户取消 → 停止处理
5. **轮次摘要** - 每轮完成后输出该轮的完成和失败数量

## 执行流程示例

假设有 6 个独立的子任务，批量大小为 2：

```
Round 1:
  Found 6 pending subtasks
  Executing 3 batches
  Batch 1 (subtask-1, subtask-2) → 完成
  Batch 2 (subtask-3, subtask-4) → 完成
  Batch 3 (subtask-5, subtask-6) → 完成
  Round 1 completed: 6 completed, 0 failed

Round 2:
  Found 0 pending subtasks
  No more pending subtasks
  → 退出循环

All rounds completed: 6 total completed, 0 total failed
```

## 日志输出增强

现在你可以看到：

```
[BatchExecutor] Round 1
[BatchExecutor] Found 6 pending subtasks
[BatchExecutor] Conflict analysis: 6 independent, 0 sequential
[BatchExecutor] Batch size: 2
[BatchExecutor] Executing 3 batches
Starting batch 1 with 2 subtasks
  1. subtask-1: ...
  2. subtask-2: ...
Batch complete: 2/2 subtasks finished
  ✓ Completed: subtask-1, subtask-2
[BatchExecutor] Round 1 completed: 6 completed, 0 failed
[BatchExecutor] All rounds completed: 6 total completed, 0 total failed
```

## 测试结果

- ✅ TypeScript 类型检查通过
- ✅ 批量执行器单元测试：4/4 通过
- ✅ 编排器恢复测试：2/2 通过
- ✅ 程序成功编译

## 修改文件

- `apps/desktop/src/main/ai/orchestration/batch-executor.ts` - `executeBatches()` 函数

## 影响范围

- ✅ 不破坏现有 API（返回类型不变）
- ✅ 向后兼容
- ✅ 自动处理多轮迭代
- ✅ 与串行回退机制兼容

## 性能影响

- 循环处理不会增加 AI 会话总数
- 每轮重新加载计划有轻微的 I/O 成本（可忽略）
- 总体性能提升不变（40-60% 时间节省）
