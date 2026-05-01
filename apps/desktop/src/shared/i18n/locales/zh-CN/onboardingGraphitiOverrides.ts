export const zhCNOnboardingGraphitiOverrides = {
  graphiti: {
    title: '\u8bb0\u5fc6\u4e0e\u4e0a\u4e0b\u6587',
    description: '\u542f\u7528 Graphiti\uff0c\u5728\u591a\u6b21\u7f16\u7801\u4f1a\u8bdd\u4e4b\u95f4\u4fdd\u7559\u6301\u4e45\u8bb0\u5fc6',
    successTitle: 'Graphiti \u914d\u7f6e\u6210\u529f',
    successDescription: '\u8bb0\u5fc6\u529f\u80fd\u5df2\u542f\u7528\u3002Autocode \u5c06\u5728\u4e0d\u540c\u4f1a\u8bdd\u4e4b\u95f4\u4fdd\u6301\u4e0a\u4e0b\u6587\uff0c\u4ee5\u6539\u5584\u5bf9\u4ee3\u7801\u7684\u7406\u89e3\u3002',
    reconfigure: '\u91cd\u65b0\u914d\u7f6e Graphiti \u8bbe\u7f6e',
    databaseAutoTitle: '\u6570\u636e\u5e93\u5c06\u81ea\u52a8\u521b\u5efa',
    databaseAutoDescription: 'LadybugDB \u4f7f\u7528\u5185\u5d4c\u5f0f\u6570\u636e\u5e93\uff0c\u65e0\u9700 Docker\u3002\u5f53\u4f60\u9996\u6b21\u4f7f\u7528\u8bb0\u5fc6\u529f\u80fd\u65f6\uff0c\u6570\u636e\u5e93\u4f1a\u81ea\u52a8\u521b\u5efa\u3002',
    infoTitle: 'Graphiti \u662f\u4ec0\u4e48\uff1f',
    infoDescription: 'Graphiti \u662f\u4e00\u4e2a\u667a\u80fd\u8bb0\u5fc6\u5c42\uff0c\u53ef\u5e2e\u52a9 Autocode \u5728\u591a\u4e2a\u4f1a\u8bdd\u4e4b\u95f4\u8bb0\u4f4f\u4e0a\u4e0b\u6587\u3002\u5b83\u4f7f\u7528\u77e5\u8bc6\u56fe\u8c31\u5b58\u50a8\u5173\u4e8e\u4f60\u4ee3\u7801\u5e93\u7684\u53d1\u73b0\u3001\u6a21\u5f0f\u548c\u89c1\u89e3\u3002',
    bullets: {
      persistentMemory: '\u5728\u591a\u6b21\u7f16\u7801\u4f1a\u8bdd\u4e4b\u95f4\u4fdd\u6301\u6301\u4e45\u8bb0\u5fc6',
      betterUnderstanding: '\u968f\u65f6\u95f4\u63a8\u79fb\u66f4\u597d\u5730\u7406\u89e3\u4f60\u7684\u4ee3\u7801\u5e93',
      fewerExplanations: '\u51cf\u5c11\u91cd\u590d\u89e3\u91ca',
      noDocker: '\u65e0\u9700 Docker\uff0c\u4f7f\u7528\u5185\u5d4c\u5f0f\u6570\u636e\u5e93'
    },
    learnMore: '\u4e86\u89e3\u66f4\u591a Graphiti \u4fe1\u606f',
    enableLabel: '\u542f\u7528 Graphiti \u8bb0\u5fc6',
    enableDescription: '\u4f7f\u7528 LadybugDB\uff08\u5185\u5d4c\uff09\u548c LLM/Embedding \u63d0\u4f9b\u5546',
    databaseName: '\u6570\u636e\u5e93\u540d\u79f0',
    databaseStoredIn: '\u5b58\u50a8\u4f4d\u7f6e\uff1a~/.autocode/graphs/',
    status: {
      ready: '\u5c31\u7eea',
      issue: '\u5f02\u5e38'
    },
    llmProvider: 'LLM \u63d0\u4f9b\u5546',
    embeddingProvider: 'Embedding \u63d0\u4f9b\u5546',
    testConnection: '\u6d4b\u8bd5\u8fde\u63a5',
    testingConnection: '\u6b63\u5728\u6d4b\u8bd5\u8fde\u63a5...',
    validationSuccess: '\u6240\u6709\u8fde\u63a5\u5747\u5df2\u9a8c\u8bc1\u6210\u529f\uff01',
    noteApiValidation: '\u6ce8\uff1a\u5f53\u524d API \u5bc6\u94a5\u9a8c\u8bc1\u4ec5\u5bf9 OpenAI \u63d0\u4f9b\u5b8c\u6574\u652f\u6301\u3002\u4f60\u7684\u5bc6\u94a5\u4ecd\u4f1a\u88ab\u4fdd\u5b58\u5e76\u5728\u8fd0\u884c\u65f6\u4f7f\u7528\u3002',
    noteOllamaValidation: '\u6ce8\uff1aOllama \u8fde\u63a5\u5c06\u901a\u8fc7\u68c0\u67e5\u670d\u52a1\u5668\u662f\u5426\u53ef\u8fbe\u6765\u9a8c\u8bc1\u3002',
    fields: {
      anthropicApiKey: 'Anthropic API \u5bc6\u94a5',
      voyageApiKey: 'Voyage API \u5bc6\u94a5',
      googleApiKey: 'Google API \u5bc6\u94a5',
      groqApiKey: 'Groq API \u5bc6\u94a5',
      openrouterApiKey: 'OpenRouter API \u5bc6\u94a5',
      azureSettings: 'Azure OpenAI \u8bbe\u7f6e',
      ollamaSettings: 'Ollama \u8bbe\u7f6e\uff08\u672c\u5730\uff09',
      llmModel: 'LLM \u6a21\u578b',
      ensureOllama: '\u8bf7\u786e\u4fdd Ollama \u5df2\u5728\u672c\u5730\u8fd0\u884c\u3002\u53c2\u89c1'
    },
    placeholders: {
      openaiApiKey: 'sk-...',
      anthropicApiKey: 'sk-ant-...',
      azureApiKey: 'Azure API \u5bc6\u94a5',
      azureBaseUrl: 'https://your-resource.openai.azure.com',
      azureLlmDeployment: 'gpt-4',
      azureEmbeddingDeployment: 'text-embedding-ada-002',
      voyageApiKey: 'pa-...',
      googleApiKey: 'AIza...',
      groqApiKey: 'gsk_...',
      openrouterApiKey: 'sk-or-...',
      ollamaBaseUrl: 'http://localhost:11434',
      ollamaLlmModel: '\u4f8b\u5982\uff1allama3.2\u3001deepseek-r1:7b',
      ollamaEmbeddingModel: 'nomic-embed-text',
      ollamaEmbeddingDim: '768',
      databaseName: 'auto_claude_memory'
    },
    getKeyFrom: '\u83b7\u53d6\u5bc6\u94a5\uff1a',
    errors: {
      enterRequiredForTest: '\u8bf7\u5148\u8f93\u5165 {{field}}\uff0c\u518d\u6d4b\u8bd5\u8fde\u63a5',
      required: '{{field}} \u4e3a\u5fc5\u586b\u9879',
      databaseFailed: '\u6570\u636e\u5e93\uff1a{{message}}',
      testFailed: '\u6d4b\u8bd5\u8fde\u63a5\u5931\u8d25',
      saveFailed: '\u4fdd\u5b58\u8bb0\u5fc6\u914d\u7f6e\u5931\u8d25'
    },
    validation: {
      providerConfigured: '{{provider}} Embedding \u63d0\u4f9b\u5546\u5df2\u914d\u7f6e'
    },
    providers: {
      llm: {
        openai: { description: 'GPT \u6a21\u578b\uff08\u63a8\u8350\uff09' },
        anthropic: { description: 'Claude \u6a21\u578b' },
        google: { description: 'Gemini \u6a21\u578b' },
        groq: { description: 'Llama \u6a21\u578b\uff08\u5feb\u901f\u63a8\u7406\uff09' },
        openrouter: { description: '\u591a\u63d0\u4f9b\u5546\u805a\u5408\u5668' },
        azure_openai: { description: '\u4f01\u4e1a\u7ea7 Azure \u90e8\u7f72' },
        ollama: { description: '\u672c\u5730\u6a21\u578b\uff08\u514d\u8d39\uff09' }
      },
      embedding: {
        ollama: { description: '\u672c\u5730 Embedding\uff08\u514d\u8d39\uff09' },
        openai: { description: 'text-embedding-3-small\uff08\u63a8\u8350\uff09' },
        voyage: { description: 'voyage-3\uff08\u4e0e Anthropic \u642d\u914d\u6548\u679c\u4f73\uff09' },
        google: { description: 'Gemini text-embedding-004' },
        openrouter: { description: '\u517c\u5bb9 OpenAI \u7684 Embedding' },
        azure_openai: { description: '\u4f01\u4e1a\u7ea7 Azure Embedding' }
      }
    }
  }
} as const;
