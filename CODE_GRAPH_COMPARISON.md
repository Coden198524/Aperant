# Code Graph 实现对比分析

## 原始项目 (code-review-graph) vs 当前实现

### 📊 架构对比

| 组件 | 原始项目 (Python) | 当前实现 (TypeScript) | 状态 |
|------|------------------|---------------------|------|
| **数据库** | SQLite (sqlite3) | SQLite (libsql) | ✅ 完成 |
| **解析器** | Tree-sitter (23种语言) | Tree-sitter (7种语言) | ⚠️ 部分完成 |
| **图存储** | nodes, edges, metadata | nodes, edges, closure, index_state | ✅ 完成 (增强) |
| **增量更新** | Git hooks + file watcher | File watcher + git integration | ✅ 完成 |
| **爆炸半径分析** | BFS/DFS impact analysis | BlastRadiusAnalyzer | ✅ 完成 |
| **上下文优化** | Token reduction logic | ContextOptimizer | ✅ 完成 |
| **MCP 集成** | MCP server for AI tools | 直接集成到 AI 层 | ✅ 完成 (更好) |

---

## ✅ 已实现的核心功能

### 1. 数据库层 (`apps/desktop/src/main/ai/graph/database.ts`)

**原始项目的表结构:**
```sql
nodes (id, kind, name, qualified_name, file_path, line_start, line_end, 
       language, parent_name, params, return_type, modifiers, is_test, 
       file_hash, extra, updated_at)

edges (id, kind, source_qualified, target_qualified, file_path, line, 
       extra, confidence, confidence_tier, updated_at)

metadata (key, value)
```

**我们的实现:**
```sql
code_graph_nodes (id, project_id, type, label, file_path, language,
                  start_line, end_line, signature, metadata,
                  created_at, updated_at, stale_at)

code_graph_edges (id, project_id, from_id, to_id, type, weight,
                  metadata, created_at, updated_at, stale_at)

code_graph_closure (project_id, ancestor_id, descendant_id, depth)
  -- 传递闭包表，原项目没有，我们的优化

code_graph_index_state (project_id, last_indexed_at, last_commit_sha,
                        node_count, edge_count, index_version, languages)
```

**改进点:**
- ✅ 添加了 `project_id` 支持多项目
- ✅ 添加了 `closure` 表用于快速传递依赖查询
- ✅ 添加了 `index_state` 表跟踪索引状态
- ✅ 添加了 `stale_at` 字段支持增量更新

---

### 2. 爆炸半径分析 (`apps/desktop/src/main/ai/graph/analysis/blast-radius.ts`)

**原始项目 (`analysis.py`):**
```python
def compute_impact_radius(store, changed_files, max_depth=3):
    # BFS/DFS 遍历依赖图
    # 返回受影响的文件列表
```

**我们的实现:**
```typescript
class BlastRadiusAnalyzer {
  async analyze(projectId, changedFiles, options): Promise<BlastRadiusResult> {
    // 1. 直接依赖 (imports, calls)
    // 2. 传递依赖 (通过闭包表)
    // 3. 受影响的测试
    // 4. Token 节省计算
  }
}
```

**改进点:**
- ✅ 使用闭包表加速传递依赖查询
- ✅ 自动识别受影响的测试
- ✅ 内置 token 节省计算
- ✅ 支持置信度阈值过滤

---

### 3. 上下文优化 (`apps/desktop/src/main/ai/graph/analysis/context-optimizer.ts`)

**原始项目:**
- 隐式在 MCP 工具中实现
- 返回最小文件集

**我们的实现:**
```typescript
class ContextOptimizer {
  async optimizeContext(projectId, files, options): Promise<OptimizedContext> {
    // 1. 按重要性排序文件
    // 2. 选择最相关的文件
    // 3. 计算 token 节省
  }
}
```

**改进点:**
- ✅ 独立的优化器类
- ✅ 可配置的优化策略
- ✅ 详细的 token 节省指标

---

### 4. Tree-sitter 解析器 (`apps/desktop/src/main/ai/graph/parser/tree-sitter-parser.ts`)

**原始项目 (`parser.py`):**
- 支持 23 种语言
- 完整的 AST 提取
- 调用站点检测
- 测试框架识别

