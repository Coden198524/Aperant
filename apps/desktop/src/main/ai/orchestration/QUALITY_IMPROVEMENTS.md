# Code Quality Improvements - Integration Guide

本文档说明如何集成新的代码质量提升功能到现有的 Autocode 系统中。

## 已实施的功能

### 1. Pre-QA Smoke Tests (✅ 已完成)

**文件**: `pre-qa-smoke-tests.ts`

**功能**: 在 QA agent 启动前运行快速静态检查,包括:
- 语法检查 (ESLint/Biome)
- 类型检查 (TypeScript)
- 安全扫描 (硬编码密钥检测)
- 单元测试 (仅变更文件)
- 构建检查

**集成位置**: `build-orchestrator.ts` 的 `runQAPhase()` 方法

**使用方式**:
```typescript
// 在 runQAPhase() 开始时自动运行
const smokeTestResult = await runPreQASmokeTests(projectDir, specDir);

if (smokeTestResult.shouldReturnToCoding) {
  // 关键问题 - 返回 coding phase
  return this.resumeCodingFromQA('Pre-QA smoke tests failed');
}
```

**预期效果**:
- 40% 的问题在 smoke tests 阶段被拦截
- QA 迭代时间从 8 分钟降至 3 分钟
- 节省 LLM 调用成本

---

### 2. Incremental Validation (✅ 已完成)

**文件**: `incremental-validation.ts`

**功能**: 每个子任务完成后立即运行轻量级验证:
- 语法检查 (针对修改的文件)
- 类型检查 (针对修改的文件)
- 安全检查 (硬编码密钥、SQL 注入、XSS)
- 模式合规性检查 (与 pattern files 对比)
- 相关单元测试

**集成位置**: `subtask-iterator.ts` 的 `iterateSubtasks()` 方法

**使用方式**:
```typescript
// 在 runSubtaskSession() 成功后自动运行
if (result.outcome === 'success') {
  const validationResult = await runIncrementalValidation({
    subtaskId: subtask.id,
    filesModified: subtask.files_to_modify || [],
    patternFiles: subtask.pattern_files,
    projectDir: config.projectDir,
    specDir: config.specDir,
  });

  if (!validationResult.passed) {
    // 验证失败 - 重试子任务
    continue;
  }
}
```

**预期效果**:
- 问题在 1 分钟内发现,而非 30 分钟后
- QA 迭代次数从 3.2 降至 1.4
- 首次提交质量从 72% 提升至 88%

---

### 3. Pattern Injection System (✅ 已完成)

**文件**: `pattern-injection.ts`

**功能**: 在生成 coder prompt 时动态注入:
- 从 pattern files 提取的具体代码片段
- 从记忆系统检索的成功案例
- 强制性的实现示例

**集成方式**:

需要在生成 coder prompt 的地方调用:

```typescript
import { enhanceCoderPrompt, shouldInjectPatterns } from './pattern-injection';

// 在生成 prompt 时
async function generateCoderPrompt(subtask: SubtaskInfo, basePrompt: string) {
  if (shouldInjectPatterns(subtask)) {
    const enhanced = await enhanceCoderPrompt(basePrompt, {
      subtask: {
        id: subtask.id,
        description: subtask.description,
        filesToModify: subtask.filesToModify,
        patternFiles: subtask.patternFiles,
      },
      projectDir: config.projectDir,
      specDir: config.specDir,
      memoryService: memoryService, // 可选
    });

    console.log(formatInjectionSummary(enhanced));
    return enhanced.enhancedPrompt;
  }

  return basePrompt;
}
```

**预期效果**:
- 模式遵循率从 65% 提升至 92%
- 减少"代码风格不一致"的 QA 反馈

---

## 待集成的功能

### 4. Pre-Implementation Checklist (第二阶段)

**目标**: 在子任务实现前生成预防性检查清单

**实施步骤**:
1. 创建 `pre-implementation-checklist.ts`
2. 分析历史失败模式
3. 基于文件类型生成检查项
4. 在 `subtask-iterator.ts` 中,在 `runSubtaskSession()` 前调用

**集成点**:
```typescript
// 在 subtask-iterator.ts 的 runSubtaskSession() 前
const checklist = await generatePreImplementationChecklist(subtask, memoryService);
// 将 checklist 注入到 prompt 中
```

---

### 5. Enhanced Self-Critique (第二阶段)

**目标**: 强制执行自我批判,低于阈值自动重写

**实施步骤**:
1. 创建 `self-critique.ts`
2. 定义评分标准 (模式匹配、错误处理、安全性等)
3. 在 agent session 结束后强制运行
4. 评分 < 80% 时自动重试

**集成点**:
```typescript
// 在 agent-session.ts 中
const critiqueResult = await runCritiqueTool(result.generatedCode);
if (critiqueResult.score < 0.8) {
  // 重新生成,附带反馈
  return runAgentSessionWithCritique(config, critiqueResult.feedback);
}
```

---

### 6. Context-Aware Recovery (第二阶段)

**目标**: 智能分析失败模式,选择恢复策略

