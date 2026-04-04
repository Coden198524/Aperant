export const zhCNContextWorkspaceOverrides = {
  workspaceModal: {
    title: '创建工作区',
    description: '将相关项目归为一组，用于跨仓库规格说明和校验。',
    name: '名称',
    namePlaceholder: '我的应用工作区',
    descriptionLabel: '描述（可选）',
    descriptionPlaceholder: '例如：我的应用的后端、前端和移动端项目',
    projects: '项目',
    addProject: '添加项目...',
    allProjectsAdded: '所有项目均已添加',
    noProjectsAvailable: '没有可用项目',
    create: '创建工作区',
    creating: '创建中...',
    errors: {
      nameRequired: '工作区名称不能为空',
      apiUnavailable: '工作区 API 不可用',
      createFailed: '创建工作区失败'
    },
    roles: {
      backend: {
        label: '后端',
        description: 'API 服务、后端服务'
      },
      frontend: {
        label: '前端',
        description: 'Web 应用'
      },
      mobile: {
        label: '移动端',
        description: '移动应用'
      },
      shared: {
        label: '共享',
        description: '共享类型/工具'
      },
      api: {
        label: 'API 网关',
        description: '网关、BFF'
      },
      worker: {
        label: 'Worker',
        description: '后台任务'
      },
      other: {
        label: '其他',
        description: '其他项目类型'
      }
    }
  },
  context: {
    projectIndex: {
      title: '项目结构',
      description: 'AI 发现的代码库结构知识',
      refresh: '刷新',
      refreshTooltip: '重新分析项目结构',
      loadFailed: '加载项目索引失败',
      emptyTitle: '未找到项目索引',
      emptyDescription: '点击刷新按钮以分析项目结构并创建索引。',
      analyzeProject: '分析项目',
      overview: '概览',
      services: '服务',
      infrastructure: '基础设施',
      conventions: '约定',
      serviceCount: '{{count}} 个服务',
      projectTypes: {
        single: '单仓库',
        monorepo: '多包仓库'
      },
      serviceTypes: {
        backend: '后端',
        frontend: '前端',
        worker: 'Worker',
        scraper: '爬虫',
        library: '库',
        proxy: '代理',
        mobile: '移动端',
        desktop: '桌面端',
        unknown: '未知'
      },
      labels: {
        dockerCompose: 'Docker Compose',
        ci: 'CI/CD',
        deployment: '部署',
        dockerServices: 'Docker 服务',
        pythonLinting: 'Python Lint',
        jsLinting: 'JS Lint',
        formatting: '格式化',
        gitHooks: 'Git Hooks',
        typescript: 'TypeScript',
        enabled: '已启用',
        testing: '测试',
        orm: 'ORM',
        port: '端口',
        styling: '样式方案',
        state: '状态管理',
        appleFrameworks: 'Apple 框架',
        spmDependencies: 'SPM 依赖',
        keyDirectories: '关键目录',
        environmentVariables: '环境变量',
        apiRoutes: 'API 路由',
        databaseModels: '数据库模型',
        externalServices: '外部服务',
        databases: '数据库',
        email: '邮件',
        payments: '支付',
        cache: '缓存',
        monitoring: '监控',
        metrics: '指标',
        health: '健康检查',
        dependencies: '依赖',
        fields: '{{count}} 个字段',
        more: '另有 {{count}} 项'
      }
    }
  },
  memory: {
    search: {
      score: '评分'
    },
    noAdditionalDetails: '没有更多详细信息。'
  }
} as const;
