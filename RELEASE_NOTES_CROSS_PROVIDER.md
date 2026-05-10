# 跨Provider多模型支持 - 发布说明

## 🎉 新功能

### 在同一任务中使用多家大模型

现在您可以在创建任务时，为不同的执行阶段选择不同厂家的大模型，充分发挥各家模型的优势。

## ✨ 主要特性

### 1. 统一的模型选择器
- **查看所有已配置provider的模型**：不再局限于单一provider
- **按provider分组显示**：清晰的模型分类
- **智能过滤**：未配置的provider显示为灰色，并提供快速配置链接

### 2. 灵活的阶段配置
为每个执行阶段选择最适合的模型：

| 阶段 | 推荐模型 | 说明 |
|------|---------|------|
| **Spec** | Claude Sonnet | 快速理解需求 |
| **Planning** | GPT-5.5 / Claude Opus | 深度规划能力 |
| **Coding** | Claude Opus / GPT-5.3 Codex | 代码生成质量 |
| **QA** | Gemini 2.5 Pro / Claude Opus | 全面的质量检查 |

### 3. 自动Provider检测
- 系统自动识别模型所属的provider
- 自动适配不同provider的thinking配置
- 无需手动指定provider参数

### 4. 智能账户管理
- 自动使用对应provider的账户
- Rate limit时自动切换到备用账户
- 支持多账户负载均衡

## 📋 使用示例

### 示例1：平衡型配置
```json
{
  "phaseModels": {
    "spec": "sonnet",           // Claude Sonnet - 快速
    "planning": "sonnet",       // Claude Sonnet - 平衡
    "coding": "opus",           // Claude Opus - 高质量
    "qa": "sonnet"              // Claude Sonnet - 高效
  }
}
```

### 示例2：多Provider混合配置
```json
{
  "phaseModels": {
    "spec": "sonnet",           // Claude Sonnet (Anthropic)
    "planning": "gpt-5.5",      // GPT-5.5 (OpenAI)
    "coding": "opus",           // Claude Opus (Anthropic)
    "qa": "gemini-2.5-pro"      // Gemini 2.5 Pro (Google)
  }
}
```

### 示例3：成本优化配置
```json
{
  "phaseModels": {
    "spec": "haiku",            // Claude Haiku - 最便宜
    "planning": "sonnet",       // Claude Sonnet - 中等
    "coding": "gpt-5.5",        // GPT-5.5 - 高性能
    "qa": "gemini-2.5-flash"    // Gemini Flash - 快速便宜
  }
}
```

## 🚀 快速开始

### 步骤1：配置Provider账户
1. 打开 **设置 → Agent Settings → Provider Accounts**
2. 添加您想使用的provider账户：
   - Anthropic (Claude)
   - OpenAI (GPT)
   - Google (Gemini)
   - 其他支持的provider

### 步骤2：创建任务
1. 点击 **New Task** 创建新任务
2. 选择 **Agent Profile**（推荐选择 "Auto"）
3. 展开 **Phase Configuration**
4. 为每个阶段选择模型

### 步骤3：查看可用模型
- 模型选择器会显示所有已配置provider的模型
- 点击搜索框可以快速查找模型
- 未配置的provider会显示配置链接

## 🔧 技术改进

### 代码修改
1. **AgentProfileSelector.tsx**
   - 移除 `filterProvider` 限制
   - 支持跨provider模型选择

2. **models.ts**
   - 新增 `detectProviderFromModelId()` 函数
   - 优化 `getReasoningConfigForModel()` 支持自动检测

3. **ThinkingLevelSelect.tsx**
   - `provider` 参数改为可选
   - 自动适配不同provider的thinking类型

### 兼容性
- ✅ 向后兼容现有配置
- ✅ 通过TypeScript类型检查
- ✅ 通过Linter代码质量检查
- ✅ 所有测试通过

## 💡 最佳实践

### 1. 根据任务类型选择模型
- **简单任务**：使用快速模型（Haiku, Gemini Flash）
- **复杂任务**：使用高级模型（Opus, GPT-5.5）
- **代码生成**：优先使用Codex或Opus
- **质量检查**：使用Gemini或Opus

### 2. 成本优化
- Spec阶段使用便宜的模型
- Coding阶段使用高质量模型
- QA阶段根据项目重要性选择

### 3. 性能优化
- 使用快速模型加速非关键阶段
- 关键阶段使用最强模型保证质量
- 利用多provider避免单一provider的rate limit

## 🐛 已知限制

1. **Per-agent配置**：目前支持per-phase配置，暂不支持per-agent-type配置
2. **动态选择**：暂不支持根据subtask复杂度自动选择模型
3. **成本追踪**：暂不支持跨provider的统一成本追踪

## 🔮 未来计划

1. **Per-agent模型配置**：更细粒度的控制
2. **智能模型推荐**：根据任务特征推荐最佳模型组合
3. **成本分析**：跨provider的成本统计和优化建议
4. **性能对比**：不同模型组合的性能对比报告

## 📞 反馈与支持

如有问题或建议，请：
- 查看详细文档：`CROSS_PROVIDER_SUPPORT.md`
- 提交Issue到GitHub仓库
- 联系技术支持团队

---

**版本**: 2.8.0-beta.6+
**发布日期**: 2026-05-10
**作者**: Claude Code Team
