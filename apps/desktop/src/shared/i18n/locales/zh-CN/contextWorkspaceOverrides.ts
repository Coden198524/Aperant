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
    tabs: {
      projectDocuments: '\u9879\u76ee\u6587\u6863'
    },
    actions: {
      projectDocs: '\u751f\u6210\u6587\u6863',
      projectDocsTooltip: '\u751f\u6210\u6216\u5237\u65b0\u672c\u9879\u76ee\u7684\u6587\u6863\u53c2\u8003\u5305'
    },
    projectDocuments: {
      title: '\u9879\u76ee\u6587\u6863',
      refresh: '\u5237\u65b0\u6587\u6863',
      noProjectPath: '\u672a\u627e\u5230\u9879\u76ee\u8def\u5f84',
      emptyTitle: '\u6682\u65e0\u9879\u76ee\u6587\u6863',
      emptyDescription: '\u751f\u6210\u9879\u76ee\u6587\u6863\u53c2\u8003\u5305\u540e\uff0c\u53ef\u5728\u8fd9\u91cc\u9605\u8bfb\u4ea7\u54c1\u3001\u67b6\u6784\u548c\u6280\u672f\u4e0a\u4e0b\u6587\u3002',
      emptyList: '\u5c1a\u672a\u751f\u6210\u6587\u6863',
      files: {
        index: '\u7d22\u5f15',
        product: '\u4ea7\u54c1',
        architecture: '\u67b6\u6784',
        technical: '\u6280\u672f',
        outline: '\u5927\u7eb2',
        evidence: '\u8bc1\u636e'
      },
      descriptions: {
        index: '\u6587\u6863\u5165\u53e3\u548c\u76ee\u5f55',
        product: '\u4ea7\u54c1\u80cc\u666f\u3001\u53d7\u4f17\u3001\u76ee\u6807\u548c\u6d41\u7a0b',
        architecture: '\u7cfb\u7edf\u7ed3\u6784\u3001\u8fb9\u754c\u548c\u8fd0\u884c\u62d3\u6251',
        technical: '\u5b9e\u73b0\u7ec6\u8282\u3001\u547d\u4ee4\u3001\u98ce\u9669\u548c\u7ea6\u5b9a',
        outline: 'Agent \u4f7f\u7528\u7684\u7ed3\u6784\u5316\u5927\u7eb2',
        evidence: '\u6e90\u6587\u4ef6\u5f15\u7528\u3001\u8bc1\u636e\u3001\u98ce\u9669\u548c\u5f00\u653e\u95ee\u9898'
      },
      errors: {
        listFailed: '\u52a0\u8f7d\u9879\u76ee\u6587\u6863\u5931\u8d25',
        listFailedTitle: '\u65e0\u6cd5\u52a0\u8f7d\u6587\u6863',
        readFailed: '\u8bfb\u53d6\u6587\u6863\u5931\u8d25',
        readFailedTitle: '\u65e0\u6cd5\u8bfb\u53d6\u6587\u6863'
      }
    },
    projectIndex: {
      title: '项目结构',
      description: 'AI 发现的代码库结构知识',
      loadFailed: '加载项目索引失败',
      emptyTitle: '项目索引已移除',
      emptyDescription: '项目结构上下文现在由项目文档参考包提供。',
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
