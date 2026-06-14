export const zhCNIdeationRoadmapOverrides = {
  labels: {
    draft: '\u8349\u7a3f',
    active: '\u8fdb\u884c\u4e2d',
    archived: '\u5df2\u5f52\u6863'
  },
  ideation: {
    converting: '\u8f6c\u6362\u4e2d...',
    convertToTask: '\u8f6c\u4e3a Auto-Build \u4efb\u52a1',
    dismissIdea: '\u5ffd\u7565\u521b\u610f',
    description: '\u63cf\u8ff0',
    rationale: '\u7406\u7531',
    goToTask: '\u8f6c\u5230\u4efb\u52a1',
    conversionFailed: '\u8f6c\u6362\u5931\u8d25',
    conversionFailedDescription: '\u65e0\u6cd5\u5c06\u521b\u610f\u8f6c\u6362\u4e3a\u4efb\u52a1',
    conversionError: '\u8f6c\u6362\u51fa\u9519',
    conversionErrorDescription: '\u8f6c\u6362\u521b\u610f\u65f6\u53d1\u751f\u9519\u8bef',
    header: {
      ideaCount: '{{count}} \u4e2a\u521b\u610f',
      description: '\u57fa\u4e8e\u4f60\u7684\u9879\u76ee\u4e0a\u4e0b\u6587\u7531 AI \u751f\u6210\u7684\u529f\u80fd\u521b\u610f'
    },
    actions: {
      addMore: '\u6dfb\u52a0\u66f4\u591a',
      generateIdeas: '\u751f\u6210\u521b\u610f'
    },
    filters: {
      code: '\u4ee3\u7801',
      uiux: 'UI/UX',
      docs: '\u6587\u6863',
      security: '\u5b89\u5168',
      performance: '\u6027\u80fd'
    },
    empty: {
      title: '\u6682\u65e0\u521b\u610f',
      description:
        '\u57fa\u4e8e\u9879\u76ee\u4e0a\u4e0b\u6587\u3001\u73b0\u6709\u6a21\u5f0f\u548c\u76ee\u6807\u7528\u6237\uff0c\u751f\u6210 AI \u9a71\u52a8\u7684\u529f\u80fd\u521b\u610f\u3002',
      enabledTypes: '\u5df2\u542f\u7528\u7684\u521b\u610f\u7c7b\u578b',
      noVisibleIdeas: '\u6ca1\u6709\u53ef\u663e\u793a\u7684\u521b\u610f'
    },
    dialogs: {
      config: {
        title: '\u521b\u610f\u914d\u7f6e',
        description: '\u914d\u7f6e\u8981\u751f\u6210\u7684\u521b\u610f\u7c7b\u578b',
        typesTitle: '\u521b\u610f\u7c7b\u578b',
        contextTitle: '\u4e0a\u4e0b\u6587\u6765\u6e90',
        includeRoadmap: '\u5305\u542b\u8def\u7ebf\u56fe\u4e0a\u4e0b\u6587',
        includeKanban: '\u5305\u542b Kanban \u4e0a\u4e0b\u6587'
      },
      addMore: {
        title: '\u6dfb\u52a0\u66f4\u591a\u521b\u610f',
        description:
          '\u9009\u62e9\u8981\u989d\u5916\u751f\u6210\u7684\u521b\u610f\u7c7b\u578b\uff0c\u5df2\u6709\u521b\u610f\u4f1a\u88ab\u4fdd\u7559\u3002',
        noneLeftTitle: '\u4f60\u5df2\u7ecf\u751f\u6210\u4e86\u6240\u6709\u521b\u610f\u7c7b\u578b\uff01',
        noneLeftDescription:
          '\u4f7f\u7528\u201c\u91cd\u65b0\u751f\u6210\u201d\u53ef\u4ee5\u5237\u65b0\u5f53\u524d\u7684\u521b\u610f\u3002',
        generateTypes: '\u751f\u6210 {{count}} \u79cd\u7c7b\u578b'
      }
    },
    generation: {
      title: '\u751f\u6210\u521b\u610f\u4e2d',
      completeCount: '\u5df2\u5b8c\u6210 {{completed}}/{{total}}',
      hideLogs: '\u9690\u85cf\u65e5\u5fd7',
      showLogs: '\u663e\u793a\u65e5\u5fd7',
      waitingToStart: '\u7b49\u5f85\u5f00\u59cb...',
      failedCategory: '\u8be5\u5206\u7c7b\u7684\u521b\u610f\u751f\u6210\u5931\u8d25',
      emptyCategory: '\u8be5\u5206\u7c7b\u672a\u751f\u6210\u4efb\u4f55\u521b\u610f'
    },
    types: {
      code_improvements: {
        label: '\u4ee3\u7801\u6539\u8fdb',
        description:
          '\u57fa\u4e8e\u6a21\u5f0f\u3001\u67b6\u6784\u548c\u57fa\u7840\u8bbe\u65bd\u5206\u6790\u63ed\u793a\u7684\u4ee3\u7801\u673a\u4f1a'
      },
      ui_ux_improvements: {
        label: 'UI/UX \u6539\u8fdb',
        description: '\u901a\u8fc7\u5e94\u7528\u5206\u6790\u53d1\u73b0\u7684\u89c6\u89c9\u548c\u4ea4\u4e92\u4f18\u5316\u673a\u4f1a'
      },
      documentation_gaps: {
        label: '\u6587\u6863',
        description: '\u9700\u8981\u8865\u5145\u6216\u66f4\u65b0\u7684\u7f3a\u5931/\u8fc7\u65f6\u6587\u6863'
      },
      security_hardening: {
        label: '\u5b89\u5168',
        description: '\u5b89\u5168\u6f0f\u6d1e\u4e0e\u52a0\u56fa\u673a\u4f1a'
      },
      performance_optimizations: {
        label: '\u6027\u80fd',
        description: '\u6027\u80fd\u74f6\u9888\u4e0e\u4f18\u5316\u673a\u4f1a'
      },
      code_quality: {
        label: '\u4ee3\u7801\u8d28\u91cf',
        description:
          '\u91cd\u6784\u673a\u4f1a\u3001\u5927\u6587\u4ef6\u3001\u4ee3\u7801\u5f02\u5473\u4ee5\u53ca\u6700\u4f73\u5b9e\u8df5\u8fdd\u89c4'
      }
    },
    status: {
      draft: '\u8349\u7a3f',
      selected: '\u5df2\u9009\u4e2d',
      converted: '\u5df2\u8f6c\u6362',
      dismissed: '\u5df2\u5ffd\u7565',
      archived: '\u5df2\u5f52\u6863'
    },
    effort: {
      trivial: '\u6781\u4f4e',
      small: '\u5c0f',
      medium: '\u4e2d',
      large: '\u5927',
      complex: '\u590d\u6742'
    },
    impact: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8',
      critical: '\u5173\u952e'
    },
    priority: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8'
    },
    categories: {
      uiux: {
        usability: '\u6613\u7528\u6027',
        accessibility: '\u65e0\u969c\u788d',
        performance: '\u6027\u80fd',
        visual: '\u89c6\u89c9\u8bbe\u8ba1',
        interaction: '\u4ea4\u4e92'
      },
      documentation: {
        readme: 'README',
        api_docs: 'API \u6587\u6863',
        inline_comments: '\u884c\u5185\u6ce8\u91ca',
        examples: '\u793a\u4f8b\u4e0e\u6559\u7a0b',
        architecture: '\u67b6\u6784\u6587\u6863',
        troubleshooting: '\u6545\u969c\u6392\u67e5\u6307\u5357'
      },
      security: {
        authentication: '\u8ba4\u8bc1',
        authorization: '\u6388\u6743',
        input_validation: '\u8f93\u5165\u6821\u9a8c',
        data_protection: '\u6570\u636e\u4fdd\u62a4',
        dependencies: '\u4f9d\u8d56',
        configuration: '\u914d\u7f6e',
        secrets_management: '\u5bc6\u94a5\u7ba1\u7406'
      },
      performance: {
        bundle_size: '\u5305\u4f53\u79ef',
        runtime: '\u8fd0\u884c\u65f6\u6027\u80fd',
        memory: '\u5185\u5b58\u5360\u7528',
        database: '\u6570\u636e\u5e93\u67e5\u8be2',
        network: '\u7f51\u7edc\u8bf7\u6c42',
        rendering: '\u6e32\u67d3',
        caching: '\u7f13\u5b58'
      },
      codeQuality: {
        large_files: '\u5927\u6587\u4ef6',
        code_smells: '\u4ee3\u7801\u5f02\u5473',
        complexity: '\u9ad8\u590d\u6742\u5ea6',
        duplication: '\u4ee3\u7801\u91cd\u590d',
        naming: '\u547d\u540d\u89c4\u8303',
        structure: '\u6587\u4ef6\u7ed3\u6784',
        linting: 'Lint \u95ee\u9898',
        testing: '\u6d4b\u8bd5\u8986\u76d6',
        types: '\u7c7b\u578b\u5b89\u5168',
        dependencies: '\u4f9d\u8d56\u95ee\u9898',
        dead_code: '\u65e0\u7528\u4ee3\u7801',
        git_hygiene: 'Git \u536b\u751f'
      }
    },
    audience: {
      developers: '\u5f00\u53d1\u8005',
      users: '\u7528\u6237',
      contributors: '\u8d21\u732e\u8005',
      maintainers: '\u7ef4\u62a4\u8005'
    },
    severity: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8',
      critical: '\u5173\u952e'
    },
    codeQualitySeverity: {
      suggestion: '\u5efa\u8bae',
      minor: '\u8f7b\u5fae',
      major: '\u4e25\u91cd',
      critical: '\u5173\u952e'
    },
    detail: {
      effort: '\u5de5\u4f5c\u91cf',
      files: '\u6587\u4ef6\u6570',
      buildsUpon: '\u57fa\u4e8e',
      implementationApproach: '\u5b9e\u73b0\u65b9\u6848',
      affectedFiles: '\u53d7\u5f71\u54cd\u6587\u4ef6',
      patternsToFollow: '\u53ef\u53c2\u8003\u7684\u6a21\u5f0f',
      currentState: '\u5f53\u524d\u72b6\u6001',
      proposedChange: '\u5efa\u8bae\u53d8\u66f4',
      userBenefit: '\u7528\u6237\u4ef7\u503c',
      affectedComponents: '\u53d7\u5f71\u54cd\u7ec4\u4ef6',
      category: '\u5206\u7c7b',
      targetAudience: '\u76ee\u6807\u53d7\u4f17',
      currentDocumentation: '\u5f53\u524d\u6587\u6863',
      proposedContent: '\u5efa\u8bae\u5185\u5bb9',
      affectedAreas: '\u53d7\u5f71\u54cd\u533a\u57df',
      priority: '\u4f18\u5148\u7ea7',
      severity: '\u4e25\u91cd\u7ea7\u522b',
      vulnerability: '\u6f0f\u6d1e',
      currentRisk: '\u5f53\u524d\u98ce\u9669',
      remediation: '\u4fee\u590d\u65b9\u6848',
      references: '\u53c2\u8003\u8d44\u6599',
      compliance: '\u5408\u89c4',
      impact: '\u5f71\u54cd',
      expectedImprovement: '\u9884\u671f\u6539\u5584',
      implementation: '\u5b9e\u73b0',
      tradeoffs: '\u6743\u8861',
      breakingChange: '\u7834\u574f\u6027\u53d8\u66f4',
      breakingChangeDescription: '\u7834\u574f\u6027\u53d8\u66f4\u8bf4\u660e',
      codeExample: '\u4ee3\u7801\u793a\u4f8b',
      metrics: '\u6307\u6807',
      lines: '\u884c\u6570',
      complexity: '\u590d\u6742\u5ea6',
      duplicateLines: '\u91cd\u590d\u884c',
      testCoverage: '\u6d4b\u8bd5\u8986\u76d6\u7387',
      bestPractice: '\u6700\u4f73\u5b9e\u8df5',
      prerequisites: '\u524d\u7f6e\u6761\u4ef6',
      impactValue: '{{value}} \u5f71\u54cd'
    }
  },
  roadmap: {
    taskCompleted: '\u5df2\u5b8c\u6210',
    taskDeleted: '\u5df2\u5220\u9664',
    taskArchived: '\u5df2\u5f52\u6863',
    showMoreFeatures: '\u663e\u793a\u53e6\u5916 {{count}} \u4e2a\u529f\u80fd',
    showLessFeatures: '\u6536\u8d77',
    archiveFeature: '\u5f52\u6863',
    goToTask: '\u8f6c\u5230\u4efb\u52a1',
    convertToTask: '\u8f6c\u4e3a Auto-Build \u4efb\u52a1',
    build: '\u6784\u5efa',
    task: '\u4efb\u52a1',
    viewTask: '\u67e5\u770b\u4efb\u52a1',
    actions: {
      addFeature: '\u6dfb\u52a0\u529f\u80fd',
      generateRoadmap: '\u751f\u6210\u8def\u7ebf\u56fe'
    },
    tooltips: {
      addFeature: '\u5411\u8def\u7ebf\u56fe\u4e2d\u6dfb\u52a0\u65b0\u529f\u80fd',
      competitorInsight: '\u8be5\u529f\u80fd\u9488\u5bf9\u4e86\u7ade\u54c1\u75db\u70b9',
      votes: '\u6765\u81ea\u7528\u6237\u53cd\u9988\u7684 {{count}} \u7968',
      importedFrom: '\u4ece {{provider}} \u5bfc\u5165'
    },
    header: {
      competitorAnalysisTooltipTitle: '\u70b9\u51fb\u67e5\u770b\u8be6\u7ec6\u5206\u6790',
      competitorAnalysisTooltipDescription:
        '\u5df2\u5206\u6790 {{competitors}} \u4e2a\u7ade\u54c1\uff0c\u8bc6\u522b\u51fa {{painPoints}} \u4e2a\u75db\u70b9',
      target: '\u76ee\u6807\u7528\u6237\uff1a',
      morePersonas: '\u53e6\u6709 {{count}} \u4e2a\u7528\u6237\u753b\u50cf',
      secondaryPersonas: '\u6b21\u8981\u7528\u6237\u753b\u50cf\uff1a',
      features: '\u4e2a\u529f\u80fd',
      phases: '\u4e2a\u9636\u6bb5',
      featureCount: '{{count}} \u4e2a\u529f\u80fd'
    },
    tabs: {
      phases: '\u9636\u6bb5',
      features: '\u5168\u90e8\u529f\u80fd',
      priorities: '\u6309\u4f18\u5148\u7ea7'
    },
    kanban: {
      dropHere: '\u62d6\u653e\u5230\u6b64\u5904',
      noFeatures: '\u6682\u65e0\u529f\u80fd',
      dragFeaturesHere: '\u5c06\u529f\u80fd\u62d6\u52a8\u5230\u8fd9\u91cc',
      unknownStatus: '\u672a\u77e5\u72b6\u6001'
    },
    labels: {
      insight: '\u6d1e\u5bdf',
      competitorInsight: '\u7ade\u54c1\u6d1e\u5bdf'
    },
    impactValue: '{{value}} \u5f71\u54cd',
    detail: {
      progress: '\u8fdb\u5ea6',
      featureProgress: '{{completed}}/{{total}} \u4e2a\u529f\u80fd',
      milestones: '\u91cc\u7a0b\u7891',
      featuresWithCount: '\u529f\u80fd\uff08{{count}}\uff09',
      complexity: '\u590d\u6742\u5ea6',
      impact: '\u5f71\u54cd',
      dependencies: '\u4f9d\u8d56',
      userStories: '\u7528\u6237\u6545\u4e8b',
      acceptanceCriteria: '\u9a8c\u6536\u6807\u51c6',
      addressesCompetitorPainPoints: '\u89e3\u51b3\u7ade\u54c1\u75db\u70b9',
      severityValue: '{{severity}}\u7ea7',
      phaseName: '\u9636\u6bb5\uff1a{{phase}}'
    },
    delete: {
      title: '\u5220\u9664\u529f\u80fd\uff1f',
      description:
        '\u8fd9\u4f1a\u4ece\u4f60\u7684\u8def\u7ebf\u56fe\u4e2d\u6c38\u4e45\u79fb\u9664\u201c{{title}}\u201d\u3002'
    },
    empty: {
      title: '\u5c1a\u672a\u751f\u6210\u8def\u7ebf\u56fe',
      description:
        '\u751f\u6210\u4e00\u4efd AI \u9a71\u52a8\u7684\u4ea7\u54c1\u8def\u7ebf\u56fe\uff0c\u5e2e\u4f60\u660e\u786e\u4e0b\u4e00\u9636\u6bb5\u7684\u529f\u80fd\u4f18\u5148\u7ea7\u548c\u53d1\u5c55\u65b9\u5411\u3002'
    },
    priority: {
      must: '\u5fc5\u505a',
      should: '\u5e94\u505a',
      could: '\u53ef\u505a',
      wont: '\u4e0d\u505a'
    },
    complexity: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8'
    },
    impact: {
      low: '\u4f4e',
      medium: '\u4e2d',
      high: '\u9ad8'
    },
    status: {
      under_review: '\u5f85\u8bc4\u5ba1',
      planned: '\u5df2\u89c4\u5212',
      in_progress: '\u8fdb\u884c\u4e2d',
      done: '\u5df2\u5b8c\u6210'
    },
    phaseStatus: {
      planned: '\u5df2\u89c4\u5212',
      in_progress: '\u8fdb\u884c\u4e2d',
      completed: '\u5df2\u5b8c\u6210'
    }
  }
} as const;
