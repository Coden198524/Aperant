# 多端点自动切换配置示例

## 功能说明

当一个 API 端点返回模型不存在错误（404）时，系统会自动切换到下一个可用的账户。

## 配置示例

在 `C:/Users/LS/AppData/Roaming/aperant/settings.json` 中配置多个账户：

```json
{
  "providerAccounts": [
    {
      "provider": "openai-compatible",
      "name": "yunyi Claude",
      "authType": "api-key",
      "billingModel": "pay-per-use",
      "apiKey": "YOUR_API_KEY_1",
      "baseUrl": "https://yunyi.rdzhvip.com/claude",
      "id": "pa_1775258737382_3ztj8d",
      "createdAt": 1775258737382,
      "updatedAt": 1775258737382,
      "modelEquivalenceProvider": "anthropic"
    },
    {
      "provider": "openai-compatible",
      "name": "Backup OpenAI Endpoint",
      "authType": "api-key",
      "billingModel": "pay-per-use",
      "apiKey": "YOUR_API_KEY_2",
      "baseUrl": "https://another-endpoint.com/v1",
      "id": "pa_1775258737383_xyz123",
      "createdAt": 1775258737383,
      "updatedAt": 1775258737383,
      "modelEquivalenceProvider": "openai"
    }
  ],
  "globalPriorityOrder": [
    "pa_1775258737382_3ztj8d",
    "pa_1775258737383_xyz123"
  ]
}
```

## 字段说明

### `provider`
连接方式，使用 `openai-compatible` 表示 OpenAI 兼容的 API 端点。

### `modelEquivalenceProvider`
**关键字段**：指定使用哪个 provider 的模型映射表。

- `"anthropic"` - 使用 Claude 模型名称（如 `claude-opus-4-6`）
- `"openai"` - 使用 OpenAI 模型名称（如 `gpt-5.3-codex`）
- `"google"` - 使用 Google 模型名称（如 `gemini-2.5-pro`）

### `globalPriorityOrder`
账户优先级顺序。系统会按照这个顺序尝试使用账户。

## 工作流程

1. 系统首先使用 `pa_1775258737382_3ztj8d` 账户（yunyi Claude）
2. 如果该账户返回 404 错误（模型不存在），系统会自动切换到下一个账户
3. 使用 `pa_1775258737383_xyz123` 账户（Backup OpenAI Endpoint）
4. 控制台会输出切换日志：
   ```
   [SessionRunner] model not found detected, attempting to switch accounts...
   [SessionRunner] Switching to account pa_1775258737383_xyz123 with model gpt-5.3-codex
   ```

## 自动切换触发条件

系统会在以下情况自动切换账户：

1. **429 Rate Limit** - 速率限制
2. **401 Authentication Failure** - 认证失败
3. **404 Model Not Found** - 模型不存在（新增）

## 注意事项

1. 确保每个账户的 `modelEquivalenceProvider` 与其 API 端点支持的模型匹配
2. 如果所有账户都失败，任务会报错并停止
3. 最多尝试切换 1 次（MAX_AUTH_RETRIES = 1）
4. 切换后会使用新账户的模型映射重新发起请求

## 测试建议

1. 先配置一个会返回 404 的端点（如使用错误的模型映射）
2. 配置第二个正常工作的端点
3. 运行任务，观察控制台日志确认自动切换是否生效
