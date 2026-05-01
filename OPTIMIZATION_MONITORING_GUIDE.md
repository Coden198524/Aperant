# 优化监控指南

## 如何查看优化效果

Phase 1 优化已添加详细的日志输出，可以实时监控以下指标：

---

## 1. 文件缓存监控

### 日志格式

```
[FileCache] MISS: /path/to/file.ts
[FileCache] CACHED: /path/to/file.ts (15.3 KB, total: 5 files)
[FileCache] HIT: /path/to/file.ts (hit rate: 45.2%)
[FileCache] INVALIDATED (modified): /path/to/file.ts
[FileCache] Session Stats: 23 hits, 28 misses, 45.1% hit rate, 12 files cached
```

### 指标说明

- **MISS**: 缓存未命中，需要从磁盘读取
- **CACHED**: 文件已缓存，显示文件大小和缓存总数
- **HIT**: 缓存命中，显示当前命中率
- **INVALIDATED**: 缓存失效（文件被修改或删除）
- **Session Stats**: 会话结束时的统计摘要

### 预期效果

- **命中率**: 30-60%（取决于任务类型）
- **重复读取**: 同一文件第二次读取应该命中缓存
- **修改后失效**: Write/Edit 操作后，缓存应该自动失效

---

## 2. Prompt Caching 监控

### 日志格式

```
[SessionRunner] Prompt Caching: ENABLED (Anthropic ephemeral cache)
[SessionRunner] Token Usage: {
  prompt: '12,345',
  completion: '3,456',
  total: '15,801',
  cacheRead: '8,234',
  cacheCreation: '4,111',
  cacheSavings: '40.0%'
}
```

### 指标说明

- **Prompt Caching**: 显示是否启用（仅 Anthropic 模型支持）
- **cacheRead**: 从缓存读取的 token 数量
- **cacheCreation**: 创建缓存的 token 数量
- **cacheSavings**: 缓存节省的百分比

### 预期效果

- **首次请求**: cacheCreation > 0, cacheRead = 0
- **后续请求**: cacheRead > 0（5分钟内）
- **节省率**: 20-60%（取决于系统提示词长度）

---

## 3. 上下文窗口监控

### 日志格式

```
[SessionRunner] Context Window: 45,678 / 200,000 tokens (22.8%)
[SessionRunner] Context Window: 189,234 / 200,000 tokens (94.6%)
WARNING: You are approaching the context window limit (94.6% used, 189,234 of 200,000 tokens). Consider summarizing or removing older messages.
```

### 指标说明

- **Context Window**: 当前使用量 / 总容量（百分比）
- **WARNING**: 达到 95% 阈值时触发警告

### 预期效果

- **优化前**: 90% 时触发压缩
- **优化后**: 95% 时触发压缩
- **收益**: 保留更多对话历史，减少压缩次数

---

## 如何查看日志

### 方法 1: 开发者工具控制台

1. 启动应用
2. 打开开发者工具（Ctrl+Shift+I 或 Cmd+Option+I）
3. 切换到 Console 标签
4. 创建并执行任务
5. 观察日志输出

### 方法 2: 终端输出

如果从终端启动应用：

```bash
cd E:\Work\Autocode
npm run dev
```

日志会直接输出到终端。

### 方法 3: 日志文件

应用日志可能保存在：
- Windows: `%APPDATA%\autocode\logs\`
- macOS: `~/Library/Logs/autocode/`
- Linux: `~/.config/autocode/logs/`

---

## 测试场景

### 场景 1: 验证文件缓存

**步骤**:
1. 创建一个需要多次读取同一文件的任务
2. 观察控制台中的 `[FileCache]` 日志
3. 第一次读取应该显示 MISS
4. 后续读取应该显示 HIT

**示例任务**: "读取 package.json 并分析依赖项"

### 场景 2: 验证 Prompt Caching

**步骤**:
1. 使用 Anthropic 提供商创建任务
2. 执行多个子任务
3. 观察 `[SessionRunner] Token Usage` 日志
4. 后续子任务应该显示 cacheRead > 0

**示例任务**: "创建一个包含3个子任务的功能"

### 场景 3: 验证上下文窗口优化

**步骤**:
1. 创建一个复杂任务（多个子任务）
2. 观察 `[SessionRunner] Context Window` 日志
3. 注意何时触发警告（应该在 95% 左右）

**示例任务**: "重构一个大型组件，包含多个文件"

---

## 性能对比

### 收集基准数据

**优化前**（如果有历史数据）:
- 任务完成时间: _____ 分钟
- Token 使用量: _____ tokens
- 文件读取次数: _____ 次

**优化后**（Phase 1）:
- 任务完成时间: _____ 分钟（预期减少 30-50%）
- Token 使用量: _____ tokens（预期减少 20-40%）
- 文件读取次数: _____ 次（预期减少 40-60%）

### 关键指标

1. **文件缓存命中率**: 目标 > 30%
2. **Prompt Cache 节省率**: 目标 > 20%
3. **上下文窗口利用率**: 目标 > 90%（优化前 < 90%）

---

## 故障排查

### 问题 1: 看不到 [FileCache] 日志

**可能原因**:
- 任务没有使用 Read 工具
- 日志级别过滤

**解决方法**:
- 确保任务需要读取文件
- 检查控制台过滤器设置

### 问题 2: Prompt Caching 显示 DISABLED

**可能原因**:
- 使用的不是 Anthropic 模型
- 模型配置中未启用缓存支持

**解决方法**:
- 切换到 Anthropic 提供商（Claude 模型）
- 检查模型配置

### 问题 3: 缓存命中率为 0%

**可能原因**:
- 每次都读取不同的文件
- 文件在读取之间被修改

**解决方法**:
- 这可能是正常的（取决于任务类型）
- 尝试创建需要重复读取的任务

---

## 高级监控

### 启用详细日志

如果需要更详细的调试信息，可以修改代码：

```typescript
// 在 file-cache.ts 中
console.log('[FileCache] Cache state:', {
  size: this.cache.size,
  keys: Array.from(this.cache.keys()),
});

// 在 runner.ts 中
console.log('[SessionRunner] Full usage object:', totalUsage);
```

### 性能分析

使用浏览器的 Performance 工具：
1. 打开开发者工具 → Performance 标签
2. 点击 Record
3. 执行任务
4. 停止录制并分析

---

## 总结

通过观察这些日志，你可以：
- ✅ 验证文件缓存是否工作
- ✅ 确认 Prompt Caching 是否生效
- ✅ 监控上下文窗口使用情况
- ✅ 评估优化效果
- ✅ 识别性能瓶颈

预期整体性能提升: **30-50%**