**实施步骤**:
1. 创建 `context-aware-recovery.ts`
2. 实现失败模式分析器
3. 定义恢复策略 (扩展上下文、模板模式、修复验证等)
4. 在 `subtask-iterator.ts` 的重试逻辑中使用

**集成点**:
```typescript
// 在 subtask-iterator.ts 中,当子任务失败时
if (currentAttempt > 1) {
  const strategy = await intelligentRetry(subtask, failureHistory);
  // 根据策略调整下次尝试
}
```

---

### 7. Active Memory Learning (第三阶段)

**目标**: 每个 session 结束后自动提取知识

**实施步骤**:
1. 创建 `active-memory-learning.ts`
2. 实现成功/失败模式提取
3. 实现代码模式提取
4. 在每个 agent session 结束后调用

**集成点**:
```typescript
// 在 subtask-iterator.ts 的 onSubtaskComplete 中
await extractAndStoreKnowledge(sessionResult, subtask, memoryService);
```

---

### 8. Tiered Quality Standards (第三阶段)

**目标**: 根据代码重要性分级质量标准

**实施步骤**:
1. 创建 `tiered-quality.ts`
2. 实现重要性分类器
3. 定义分层检查项
4. 在 QA phase 中根据等级调整检查

**集成点**:
```typescript
// 在 qa-loop.ts 中
const tier = determineQualityTier(subtask);
const checks = getQAChecksForTier(tier);
```

---

## 集成优先级

### 立即集成 (已完成)
- ✅ Pre-QA Smoke Tests
- ✅ Incremental Validation
- ✅ Pattern Injection System

### 第二阶段 (1-2 周)
- ⏳ Pre-Implementation Checklist
- ⏳ Enhanced Self-Critique
- ⏳ Context-Aware Recovery

### 第三阶段 (长期优化)
- ⏳ Active Memory Learning
- ⏳ Tiered Quality Standards

---

## 测试建议

### 单元测试
每个新模块都应该有对应的测试文件:
- `pre-qa-smoke-tests.test.ts`
- `incremental-validation.test.ts`
- `pattern-injection.test.ts`

### 集成测试
测试完整流程:
1. 创建测试项目
2. 运行 build orchestrator
3. 验证新功能被正确调用
4. 检查质量指标改善

### 性能测试
监控新功能的性能影响:
- Smoke tests 应在 10 秒内完成
- Incremental validation 应在 30 秒内完成
- Pattern injection 不应显著增加 prompt 生成时间

---

## 监控指标

跟踪以下指标来验证改进效果:

| 指标 | 基线 | 目标 | 当前 |
|------|------|------|------|
| 首次提交通过率 | 72% | 88% | - |
| QA 迭代次数 | 3.2 | 1.4 | - |
| 子任务成功率 | 78% | 91% | - |
| 平均修复时间 | 12 min | 5 min | - |
| QA 成本 | 100% | 70% | - |

---

## 配置选项

在 `build-orchestrator.ts` 中添加配置选项:

```typescript
interface BuildOrchestratorConfig {
  // 现有配置...

  // 新增配置
  enablePreQASmokeTests?: boolean;      // 默认 true
  enableIncrementalValidation?: boolean; // 默认 true
  enablePatternInjection?: boolean;      // 默认 true
  enablePreImplementationChecklist?: boolean; // 默认 false (第二阶段)
  enableEnhancedSelfCritique?: boolean;      // 默认 false (第二阶段)
}
```

---

## 故障排除

### Smoke Tests 失败
- 检查项目是否有 `package.json` 和相关脚本
- 确认 lint/typecheck 命令可以正常运行
- 查看 smoke test 输出日志

### Incremental Validation 误报
- 检查 pattern files 是否正确
- 调整安全检查的正则表达式
- 添加白名单规则

### Pattern Injection 无效
- 确认 subtask 有 `patternFiles` 字段
- 检查 pattern files 是否存在
- 验证 prompt 注入位置正确

---

## 下一步

1. **完成第一阶段集成测试**
   - 在真实项目上测试 3 个已实施的功能
   - 收集性能和质量指标
   - 根据反馈调整参数

2. **开始第二阶段开发**
   - Pre-Implementation Checklist
   - Enhanced Self-Critique
   - Context-Aware Recovery

3. **规划第三阶段**
   - Active Memory Learning
   - Tiered Quality Standards

---

## 贡献指南

如果要添加新的质量改进功能:

1. 在 `apps/desktop/src/main/ai/orchestration/` 创建新文件
2. 遵循现有模块的结构和命名约定
3. 添加完整的 TypeScript 类型定义
4. 编写单元测试
5. 更新本文档
6. 提交 PR 并附带性能测试结果

---

## 参考资料

- [ARCHITECTURE.md](../../../../../shared_docs/ARCHITECTURE.md) - 系统架构
- [CLAUDE.md](../../../../../CLAUDE.md) - 开发指南
- [build-orchestrator.ts](./build-orchestrator.ts) - 构建编排器
- [subtask-iterator.ts](./subtask-iterator.ts) - 子任务迭代器
- [qa-loop.ts](./qa-loop.ts) - QA 循环
