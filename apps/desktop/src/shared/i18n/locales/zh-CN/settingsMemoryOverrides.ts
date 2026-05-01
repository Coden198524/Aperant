export const zhCNSettingsMemoryOverrides = {
  projectSections: {
    memory: {
      title: '\u8bb0\u5fc6',
      description: 'Graphiti \u8bb0\u5fc6\u540e\u7aef',
      integrationTitle: '\u8bb0\u5fc6',
      integrationDescription: '\u4e3a\u667a\u80fd\u4f53\u914d\u7f6e\u6301\u4e45\u5316\u7684\u8de8\u4f1a\u8bdd\u8bb0\u5fc6',
      syncDescription: '\u914d\u7f6e\u6301\u4e45\u5316\u8bb0\u5fc6',
      settings: {
        status: {
          enabled: '\u5df2\u542f\u7528',
          disabled: '\u5df2\u7981\u7528'
        },
        enableMemory: {
          label: '\u542f\u7528\u8bb0\u5fc6',
          description: '\u4f7f\u7528 LadybugDB\uff08\u5d4c\u5165\u5f0f\u6570\u636e\u5e93\uff09\u63d0\u4f9b\u6301\u4e45\u5316\u8de8\u4f1a\u8bdd\u8bb0\u5fc6'
        },
        disabledHint: '\u5f53\u524d\u4f7f\u7528\u57fa\u4e8e\u6587\u4ef6\u7684\u8bb0\u5fc6\u3002\u4f1a\u8bdd\u6d1e\u5bdf\u4f1a\u4ee5 JSON \u6587\u4ef6\u5f62\u5f0f\u4fdd\u5b58\u5728\u672c\u5730\u3002\u542f\u7528\u8bb0\u5fc6\u540e\uff0c\u53ef\u83b7\u5f97\u5e26\u8bed\u4e49\u641c\u7d22\u7684\u6301\u4e45\u5316\u8de8\u4f1a\u8bdd\u4e0a\u4e0b\u6587\u3002',
        embeddingProvider: {
          label: '\u5d4c\u5165\u63d0\u4f9b\u5546',
          description: '\u7528\u4e8e\u8bed\u4e49\u641c\u7d22\u7684\u63d0\u4f9b\u5546\uff08\u53ef\u9009\uff1b\u5373\u4f7f\u4e0d\u914d\u7f6e\uff0c\u5173\u952e\u8bcd\u641c\u7d22\u4ecd\u53ef\u4f7f\u7528\uff09',
          placeholder: '\u9009\u62e9\u5d4c\u5165\u63d0\u4f9b\u5546',
          options: {
            ollama: 'Ollama\uff08\u672c\u5730 - \u514d\u8d39\uff09'
          }
        },
        database: {
          nameLabel: '\u6570\u636e\u5e93\u540d\u79f0',
          nameDescription: '\u5b58\u50a8\u4e8e ~/.autocode/memories/',
          pathLabel: '\u6570\u636e\u5e93\u8def\u5f84\uff08\u53ef\u9009\uff09',
          pathDescription: '\u81ea\u5b9a\u4e49\u5b58\u50a8\u4f4d\u7f6e\u3002\u9ed8\u8ba4\uff1a~/.autocode/memories/'
        },
        placeholders: {
          openaiApiKey: 'sk-...',
          voyageApiKey: 'pa-...',
          voyageEmbeddingModel: 'voyage-3',
          googleApiKey: 'AIza...',
          azureApiKey: 'Azure API \u5bc6\u94a5',
          azureBaseUrl: 'https://your-resource.openai.azure.com',
          azureEmbeddingDeployment: 'text-embedding-ada-002',
          ollamaBaseUrl: 'http://localhost:11434'
        },
        providers: {
          shared: {
            getKeyFrom: '\u53ef\u5728 '
          },
          openai: {
            apiKeyLabel: 'OpenAI API \u5bc6\u94a5',
            overrideBadge: '\uff08\u8986\u76d6\uff09',
            usingGlobalKey: '\u4f7f\u7528\u5168\u5c40\u5bc6\u94a5',
            globalKeyDescription: '\u5f53\u524d\u4f7f\u7528\u5e94\u7528\u8bbe\u7f6e\u4e2d\u7684\u5bc6\u94a5\u3002\u4f60\u53ef\u4ee5\u5728\u4e0b\u65b9\u8f93\u5165\u9879\u76ee\u4e13\u7528\u5bc6\u94a5\u8fdb\u884c\u8986\u76d6\u3002',
            requiredDescription: 'OpenAI \u5d4c\u5165\u6240\u9700',
            overridePlaceholder: '\u8f93\u5165\u4ee5\u8986\u76d6\u5168\u5c40\u5bc6\u94a5...',
            hideKey: '\u9690\u85cf OpenAI API \u5bc6\u94a5',
            showKey: '\u663e\u793a OpenAI API \u5bc6\u94a5'
          },
          voyage: {
            apiKeyLabel: 'Voyage AI API \u5bc6\u94a5',
            requiredDescription: 'Voyage AI \u5d4c\u5165\u6240\u9700',
            hideKey: '\u9690\u85cf Voyage AI API \u5bc6\u94a5',
            showKey: '\u663e\u793a Voyage AI API \u5bc6\u94a5',
            embeddingModelLabel: '\u5d4c\u5165\u6a21\u578b\uff08\u53ef\u9009\uff09'
          },
          google: {
            apiKeyLabel: 'Google AI API \u5bc6\u94a5',
            requiredDescription: 'Google AI \u5d4c\u5165\u6240\u9700',
            hideKey: '\u9690\u85cf Google API \u5bc6\u94a5',
            showKey: '\u663e\u793a Google API \u5bc6\u94a5'
          },
          azure: {
            configurationTitle: 'Azure OpenAI \u914d\u7f6e',
            apiKeyLabel: 'API \u5bc6\u94a5',
            hideKey: '\u9690\u85cf Azure OpenAI API \u5bc6\u94a5',
            showKey: '\u663e\u793a Azure OpenAI API \u5bc6\u94a5',
            baseUrlLabel: '\u57fa\u7840 URL',
            embeddingDeploymentLabel: '\u5d4c\u5165\u90e8\u7f72\u540d\u79f0'
          },
          ollama: {
            baseUrlLabel: '\u57fa\u7840 URL',
            selectEmbeddingModel: '\u9009\u62e9\u5d4c\u5165\u6a21\u578b'
          }
        }
      }
    }
  }
} as const;
