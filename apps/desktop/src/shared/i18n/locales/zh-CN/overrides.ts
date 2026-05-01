export const zhCNCommonOverrides = {} as const;

export const zhCNSettingsOverrides = {
  projectSections: {
    yunxiao: {
      title: '\u4e91\u6548',
      description: '\u4e91\u6548\u96c6\u6210',
      integrationTitle: '\u4e91\u6548\u96c6\u6210',
      integrationDescription: '\u8fde\u63a5\u4e91\u6548\uff0c\u5bfc\u5165\u9879\u76ee\u4e0e\u5de5\u4f5c\u9879',
      syncDescription: '\u4e0e\u4e91\u6548\u5de5\u4f5c\u9879\u540c\u6b65'
    },
    gitblit: {
      title: 'GitBlit',
      description: 'GitBlit \u5de5\u5355\u6d41\u7a0b',
      integrationTitle: 'GitBlit \u5f00\u53d1\u6d41\u7a0b',
      integrationDescription: '\u5c06\u5de5\u4f5c\u6811\u53d8\u66f4\u63d0\u4ea4\u4e3a GitBlit \u5de5\u5355\u4e0e patchset',
      syncDescription: '\u914d\u7f6e\u57fa\u4e8e GitBlit \u5de5\u5355\u7684\u8bc4\u5ba1\u63d0\u4ea4',
      enable: {
        label: '\u542f\u7528 GitBlit \u5de5\u4f5c\u6d41',
        description: '\u4f7f\u7528 GitBlit \u5de5\u5355\u63d0\u4ea4\u4f5c\u4e3a\u4efb\u52a1\u8bc4\u5ba1\u6d41\u7a0b'
      },
      baseUrl: {
        label: 'GitBlit \u57fa\u7840 URL',
        description: '\u53ef\u9009\uff0c\u7528\u4e8e\u89e3\u6790 GitBlit \u5de5\u5355\u94fe\u63a5\u4e0e\u63d0\u793a\u4fe1\u606f'
      },
      repo: {
        label: '\u4ed3\u5e93\u8def\u5f84',
        description: '\u53ef\u9009\uff0c\u4f8b\u5982\uff1ateam/repository.git'
      },
      workflow: {
        title: '\u5de5\u4f5c\u65b9\u5f0f',
        description: 'GitBlit \u7684\u8bc4\u5ba1\u63d0\u4ea4\u57fa\u4e8e\u5de5\u5355\u3002Autocode \u4f1a\u5148\u521b\u5efa GitBlit proposal \u5de5\u5355\uff0c\u4e4b\u540e\u5728\u5df2\u77e5\u5de5\u5355 ID \u65f6\u66f4\u65b0 patchset\u3002',
        create: '\u65b0\u7684\u8bc4\u5ba1\u8bf7\u6c42\u4f1a\u63d0\u4ea4\u5230 refs/for/<branch>\u3002',
        update: '\u5f53\u4efb\u52a1\u5df2\u7ed1\u5b9a GitBlit \u5de5\u5355\u540e\uff0c\u540e\u7eed\u63d0\u4ea4\u4f1a\u590d\u7528 refs/for/<ticket>\u3002'
      }
    }
  }
} as const;

export const zhCNTasksOverrides = {} as const;

export const zhCNTaskReviewOverrides = {} as const;

export const zhCNOnboardingOverrides = {} as const;
