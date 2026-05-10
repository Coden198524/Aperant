# 跨Provider多模型支持

## 问题描述

之前的版本中，虽然系统支持配置多个provider账户（如Claude和Codex），但在创建任务时，模型选择器会被限制为只显示当前激活provider的模型。这导致用户无法在同一个任务的不同阶段使用不同厂家的模型。

## 解决方案

### 修改内容

1. **AgentProfileSelector.tsx** - 移除了 `filterProvider` 限制
   - 第302行：移除phase模型选择器的provider过滤
   - 第331行：移除custom模式模型选择器的provider过滤
   - 第306行和第335行：移除ThinkingLevelSelect的provider参数（改为自动检测）

2. **models.ts** - 添加provider自动检测功能
   - 新增 `detectProviderFromModelId()` 函数：从模型ID自动检测provider
   - 修改 `getReasoningConfigForModel()` 函数：使provider参数变为可选，未提供时自动检测

3. **ThinkingLevelSelect.tsx** - 支持provider自动检测
   - 将 `provider` 参数改为可选
   - 添加文档说明：如果未指定provider，将从模型ID自动检测

### 功能说明

现在用户可以：

1. **在任务创建时看到所有已配置provider的模型**
   - 如果配置了Claude和OpenAI账户，模型选择器会同时显示Claude和GPT模型
   - 模型按provider分组显示，每个组显示provider名称

2. **为不同阶段选择不同provider的模型**
   ```json
   {
     "phaseModels": {
       "spec": "sonnet",           // Claude Sonnet
       "planning": "gpt-5.5",      // OpenAI GPT-5.5
       "coding": "opus",           // Claude Opus
       "qa": "gemini-2.5-pro"      // Google Gemini
     }
   }
   ```

3. **系统自动处理provider切换**
   - 运行时会根据选择的模型自动使用对应的provider账户
   - 如果某个provider达到rate limit，系统会自动切换到同provider的其他账户

### 使用方法

1. **配置多个provider账户**
   - 进入设置 → Agent Settings → Provider Accounts
   - 添加多个provider账户（如Anthropic、OpenAI、Google等）

2. **创建任务时选择模型**
   - 创建新任务
   - 选择 "Auto" 或其他profile
   - 展开 "Phase Configuration"
   - 为每个阶段选择不同provider的模型

3. **查看可用模型**
   - 模型选择器会显示所有已配置provider的模型
   - 未配置的provider会显示为灰色，并提供配置链接

## 技术细节

### Provider检测逻辑

```typescript
// 从模型ID自动检测provider
export function detectProviderFromModelId(modelValue: string): BuiltinProvider {
  const modelEntry = ALL_AVAILABLE_MODELS.find(m => m.value === modelValue);
  return modelEntry?.provider ?? 'anthropic';
}
```

### Thinking Level自动适配

系统会根据模型的provider自动选择合适的thinking配置：
- **Anthropic**: `thinking_tokens` 或 `adaptive_effort`
- **OpenAI**: `reasoning_effort`
- **Google**: `thinking_toggle`
- **其他**: 根据模型能力自动判断

### 运行时Provider解析

在 `apps/desktop/src/main/ai/auth/resolver.ts` 中，系统会：
1. 从模型ID检测provider
2. 查找对应provider的可用账户
3. 根据优先级和rate limit状态选择账户
4. 自动处理token刷新和账户切换

## 兼容性

- ✅ 向后兼容：现有的单provider配置继续正常工作
- ✅ 类型安全：所有修改都通过TypeScript类型检查
- ✅ 测试通过：Linter和类型检查全部通过

## 未来改进

1. **Per-agent模型配置**：目前支持per-phase配置，未来可以支持更细粒度的per-agent-type配置
2. **动态模型选择**：根据subtask复杂度自动选择最合适的模型
3. **成本优化**：根据token价格和任务类型自动选择性价比最高的模型组合
