# 并行任务执行测试规格

## 测试目标

验证批量执行系统能否正确地：
1. 识别独立的子任务
2. 并行执行多个子任务
3. 正确处理子任务完成状态
4. 在看板上显示执行进度
5. 在串行回退时正确处理

## 测试需求：构建一个简单的计算器 CLI 工具

### 业务描述

创建一个命令行计算器，支持基本的四则运算。这个需求能够产生多个独立的子任务，非常适合测试批量执行。

### 功能要求

1. **加法功能**
   - 支持两个整数相加
   - 命令格式: `calc add 5 3`
   - 输出: `Result: 8`
   - 文件: `src/calculator/add.ts`

2. **减法功能**
   - 支持两个整数相减
   - 命令格式: `calc subtract 10 3`
   - 输出: `Result: 7`
   - 文件: `src/calculator/subtract.ts`

3. **乘法功能**
   - 支持两个整数相乘
   - 命令格式: `calc multiply 6 7`
   - 输出: `Result: 42`
   - 文件: `src/calculator/multiply.ts`

4. **除法功能**
   - 支持两个整数相除
   - 处理除以零的错误
   - 命令格式: `calc divide 20 4`
   - 输出: `Result: 5`
   - 文件: `src/calculator/divide.ts`

5. **主程序/CLI 入口**
   - 整合所有运算功能
   - 错误处理
   - 文件: `src/index.ts`

6. **单元测试**
   - 为每个功能编写测试
   - 验证正确性
   - 文件: `src/__tests__/calculator.test.ts`

## 预期的子任务分解

编排器应该自动分解为以下子任务（这些任务互相独立，可以并行执行）：

```
Subtask 1: Implement addition function
  - Create src/calculator/add.ts
  - Implement add(a: number, b: number) => number
  - Return a + b

Subtask 2: Implement subtraction function
  - Create src/calculator/subtract.ts
  - Implement subtract(a: number, b: number) => number
  - Return a - b

Subtask 3: Implement multiplication function
  - Create src/calculator/multiply.ts
  - Implement multiply(a: number, b: number) => number
  - Return a * b

Subtask 4: Implement division function with error handling
  - Create src/calculator/divide.ts
  - Implement divide(a: number, b: number) => number
  - Handle division by zero

Subtask 5: Create main CLI entry point
  - Create src/index.ts
  - Import all operation functions
  - Parse command-line arguments
  - Call appropriate function
  - Output result

Subtask 6: Add comprehensive test coverage
  - Create src/__tests__/calculator.test.ts
  - Test all four operations
  - Test error cases
```

## 预期的批量执行流程

### Round 1 - Batch 1/2 (并行执行 4 个子任务)
```
Starting batch 1/2 with 4 subtasks
  1. subtask-1-1: Implement addition function
  2. subtask-1-2: Implement subtraction function
  3. subtask-1-3: Implement multiplication function
  4. subtask-1-4: Implement division function with error handling

Batch complete: 4/4 subtasks finished
  ✓ Completed: subtask-1-1, subtask-1-2, subtask-1-3, subtask-1-4
```

### Round 1 - Batch 2/2 (继续执行剩余子任务)
```
Starting batch 2/2 with 2 subtasks
  1. subtask-1-5: Create main CLI entry point
  2. subtask-1-6: Add comprehensive test coverage

Batch complete: 2/2 subtasks finished
  ✓ Completed: subtask-1-5, subtask-1-6
```

## 验证指标

### 1. 性能改进
- **串行执行**: 6 个子任务 = 6 个 AI 会话
- **批量执行**: 6 个子任务 = 2 个 AI 会话
- **预期节省**: 66% 的会话数（从 6 降至 2）

### 2. 正确性检查

#### 代码生成正确性
- [ ] 所有 4 个运算函数正确实现
- [ ] 除法函数正确处理除以零
- [ ] CLI 入口点能正确解析参数
- [ ] 测试全部通过

#### 执行过程
- [ ] 任务卡显示 "⚡ Batch 1/2 (4 tasks)"
- [ ] 日志中显示 4 个子任务 ID 和描述
- [ ] 第一个批次完成后继续执行第二个批次
- [ ] 最终显示 "⚡ Batch 2/2 (2 tasks)"

#### 日志验证
- [ ] 看到 "Round 1" 日志
- [ ] 看到 "Conflict analysis" 显示独立任务数量
- [ ] 看到 "Executing X batches" 日志
- [ ] 每个批次都有 "Starting batch" 和 "Batch complete" 消息
- [ ] 成功完成消息显示 "6 total completed, 0 total failed"

