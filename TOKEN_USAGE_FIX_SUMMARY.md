# Token使用统计修复 - 总结

## 问题
任务的token统计始终显示为0

## 根本原因
`apps/desktop/src/main/ai/session/runner.ts:695-700` 中的逻辑错误：

```typescript
// ❌ 错误代码
totalTokens: (totalUsage?.inputTokens ?? 0) + (totalUsage?.outputTokens ?? 0) || summary.usage.totalTokens,
```

当 `totalUsage` 存在但值为0时，`0 || X` 会错误地fallback到summary

## 修复
```typescript
// ✅ 修复后
totalTokens:
  totalUsage !== undefined
    ? (totalUsage.inputTokens ?? 0) + (totalUsage.outputTokens ?? 0)
    : summary.usage.totalTokens,
```

只有当 `totalUsage` 为 `undefined` 时才fallback，不会将有效的0值当作falsy

## 修改文件
- ✅ `apps/desktop/src/main/ai/session/runner.ts` (已修复并编译)

## 测试方法
1. 启动应用：`npm run dev`
2. 创建测试任务
3. 观察控制台日志：
   - `[SessionRunner] Final usage:` - 应显示非0值
   - `[SessionRunner] Usage source:` - 确认数据来源
4. 检查UI上的token显示
5. 检查 `implementation_plan.json` 中的 `tokenUsage` 字段

## 编译状态
✅ 编译成功 (2024)

## 相关文档
- `TOKEN_USAGE_FIX.md` - 详细问题分析
- `TOKEN_USAGE_TEST_PLAN.md` - 完整测试计划
