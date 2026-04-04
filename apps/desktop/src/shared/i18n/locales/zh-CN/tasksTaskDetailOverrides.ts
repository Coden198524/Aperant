export const zhCNTasksTaskDetailOverrides = {
  detail: {
    resumeBlockedTitle: '\u65e0\u6cd5\u7ee7\u7eed\u4efb\u52a1',
    resumeBlockedDescription:
      '\u52a0\u8f7d\u5b9e\u73b0\u8ba1\u5212\u5931\u8d25\u3002\u8bf7\u91cd\u8bd5\uff0c\u6216\u68c0\u67e5\u4efb\u52a1\u6587\u4ef6\u3002',
    deleteFailed: '\u5220\u9664\u4efb\u52a1\u5931\u8d25',
    changesStaged: '\u53d8\u66f4\u5df2\u6682\u5b58\u5230\u4e3b\u9879\u76ee',
    mergeFailed: '\u5408\u5e76\u53d8\u66f4\u5931\u8d25',
    mergeUnknownError: '\u5408\u5e76\u8fc7\u7a0b\u4e2d\u53d1\u751f\u672a\u77e5\u9519\u8bef',
    discardFailed: '\u4e22\u5f03\u53d8\u66f4\u5931\u8d25',
    loadingPlan: '\u52a0\u8f7d\u8ba1\u5212\u4e2d...',
    subtasksSummary: '{{completed}}/{{total}} \u4e2a\u5b50\u4efb\u52a1',
    completedSuccessfully: '\u4efb\u52a1\u5df2\u6210\u529f\u5b8c\u6210',
    tabs: {
      overview: '\u6982\u89c8',
      subtasks: '\u5b50\u4efb\u52a1\uff08{{count}}\uff09',
      logs: '\u65e5\u5fd7'
    }
  },
  execution: {
    phases: {
      idle: '\u7a7a\u95f2',
      planning: '\u89c4\u5212\u4e2d',
      coding: '\u7f16\u7801\u4e2d',
      rate_limit_paused: '\u89e6\u53d1\u9891\u7387\u9650\u5236',
      auth_failure_paused: '\u9700\u8981\u8ba4\u8bc1',
      qa_review: 'AI \u5ba1\u67e5\u4e2d',
      qa_fixing: '\u4fee\u590d\u95ee\u9898\u4e2d',
      complete: '\u5df2\u5b8c\u6210',
      failed: '\u5931\u8d25'
    }
  },
  metadata: {
    severity: '\u4e25\u91cd\u7ea7\u522b',
    created: '\u521b\u5efa',
    updated: '\u66f4\u65b0',
    rationale: '\u7406\u7531',
    problemSolved: '\u89e3\u51b3\u95ee\u9898',
    targetAudience: '\u76ee\u6807\u7528\u6237',
    dependencies: '\u4f9d\u8d56',
    acceptanceCriteria: '\u9a8c\u6536\u6807\u51c6',
    affectedFiles: '\u53d7\u5f71\u54cd\u6587\u4ef6',
    sourceTypes: {
      manual: '\u624b\u52a8\u521b\u5efa',
      imported: '\u5bfc\u5165',
      insights: '\u6d1e\u5bdf',
      roadmap: '\u8def\u7ebf\u56fe',
      linear: 'Linear',
      github: 'GitHub',
      gitlab: 'GitLab'
    },
    severityValues: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8',
      critical: '\u5173\u952e'
    }
  },
  form: {
    classification: {
      values: {
        category: {
          feature: '\u529f\u80fd',
          bug_fix: 'Bug \u4fee\u590d',
          refactoring: '\u91cd\u6784',
          documentation: '\u6587\u6863',
          security: '\u5b89\u5168',
          performance: '\u6027\u80fd',
          ui_ux: 'UI/UX',
          infrastructure: '\u57fa\u7840\u8bbe\u65bd',
          testing: '\u6d4b\u8bd5'
        },
        priority: {
          low: '\u4f4e',
          medium: '\u4e2d',
          high: '\u9ad8',
          urgent: '\u7d27\u6025'
        },
        complexity: {
          trivial: '\u6781\u7b80',
          small: '\u5c0f',
          medium: '\u4e2d',
          large: '\u5927',
          complex: '\u590d\u6742'
        },
        impact: {
          low: '\u4f4e\u5f71\u54cd',
          medium: '\u4e2d\u7b49\u5f71\u54cd',
          high: '\u9ad8\u5f71\u54cd',
          critical: '\u5173\u952e\u5f71\u54cd'
        }
      }
    }
  }
} as const;
