# 批量执行系统使用指南

## 概述

批量执行系统允许在单个 AI 会话中并行处理多个子任务，显著提升任务执行速度。

## 如何查看正在并行处理的子任务

### 1. 任务详情界面

在任务详情界面中，点击 **Logs** 标签页查看任务日志。

### 2. 日志结构

日志按阶段组织：
- **Planning** - 规划阶段
- **Coding** - 编码阶段（批量执行在这里）
- **Validation** - QA 验证阶段

### 3. 批量执行日志格式

当批量执行开始时，你会看到以下日志：

```
Starting batch 1 with 3 subtasks
  1. subtask-1-1: Implement user authentication
  2. subtask-1-2: Add login form validation
  3. subtask-1-3: Create session management
```

当批量完成时，你会看到：

```
Batch complete: 3/3 subtasks finished
  ✓ Completed: subtask-1-1, subtask-1-2, subtask-1-3
```

如果有失败或阻塞的子任务：

```
Batch complete: 2/3 subtasks finished
  ✓ Completed: subtask-1-1, subtask-1-2
  ✗ Failed: subtask-1-3
```

或

```
Batch complete: 2/3 subtasks finished
  ✓ Completed: subtask-1-1, subtask-1-2
  ⊘ Blocked: subtask-1-3
```

### 4. 实时进度跟踪

在 Coding 阶段展开日志后，你可以看到：
- 每个批次开始时列出的所有子任务
- 工具调用（Read, Write, Edit, Bash 等）
- 每个子任务的完成状态
- 批次完成摘要

### 5. 日志图标说明

- ✓ (绿色勾) - 子任务成功完成
- ✗ (红色叉) - 子任务执行失败
- ⊘ (斜杠圆) - 子任务被阻塞（依赖未满足）

## 执行模式

系统支持三种执行模式：

### 1. `auto` (默认)
- 自动尝试批量执行
- 如果批量执行失败，自动回退到串行模式
- 推荐用于大多数场景

### 2. `batch`
- 强制使用批量执行
- 不会自动回退到串行模式
- 适合确定子任务可以并行执行的场景

### 3. `serial`
- 强制使用串行执行（一次一个子任务）
- 适合调试或子任务有严格依赖关系的场景

## 批量大小

系统会自动计算最优批量大小，考虑因素包括：
- 上下文窗口限制（默认 200,000 tokens）
- 子任务复杂度
- 文件冲突检测结果

你也可以手动指定批量大小（不推荐）。

## 冲突检测

系统会自动检测文件冲突：
- **独立子任务** - 操作不同文件，可以批量执行
- **冲突子任务** - 操作相同文件，必须串行执行

例如：
```
[BatchExecutor] Conflict analysis: 5 independent, 2 sequential
[BatchExecutor] Batch size: 3
[BatchExecutor] Executing 2 batches
```

这表示：
- 5 个子任务可以并行执行（将分成 2 个批次）
- 2 个子任务必须串行执行（因为文件冲突）

## 串行回退机制

如果连续 3 个批次失败，系统会自动切换到串行模式：

```
[BatchExecutor] Batch 1 had 2 failures (consecutive: 1)
[BatchExecutor] Batch 2 had 1 failures (consecutive: 2)
[BatchExecutor] Batch 3 had 2 failures (consecutive: 3)
[BatchExecutor] Fallback threshold reached, switching to serial mode
[BatchExecutor] Falling back to serial mode
```

## 进度标记

AI 模型在完成每个子任务后会输出进度标记：

```
[SUBTASK_COMPLETED: subtask-1-1]
[SUBTASK_COMPLETED: subtask-1-2]
```

系统会解析这些标记并与 `implementation_plan.json` 中的实际状态进行对比验证。

## 最佳实践

1. **让系统自动决定** - 使用默认的 `auto` 模式
2. **查看日志** - 展开 Coding 阶段查看详细的批量执行信息
3. **理解冲突** - 如果看到很多串行执行，可能是子任务之间有文件冲突
4. **信任回退** - 如果批量执行失败，系统会自动回退到串行模式

## 性能提升

批量执行可以显著减少任务执行时间：
- **串行模式**: 10 个子任务 = 10 个 AI 会话
- **批量模式**: 10 个子任务 = 3-4 个 AI 会话（取决于批量大小）

预期时间节省：**40-60%**

## 故障排除

### 批量执行总是失败
- 检查子任务是否有隐藏的依赖关系
- 尝试减小批量大小
- 使用串行模式作为备选

### 看不到批量日志
- 确保展开了 Coding 阶段的日志
- 检查任务是否使用了批量执行模式
- 旧任务可能使用的是串行模式

### 子任务被标记为 Blocked
- 检查 `implementation_plan.json` 中的依赖关系
- 被阻塞的子任务会在后续批次中重试
- 如果持续被阻塞，可能需要手动干预
