export const zhCNSettingsGeneralOverrides = {
  projectSections: {
    general: {
      autoBuild: {
        title: 'Auto-Build \u96c6\u6210',
        notInitializedTitle: '\u672a\u521d\u59cb\u5316',
        notInitializedDescription: '\u5148\u521d\u59cb\u5316 Auto-Build\uff0c\u624d\u80fd\u542f\u7528\u4efb\u52a1\u521b\u5efa\u548c\u667a\u80fd\u4f53\u5de5\u4f5c\u6d41\u3002',
        initialize: '\u521d\u59cb\u5316 Auto-Build',
        initializing: '\u521d\u59cb\u5316\u4e2d...',
        initialized: '\u5df2\u521d\u59cb\u5316',
        checkingStatus: '\u6b63\u5728\u68c0\u67e5\u72b6\u6001...'
      },
      agentConfiguration: '\u667a\u80fd\u4f53\u914d\u7f6e',
      initializeFirstToConfigure: '\u8bf7\u5148\u521d\u59cb\u5316 Auto-Build\uff0c\u518d\u914d\u7f6e{{title}}'
    }
  }
} as const;
