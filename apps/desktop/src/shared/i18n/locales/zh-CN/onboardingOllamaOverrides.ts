export const zhCNOnboardingOllamaOverrides = {
  ollama: {
    selector: {
      checkingModels: '\u6b63\u5728\u68c0\u67e5 Ollama \u6a21\u578b...',
      badges: {
        recommended: '\u63a8\u8350',
        quality: '\u6700\u9ad8\u8d28\u91cf',
        fast: '\u6700\u5feb',
        installed: '\u5df2\u5b89\u88c5'
      },
      actions: {
        download: '\u4e0b\u8f7d',
        downloading: '\u4e0b\u8f7d\u4e2d...',
        startingDownload: '\u6b63\u5728\u5f00\u59cb\u4e0b\u8f7d...'
      },
      descriptions: {
        qwen3Embedding4b: 'Qwen3 4B - \u8d28\u91cf\u4e0e\u901f\u5ea6\u5747\u8861',
        qwen3Embedding8b: 'Qwen3 8B - \u6700\u4f73 Embedding \u8d28\u91cf',
        qwen3Embedding06b: 'Qwen3 0.6B - \u4f53\u79ef\u6700\u5c0f\uff0c\u901f\u5ea6\u6700\u5feb',
        embeddinggemma: 'Google \u7684\u8f7b\u91cf Embedding \u6a21\u578b',
        nomicEmbedText: '\u901a\u7528\u578b Embedding \u6a21\u578b'
      },
      helpText: '\u9009\u62e9\u5df2\u5b89\u88c5\u7684\u6a21\u578b\u7528\u4e8e\u8bed\u4e49\u641c\u7d22\u3002\u5373\u4f7f\u6ca1\u6709 Embedding\uff0cMemory \u4ecd\u53ef\u901a\u8fc7\u5173\u952e\u8bcd\u641c\u7d22\u5de5\u4f5c\u3002',
      errors: {
        checkFailed: '\u68c0\u67e5 Ollama \u6a21\u578b\u5931\u8d25',
        installFailed: '\u542f\u52a8 Ollama \u5b89\u88c5\u5931\u8d25',
        downloadFailed: '\u4e0b\u8f7d\u5931\u8d25'
      }
    }
  }
} as const;
