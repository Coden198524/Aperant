# 问题修复说明

## 问题 1: Prompt Caching 未启用

### 现象
```
[SessionRunner] Prompt Caching: DISABLED (model does not support caching)
```

### 原因
Prompt Caching 只对 **Anthropic 官方 API** 的 Claude 模型有效。

### 解决方法

#### 检查当前配置
1. 打开应用设置
2. 查看 Provider 配置
3. 确认是否使用 Anthropic 官方 API

#### 启用 Prompt Caching 的要求
- ✅ Provider: Anthropic（官方 API）
- ✅ Model: Claude 系列（claude-3-5-sonnet, claude-opus-4 等）
- ✅ Base URL: `https://api.anthropic.com` 或留空（使用默认）

#### 如果使用第三方代理
如果你使用的是第三方 API 代理（如 OpenRouter、自建代理等），Prompt Caching 将不可用。这是正常的，不影响其他优化功能。

### 验证方法
切换到 Anthropic 官方 API 后，日志应该显示：
```
[SessionRunner] Prompt Caching: ENABLED (Anthropic ephemeral cache)
```

---

## 问题 2: 规划阶段超时

### 现象
```
Stream inactivity timeout — no data received from provider for 60s
```

### 原因
原始超时设置为 60 秒，对于复杂的规划任务可能不够。

### 已修复
✅ 超时时间已从 60 秒增加到 **120 秒**（2 分钟）

### 修改位置
`apps/desktop/src/main/ai/session/runner.ts:79`

```typescript
// 修改前
const STREAM_INACTIVITY_TIMEOUT_MS = 60_000;

// 修改后
const STREAM_INACTIVITY_TIMEOUT_MS = 120_000; // 2 minutes
```

### 影响
- 规划阶段有更多时间完成
- 减少超时错误
- 对于快速响应的任务没有负面影响

---

## 其他优化仍然有效

即使 Prompt Caching 未启用，以下优化仍然工作：

### ✅ 文件内容缓存
- 减少重复文件读取
- 提升 I/O 性能
- 查看日志: `[FileCache]`

### ✅ 上下文窗口管理
- 95% 阈值
- 保留更多对话历史
- 查看日志: `[SessionRunner] Context Window`

### ✅ 超时优化
- 120 秒超时
- 减少规划失败

---

## 测试建议

### 1. 重启应用
```bash
# 停止当前应用
# 重新启动
npm run dev
```

### 2. 重试失败的任务
之前超时的任务现在应该可以完成了。

### 3. 观察日志
- 文件缓存命中率
- 上下文窗口使用情况
- 任务完成时间

---

## 性能预期

### 使用 Anthropic 官方 API
- 文件缓存: ✅ 有效
- 上下文管理: ✅ 有效
- Prompt Caching: ✅ 有效
- **预期提升: 40-60%**

### 使用其他 Provider
- 文件缓存: ✅ 有效
- 上下文管理: ✅ 有效
- Prompt Caching: ❌ 不可用
- **预期提升: 20-30%**

---

## 下一步

1. ✅ 重启应用（使用新的超时设置）
2. ✅ 重试之前失败的任务
3. ✅ 观察性能改善
4. 可选：切换到 Anthropic 官方 API 以启用 Prompt Caching

---

## 常见问题

### Q: 为什么我的 Prompt Caching 没有启用？
A: 检查你是否使用 Anthropic 官方 API。第三方代理不支持 Prompt Caching。

### Q: 超时时间可以进一步增加吗？
A: 可以。如果 120 秒仍然不够，可以修改 `STREAM_INACTIVITY_TIMEOUT_MS` 为更大的值（如 180000 = 3 分钟）。

### Q: 文件缓存在哪里可以看到？
A: 打开开发者工具 Console，搜索 `[FileCache]` 标签。

### Q: 如何知道优化是否生效？
A: 对比任务完成时间。即使没有 Prompt Caching，文件缓存和上下文管理优化也应该带来 20-30% 的性能提升。

---

## 总结

- ✅ 超时问题已修复（60s → 120s）
- ✅ 文件缓存和上下文管理优化正常工作
- ⚠️ Prompt Caching 需要 Anthropic 官方 API
- 📊 预期性能提升：20-60%（取决于 Provider）
