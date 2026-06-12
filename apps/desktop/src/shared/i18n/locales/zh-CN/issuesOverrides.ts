export const zhCNIssuesOverrides = {
  issues: {
    title: 'GitHub 问题',
    states: {
      open: '未关闭',
      closed: '已关闭'
    },
    complexity: {
      simple: '简单',
      standard: '标准',
      complex: '复杂'
    },
    header: {
      openCount: '{{count}} 个未关闭',
      analyzeAndGroup: '分析并分组问题',
      analyzeAndGroupTooltip: '最多分析 200 个未关闭问题，对相似问题进行分组，并在创建任务前审查建议批次。',
      autoFixNew: '自动修复新问题',
      autoFixTooltip: '在新问题出现时自动尝试修复。',
      processingCount: '正在处理 {{count}} 个问题...',
      processingCount_plural: '正在处理 {{count}} 个问题...',
      searchPlaceholder: '搜索问题...'
    },
    filters: {
      open: '未关闭',
      closed: '已关闭',
      all: '全部'
    },
    empty: {
      noMatch: '没有问题匹配你的搜索',
      noIssues: '未找到问题',
      selectIssue: '选择一个问题以查看详情'
    },
    notConnected: {
      title: 'GitHub 未连接',
      description: '请在项目设置中配置 GitHub 令牌和仓库，以同步问题。',
      openSettings: '打开设置'
    },
    detail: {
      commentCount: '{{count}} 条评论',
      commentCount_plural: '{{count}} 条评论',
      viewTask: '查看任务',
      createTask: '创建任务',
      taskLinked: '已关联任务',
      taskId: '任务 ID',
      description: '描述',
      noDescription: '未提供描述。',
      assignees: '指派对象',
      milestone: '里程碑'
    },
    investigation: {
      title: '从问题创建任务',
      issuePrefix: '问题',
      description: '从这个 GitHub 问题创建任务。任务会添加到你的看板 Backlog 列中。',
      selectComments: '选择要包含的评论',
      deselectAll: '全部取消',
      selectAll: '全部选择',
      willInclude: '任务将包含：',
      includeTitle: '问题标题和描述',
      includeLink: '指向 GitHub 问题的链接',
      includeLabels: '问题的标签和元数据',
      noComments: '无评论（该问题没有评论）',
      failedToLoadComments: '加载评论失败',
      taskCreated: '任务已创建！可在你的看板中查看。',
      creating: '正在创建...',
      cancel: '取消',
      done: '完成',
      progress: {
        fetching: '正在获取问题详情...',
        analyzing: 'AI 正在分析该问题...',
        creatingTask: '正在根据调查结果创建任务...',
        complete: '调查完成！'
      }
    },
    batchReview: {
      title: '分析并分组问题',
      descriptions: {
        intro: '分析未关闭问题并将相似问题分组以进行批处理。',
        analyzing: '正在分析问题的语义相似度...',
        review: '审查并批准建议的问题批次。',
        approving: '正在创建已批准的批次...',
        done: '批次已成功创建。'
      },
      introTitle: '分析并分组问题',
      introDescription: '这会分析最多 200 个未关闭问题，将相似问题归为一组，并在创建任何任务前让你审查建议批次。',
      startAnalysis: '开始分析',
      analyzingTitle: '正在分析问题...',
      analyzingFallback: '正在计算相似度并验证批次...',
      progressComplete: '{{progress}}% 完成',
      stats: {
        issuesAnalyzed: '个问题已分析',
        batchesProposed: '个建议批次',
        singleIssues: '个单独问题'
      },
      selectAll: '全部选择',
      deselectAll: '全部取消',
      singleIssuesTitle: '单独问题（未分组）',
      andMore: '...以及另外 {{count}} 个',
      selectionSummary: '已选择 {{count}} 个批次（{{issueCount}} 个问题）',
      selectionSummary_plural: '已选择 {{count}} 个批次（{{issueCount}} 个问题）',
      selectedSingleIssues: '+ {{count}} 个单独问题',
      selectedSingleIssues_plural: '+ {{count}} 个单独问题',
      approvingTitle: '正在创建批次...',
      approvingDescription: '正在为已批准的问题批次建立处理配置。',
      doneTitle: '批次已创建',
      doneDescription: '你选择的问题批次已可开始处理。',
      close: '关闭',
      cancel: '取消',
      creating: '正在创建...',
      approveCreate: '批准并创建（{{count}} 个批次）',
      approveCreate_plural: '批准并创建（{{count}} 个批次）',
      batchTitle: '批次 {{number}}',
      issueCount: '{{count}} 个问题',
      issueCount_plural: '{{count}} 个问题',
      similarity: '{{percent}}% 相似',
      progress: {
        fetching: '正在获取用于分析的问题...',
        analyzingCount: '正在分析 {{count}} 个问题...'
      }
    },
    taskGeneration: {
      approveFailed: '批准批次失败',
      singleIssueReasoning: '单个问题 - 未与其他问题分组',
      singleIssueTitle: 'GitHub 问题 #{{number}}：{{title}}',
      batchTitle: 'GitHub 问题：{{theme}}',
      noCommonThemes: '无',
      batchDescription: '**本批次中的问题：**\n{{issueList}}\n\n**共同主题：** {{commonThemes}}\n\n**推理依据：** {{reasoning}}'
    },
    autoFix: {
      button: '自动修复',
      retry: '重试自动修复',
      failed: '自动修复失败',
      specCreated: '已根据该问题创建规格',
      processing: '处理中...',
      progress: {
        fetchingIssue: '正在获取问题 #{{issueNumber}}...',
        analyzingIssue: '正在分析问题...',
        creatingSpec: '正在根据问题创建标准规划...',
        startingSpecCreation: '正在启动标准规划...',
        started: '自动修复标准规划已启动！',
        specReady: '标准规划目录已创建。点击“开始”继续。'
      }
    }
  }
} as const;
