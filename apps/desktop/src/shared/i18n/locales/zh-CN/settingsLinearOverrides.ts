export const zhCNSettingsLinearOverrides = {
  projectSections: {
    linear: {
      enableSync: {
        label: '启用 Linear 同步',
        description: '自动创建并更新 Linear 问题'
      },
      apiKey: {
        label: 'API Key',
        helpPrefix: '可在 ',
        helpLink: 'Linear 设置',
        helpSuffix: ' 中获取 API Key'
      },
      connectionStatus: {
        title: '连接状态',
        checking: '检查中...',
        connected: '已连接',
        connectedToTeam: '已连接到 {{teamName}}',
        notConnected: '未连接',
        importableTasks: '{{issueCount}}+ 个任务可导入'
      },
      importExisting: {
        title: '导入现有任务',
        description: '选择要导入到 AutoBuild 中作为任务的 Linear 问题。',
        button: '从 Linear 导入任务'
      },
      realtimeSync: {
        label: '实时同步',
        description: '自动导入在 Linear 中新建的任务',
        warning:
          '启用后，新的 Linear 问题会自动导入到 AutoBuild。请在下方配置团队/项目筛选条件，以控制要导入的问题。'
      },
      filters: {
        teamId: '团队 ID（可选）',
        projectId: '项目 ID（可选）',
        autoDetected: '自动检测',
        autoCreated: '自动创建'
      }
    }
  }
} as const;