#### 任务卡显示
- [ ] 任务处于 "in_progress" 状态
- [ ] 显示当前执行模式 ("batch")
- [ ] 显示当前批次号和总批次数
- [ ] 显示当前批次中的子任务列表
- [ ] 显示每个子任务的 ID 和标题

### 3. 串行回退测试（可选）

如果需要测试串行回退：
- 创建一个有文件冲突的需求
- 验证冲突检测正确工作
- 验证冲突任务被标记为顺序执行

## 测试步骤

### 第 1 步：创建新任务
1. 打开 Autocode 应用
2. 点击 "New Task"
3. 填写以下信息：
   - **标题**: "Build a Simple CLI Calculator"
   - **描述**: （使用上面的功能要求）
   - **类别**: "feature"
   - **复杂度**: "medium"
   - **优先级**: "high"
4. 点击 "Create Task"

### 第 2 步：观察任务执行
1. 任务进入 "queue" 列
2. 点击任务进入详情视图
3. 查看日志面板中的 "Coding" 阶段
4. 验证以下内容：
   - 看到批量执行的日志
   - 看到子任务 ID 和描述
   - 批次数量和总数

### 第 3 步：验证生成代码
1. 任务完成后，展开 "Subtasks" 部分
2. 验证所有 6 个子任务都标记为 "completed"
3. 检查生成的文件：
   - `src/calculator/add.ts`
   - `src/calculator/subtract.ts`
   - `src/calculator/multiply.ts`
   - `src/calculator/divide.ts`
   - `src/index.ts`
   - `src/__tests__/calculator.test.ts`

### 第 4 步：验证功能
1. 在终端中运行生成的代码：
   ```bash
   npx ts-node src/index.ts add 5 3
   # 输出: Result: 8
   
   npx ts-node src/index.ts divide 20 0
   # 输出: Error: Division by zero
   
   npm test
   # 所有测试通过
   ```

## 成功标准

### 必须满足
- ✅ 所有 6 个子任务成功完成
- ✅ 日志显示 2 个批次
- ✅ 生成的代码正确运行
- ✅ 所有测试通过

### 应该显示
- ✅ 任务卡上显示并行执行信息
- ✅ "Batch 1/2 (4 tasks)" 标识
- ✅ "Batch 2/2 (2 tasks)" 标识
- ✅ 当前批次的子任务列表

### 性能目标
- ✅ 总执行时间 < 3 分钟
- ✅ 使用 2 个批次而不是 6 个单独会话
- ✅ 至少节省 60% 的 AI 会话数

## 常见问题排查

### 如果看不到批次日志
1. 确保在任务详情页面
2. 在 "Logs" 标签页中
3. 展开 "Coding" 阶段
4. 向下滚动查看所有日志

### 如果子任务没有全部完成
1. 检查错误日志（红色）
2. 查看是否有冲突
3. 验证是否回退到了串行模式

### 如果生成的代码有问题
1. 查看完整的日志输出
2. 检查是否有 AI 模型超时
3. 尝试增加模型的思考时间

## 扩展测试（可选）

### 测试 1：更大规模的任务
创建一个有 10+ 个独立子任务的需求，验证批量执行能否处理更多并行任务。

### 测试 2：有依赖的任务
创建一个有子任务依赖关系的需求，验证冲突检测和串行执行。

### 测试 3：失败恢复
模拟某些子任务失败（通过提供矛盾的要求），验证错误处理。

## 预期输出示例

```
[BatchExecutor] Round 1
[BatchExecutor] Found 6 pending subtasks
[BatchExecutor] Conflict analysis: 6 independent, 0 sequential
[BatchExecutor] Batch size: 4
[BatchExecutor] Executing 2 batches
Starting batch 1/2 with 4 subtasks
  1. subtask-1-1: Implement addition function
  2. subtask-1-2: Implement subtraction function
  3. subtask-1-3: Implement multiplication function
  4. subtask-1-4: Implement division function with error handling
Batch complete: 4/4 subtasks finished
  ✓ Completed: subtask-1-1, subtask-1-2, subtask-1-3, subtask-1-4
Starting batch 2/2 with 2 subtasks
  1. subtask-1-5: Create main CLI entry point
  2. subtask-1-6: Add comprehensive test coverage
Batch complete: 2/2 subtasks finished
  ✓ Completed: subtask-1-5, subtask-1-6
[BatchExecutor] Round 1 completed: 6 completed, 0 failed
[BatchExecutor] No more pending subtasks
[BatchExecutor] All rounds completed: 6 total completed, 0 total failed
```
