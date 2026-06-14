# Provider Model Support Matrix

Version: 2026-06-14

This guide records the commercial v1 provider/model support posture used by the desktop app. It is derived from the provider registry in `apps/desktop/src/shared/constants/providers.ts` and the built-in model catalog in `libs/core/src/config/model-catalog.ts`.

Provider availability, prices, quotas, regional enablement, and model retirement dates are controlled by the upstream provider. Autocode v1 should present this as product support evidence, not as a contractual guarantee that every upstream model remains available.

## Support Levels

- `built-in-catalog`: Autocode ships named model choices and provider presets for this provider.
- `custom-endpoint`: Autocode supports user-defined models from a configured OpenAI-compatible endpoint.
- `local-runtime`: Autocode connects to a local runtime and discovers or accepts locally installed models.
- `provider-config-only`: Account or endpoint configuration is supported, but the commercial model catalog is not enumerated by Autocode yet.

## Provider Summary

| Provider | Support level | Auth | Configuration | Built-in models | Commercial v1 note |
| --- | --- | --- | --- | ---: | --- |
| Anthropic | `built-in-catalog` | OAuth, API key, `ANTHROPIC_API_KEY` | None | 6 | Named Claude catalog and presets are supported. |
| OpenAI | `built-in-catalog` | OAuth, API key, `OPENAI_API_KEY` | Optional `baseUrl` | 9 | Named GPT/Codex catalog and presets are supported. |
| Google AI | `built-in-catalog` | API key, `GOOGLE_GENERATIVE_AI_API_KEY` | None | 4 | Named Gemini catalog and presets are supported. |
| OpenRouter | `provider-config-only` | API key, `OPENROUTER_API_KEY` | None | 0 | Account configuration is supported; the upstream OpenRouter model catalog is not enumerated in the built-in commercial matrix. |
| Z.AI | `built-in-catalog` | API key, `ZHIPU_API_KEY` | Optional `baseUrl` | 4 | Named GLM catalog and presets are supported. |
| DeepSeek | `built-in-catalog` | API key, `DEEPSEEK_API_KEY` | Optional `baseUrl` | 2 | Named DeepSeek catalog and presets are supported. |
| xAI | `built-in-catalog` | API key, `XAI_API_KEY` | None | 3 | Named Grok catalog and presets are supported. |
| Mistral | `built-in-catalog` | API key, `MISTRAL_API_KEY` | None | 2 | Named Mistral catalog and presets are supported. |
| Groq | `built-in-catalog` | API key, `GROQ_API_KEY` | None | 2 | Named Groq-hosted model catalog and presets are supported. |
| AWS Bedrock | `provider-config-only` | API key, `AWS_ACCESS_KEY_ID` | `region` | 0 | Model availability depends on AWS region, account access, and Bedrock model enablement. |
| Azure OpenAI | `provider-config-only` | API key, `AZURE_OPENAI_API_KEY` | `baseUrl` | 0 | Model availability depends on the configured Azure deployment. |
| Ollama | `local-runtime` | None | `baseUrl` | 0 | Models are local to the user machine and are not bundled with the app. |
| Custom Endpoint | `custom-endpoint` | API key | `baseUrl` | 0 | Models are supplied by the configured endpoint or account custom model list. |

## Built-In Catalog

| Provider | Model values |
| --- | --- |
| Anthropic | `opus-4.7`, `opus`, `opus-1m`, `sonnet`, `opus-4.5`, `haiku` |
| OpenAI | `gpt-5.5`, `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.2-codex`, `gpt-5.1-codex-mini`, `gpt-5-nano`, `o3`, `o4-mini` |
| Google AI | `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`, `gemini-2.0-flash` |
| Z.AI | `glm-5`, `glm-4.7`, `glm-4.6v`, `glm-4.5-flash` |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash` |
| xAI | `grok-4-0709`, `grok-3`, `grok-3-mini` |
| Mistral | `mistral-large-latest`, `mistral-small-latest` |
| Groq | `meta-llama/llama-4-maverick`, `llama-3.3-70b-versatile` |

## Cost Display Policy

Commercial v1 displays token counts and labels whether token usage is provider-reported or locally estimated. Monetary cost estimates remain disabled until a versioned provider pricing policy and invoice reconciliation workflow are approved.

Any future cost-estimate feature must include:

- A versioned pricing table and owner.
- Provider-specific billing-unit notes, including cached input, reasoning, image, tool, and batch pricing where applicable.
- A reconciliation workflow against provider invoices or usage exports.
- UI copy that distinguishes estimates from billed amounts.
- A release note when the pricing policy changes.

## Commercial Readiness Impact

This matrix closes the provider/model support documentation blocker for a Windows local package candidate. It does not close the remaining commercial launch blockers for public brand, license posture, signing/update channel, privacy/support review, distribution channel, or manual packaged-app acceptance.