**我们的实现:**
- ✅ 支持 7 种语言 (C++, C#, Java, Lua, Python, TypeScript, JavaScript)
- ✅ AST 提取 (类, 函数, 导入)
- ✅ 测试框架识别
- ⚠️ 调用站点检测 (基础实现)

**差距:**
- ❌ 缺少 16 种语言支持 (Go, Rust, Ruby, PHP, Swift, Kotlin, Scala, Dart, R, Perl, Zig, PowerShell, Julia, Solidity, Vue, Svelte)
- ❌ 调用站点检测不够完善
- ❌ 缺少继承/实现关系检测

---

### 5. 增量索引器 (`apps/desktop/src/main/ai/graph/indexer/incremental-indexer.ts`)

**原始项目 (`incremental.py`):**
```python
def incremental_update(store, repo_root):
    # 1. Git diff 检测变更
    # 2. 计算文件哈希
    # 3. 只重新解析变更的文件
    # 4. 更新依赖的文件
```

**我们的实现:**
```typescript
class IncrementalIndexer {
  async indexChangedFiles(projectId, changedFiles): Promise<IndexResult> {
    // 1. 检测变更文件
    // 2. 标记陈旧节点
    // 3. 重新解析
    // 4. 更新闭包表
  }
}
```

**改进点:**
- ✅ 陈旧性追踪 (`stale_at` 字段)
- ✅ 批量更新优化
- ✅ 闭包表增量更新

---

### 6. 文件监视器 (`apps/desktop/src/main/ai/graph/indexer/file-watcher.ts`)

**原始项目:**
- Git hooks (post-commit, post-merge)
- 文件系统监视器

**我们的实现:**
```typescript
class FileWatcher {
  watch(projectPath, callback) {
    // 1. 监视文件变更
    // 2. 防抖 (1秒)
    // 3. 批处理 (2秒窗口)
    // 4. 触发增量索引
  }
}
```

**改进点:**
- ✅ 防抖和批处理
- ✅ 多项目支持
- ✅ 优雅的错误处理

---

## ⚠️ 部分实现的功能

### 1. 语言支持

| 语言 | 原始项目 | 当前实现 | 优先级 |
|------|---------|---------|--------|
| TypeScript/JavaScript | ✅ | ✅ | - |
| Python | ✅ | ✅ | - |
| C++ | ✅ | ✅ | - |
| C# | ✅ | ✅ | - |
| Java | ✅ | ✅ | - |
| Lua | ✅ | ✅ | - |
| Go | ✅ | ❌ | 🔴 高 |
| Rust | ✅ | ❌ | 🔴 高 |
| Ruby | ✅ | ❌ | 🟡 中 |
| PHP | ✅ | ❌ | 🟡 中 |
| Swift | ✅ | ❌ | 🟡 中 |
| Kotlin | ✅ | ❌ | 🟡 中 |
| Scala | ✅ | ❌ | 🟢 低 |
| Dart | ✅ | ❌ | 🟢 低 |
| R | ✅ | ❌ | 🟢 低 |
| Perl | ✅ | ❌ | 🟢 低 |
| Zig | ✅ | ❌ | 🟢 低 |
| PowerShell | ✅ | ❌ | 🟢 低 |
| Julia | ✅ | ❌ | 🟢 低 |
| Solidity | ✅ | ❌ | 🟢 低 |
| Vue | ✅ | ❌ | 🟡 中 |
| Svelte | ✅ | ❌ | 🟡 中 |

---

### 2. 调用站点检测

**原始项目:**
- 完整的调用图构建
- 跨文件调用追踪
- 动态调用检测

**当前实现:**
- ✅ 基础调用检测
- ⚠️ 跨文件调用追踪 (有限)
- ❌ 动态调用检测

---

## ❌ 未实现的功能

### 1. 社区检测 (`communities.py`)

**原始项目:**
```python
def detect_communities(store):
    # Louvain 算法
    # 识别代码模块
    # 社区可视化
```

**状态:** ❌ 未实现

**优先级:** 🟢 低 (对 PR 审查不是必需的)

---

### 2. 语义搜索 (`embeddings.py`, `search.py`)

**原始项目:**
- Vector embeddings (sentence-transformers)
- 语义相似度搜索
- BM25 + 向量混合搜索

**状态:** ❌ 未实现

**优先级:** 🟡 中 (可以提升搜索质量)

---

### 3. 可视化 (`visualization.py`)

**原始项目:**
- D3.js 力导向图
- 交互式图探索
- 社区着色

**状态:** ❌ 未实现

**优先级:** 🟡 中 (对调试有帮助)

---

### 4. MCP 服务器 (`daemon.py`, `daemon_cli.py`)

**原始项目:**
- 独立的 MCP 服务器
- 供外部 AI 工具调用

**状态:** ✅ 不需要 (我们直接集成到 AI 层)

---

### 5. CLI 工具 (`cli.py`, `main.py`)

**原始项目:**
```bash
code-review-graph build
code-review-graph update
code-review-graph analyze
code-review-graph visualize
```

**状态:** ❌ 未实现

**优先级:** 🟡 中 (对调试有帮助)

---

## 🎯 集成状态

### PR 审查集成

**原始项目:**
- 通过 MCP 工具调用
- AI 工具主动查询图

**当前实现:**
- ✅ 集成钩子已实现 (`integration/pr-review-hook.ts`)
- ❌ 尚未集成到 `pr-review-engine.ts`
- ❌ 缺少功能标志

**需要做的:**
1. 在 `runMultiPassReview()` 开始时调用 `optimizePRContext()`
2. 添加 `ENABLE_CODE_GRAPH` 功能标志
3. 在项目打开时初始化图数据库
4. 添加自动索引触发器

---

### QA 代理集成

**原始项目:**
- 通过 MCP 工具选择测试

**当前实现:**
- ✅ 集成钩子已实现 (`integration/qa-agent-hook.ts`)
- ❌ 尚未集成到 `build-orchestrator.ts`

---

### Read 工具集成

**原始项目:**
- 通过 MCP 工具建议相关文件

**当前实现:**
- ✅ 集成钩子已实现 (`integration/read-tool-hook.ts`)
- ❌ 尚未集成到 `tools/builtin/read.ts`

---

## 📈 性能对比

| 指标 | 原始项目 | 当前实现 | 备注 |
|------|---------|---------|------|
| **初始索引** | ~10秒 (500文件) | 未测试 | 需要基准测试 |
| **增量更新** | < 2秒 | < 2秒 (设计目标) | 需要验证 |
| **爆炸半径分析** | < 100ms | < 100ms (设计目标) | 需要验证 |
| **Token 减少** | 8.2x 平均 | 5-10x (预期) | 需要实际测试 |
| **语言支持** | 23 种 | 7 种 | 需要扩展 |

---

## 🚀 下一步行动计划

### Phase 3: PR 审查集成 (当前任务)

1. **集成到 PR 审查引擎** (优先级: 🔴 高)
   - [ ] 修改 `pr-review-engine.ts` 调用 `optimizePRContext()`
   - [ ] 添加图分析摘要到审查提示
   - [ ] 处理图不可用的降级情况

2. **添加功能标志** (优先级: 🔴 高)
   - [ ] 在设置中添加 `ENABLE_CODE_GRAPH`
   - [ ] 默认禁用 (软启动)
   - [ ] 添加 UI 开关

3. **数据库初始化** (优先级: 🔴 高)
   - [ ] 在项目打开时初始化图数据库
   - [ ] 添加自动索引触发器
   - [ ] 处理初始化失败

4. **测试和验证** (优先级: 🔴 高)
   - [ ] 编写集成测试
   - [ ] 性能基准测试
   - [ ] Token 节省验证

---

### Phase 4: 扩展语言支持 (未来)

1. **高优先级语言** (优先级: 🟡 中)
   - [ ] Go (tree-sitter-go)
   - [ ] Rust (tree-sitter-rust)
   - [ ] Vue (tree-sitter-vue)
   - [ ] Svelte (tree-sitter-svelte)

2. **中优先级语言** (优先级: 🟢 低)
   - [ ] Ruby, PHP, Swift, Kotlin
   - [ ] 其他语言

---

### Phase 5: 高级功能 (未来)

1. **可视化** (优先级: 🟡 中)
   - [ ] 图可视化组件
   - [ ] Token 节省指标显示
   - [ ] 爆炸半径可视化

2. **语义搜索** (优先级: 🟢 低)
   - [ ] Vector embeddings
   - [ ] 混合搜索

3. **社区检测** (优先级: 🟢 低)
   - [ ] Louvain 算法
   - [ ] 模块识别

---

## 📊 总结

### 已完成的核心功能 (Phase 1 & 2)

✅ **数据库层** - 完整实现，带闭包表优化  
✅ **爆炸半径分析** - 完整实现  
✅ **上下文优化** - 完整实现  
✅ **Tree-sitter 解析器** - 7种语言支持  
✅ **增量索引器** - 完整实现  
✅ **文件监视器** - 完整实现  
✅ **集成钩子** - PR审查、QA、Read工具  

### 当前任务 (Phase 3)

🔄 **PR 审查集成** - 进行中  
⏳ **功能标志** - 待实现  
⏳ **数据库初始化** - 待实现  
⏳ **测试验证** - 待实现  

### 与原始项目的主要差异

**优势:**
- ✅ 闭包表加速传递依赖查询
- ✅ 多项目支持
- ✅ 直接集成到 AI 层 (无需 MCP 服务器)
- ✅ TypeScript 类型安全

**差距:**
- ❌ 语言支持较少 (7 vs 23)
- ❌ 缺少可视化
- ❌ 缺少语义搜索
- ❌ 缺少社区检测

**结论:** 核心功能已完整实现，可以开始集成到 PR 审查流程。语言支持和高级功能可以后续迭代添加。
