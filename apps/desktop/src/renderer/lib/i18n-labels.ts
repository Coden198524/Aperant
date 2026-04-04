import type { TFunction } from 'i18next';
import type { IdeationStatus, IdeationType } from '../../shared/types/insights';
import type { ExecutionPhase, TaskCategory, TaskComplexity, TaskImpact, TaskPriority } from '../../shared/types/task';
import type {
  RoadmapFeaturePriority,
  RoadmapFeatureStatus,
  RoadmapPhaseStatus
} from '../../shared/types/roadmap';

export function getIdeationTypeLabel(t: TFunction, type: IdeationType): string {
  switch (type) {
    case 'code_improvements':
      return t('ideation.types.code_improvements.label', { defaultValue: 'Code Improvements' });
    case 'ui_ux_improvements':
      return t('ideation.types.ui_ux_improvements.label', { defaultValue: 'UI/UX Improvements' });
    case 'documentation_gaps':
      return t('ideation.types.documentation_gaps.label', { defaultValue: 'Documentation' });
    case 'security_hardening':
      return t('ideation.types.security_hardening.label', { defaultValue: 'Security' });
    case 'performance_optimizations':
      return t('ideation.types.performance_optimizations.label', { defaultValue: 'Performance' });
    case 'code_quality':
      return t('ideation.types.code_quality.label', { defaultValue: 'Code Quality' });
  }
}

export function getIdeationTypeDescription(t: TFunction, type: IdeationType): string {
  switch (type) {
    case 'code_improvements':
      return t('ideation.types.code_improvements.description', {
        defaultValue: 'Code-revealed opportunities from patterns, architecture, and infrastructure analysis'
      });
    case 'ui_ux_improvements':
      return t('ideation.types.ui_ux_improvements.description', {
        defaultValue: 'Visual and interaction improvements identified through app analysis'
      });
    case 'documentation_gaps':
      return t('ideation.types.documentation_gaps.description', {
        defaultValue: 'Missing or outdated documentation that needs attention'
      });
    case 'security_hardening':
      return t('ideation.types.security_hardening.description', {
        defaultValue: 'Security vulnerabilities and hardening opportunities'
      });
    case 'performance_optimizations':
      return t('ideation.types.performance_optimizations.description', {
        defaultValue: 'Performance bottlenecks and optimization opportunities'
      });
    case 'code_quality':
      return t('ideation.types.code_quality.description', {
        defaultValue: 'Refactoring opportunities, large files, code smells, and best practice violations'
      });
  }
}

export function getIdeationStatusLabel(t: TFunction, status: IdeationStatus): string {
  switch (status) {
    case 'draft':
      return t('ideation.status.draft', { defaultValue: 'Draft' });
    case 'selected':
      return t('ideation.status.selected', { defaultValue: 'Selected' });
    case 'converted':
      return t('ideation.status.converted', { defaultValue: 'Converted' });
    case 'dismissed':
      return t('ideation.status.dismissed', { defaultValue: 'Dismissed' });
    case 'archived':
      return t('ideation.status.archived', { defaultValue: 'Archived' });
  }
}

export function getIdeationEffortLabel(
  t: TFunction,
  effort: 'trivial' | 'small' | 'medium' | 'large' | 'complex'
): string {
  return t(`ideation.effort.${effort}`, {
    defaultValue: {
      trivial: 'Trivial',
      small: 'Small',
      medium: 'Medium',
      large: 'Large',
      complex: 'Complex'
    }[effort]
  });
}

export function getIdeationImpactLabel(
  t: TFunction,
  impact: 'low' | 'medium' | 'high' | 'critical'
): string {
  return t(`ideation.impact.${impact}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      critical: 'Critical'
    }[impact]
  });
}

export function getIdeationPriorityLabel(t: TFunction, priority: 'low' | 'medium' | 'high'): string {
  return t(`ideation.priority.${priority}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High'
    }[priority]
  });
}

export function getUIUXCategoryLabel(
  t: TFunction,
  category: 'usability' | 'accessibility' | 'performance' | 'visual' | 'interaction'
): string {
  return t(`ideation.categories.uiux.${category}`, {
    defaultValue: {
      usability: 'Usability',
      accessibility: 'Accessibility',
      performance: 'Performance',
      visual: 'Visual Design',
      interaction: 'Interaction'
    }[category]
  });
}

export function getDocumentationCategoryLabel(
  t: TFunction,
  category: 'readme' | 'api_docs' | 'inline_comments' | 'examples' | 'architecture' | 'troubleshooting'
): string {
  return t(`ideation.categories.documentation.${category}`, {
    defaultValue: {
      readme: 'README',
      api_docs: 'API Documentation',
      inline_comments: 'Inline Comments',
      examples: 'Examples & Tutorials',
      architecture: 'Architecture Docs',
      troubleshooting: 'Troubleshooting Guide'
    }[category]
  });
}

export function getDocumentationAudienceLabel(
  t: TFunction,
  audience: 'developers' | 'users' | 'contributors' | 'maintainers'
): string {
  return t(`ideation.audience.${audience}`, {
    defaultValue: {
      developers: 'Developers',
      users: 'Users',
      contributors: 'Contributors',
      maintainers: 'Maintainers'
    }[audience]
  });
}

export function getSecurityCategoryLabel(
  t: TFunction,
  category: 'authentication' | 'authorization' | 'input_validation' | 'data_protection' | 'dependencies' | 'configuration' | 'secrets_management'
): string {
  return t(`ideation.categories.security.${category}`, {
    defaultValue: {
      authentication: 'Authentication',
      authorization: 'Authorization',
      input_validation: 'Input Validation',
      data_protection: 'Data Protection',
      dependencies: 'Dependencies',
      configuration: 'Configuration',
      secrets_management: 'Secrets Management'
    }[category]
  });
}

export function getSecuritySeverityLabel(
  t: TFunction,
  severity: 'low' | 'medium' | 'high' | 'critical'
): string {
  return t(`ideation.severity.${severity}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      critical: 'Critical'
    }[severity]
  });
}

export function getPerformanceCategoryLabel(
  t: TFunction,
  category: 'bundle_size' | 'runtime' | 'memory' | 'database' | 'network' | 'rendering' | 'caching'
): string {
  return t(`ideation.categories.performance.${category}`, {
    defaultValue: {
      bundle_size: 'Bundle Size',
      runtime: 'Runtime Performance',
      memory: 'Memory Usage',
      database: 'Database Queries',
      network: 'Network Requests',
      rendering: 'Rendering',
      caching: 'Caching'
    }[category]
  });
}

export function getCodeQualityCategoryLabel(
  t: TFunction,
  category: 'large_files' | 'code_smells' | 'complexity' | 'duplication' | 'naming' | 'structure' | 'linting' | 'testing' | 'types' | 'dependencies' | 'dead_code' | 'git_hygiene'
): string {
  return t(`ideation.categories.codeQuality.${category}`, {
    defaultValue: {
      large_files: 'Large Files',
      code_smells: 'Code Smells',
      complexity: 'High Complexity',
      duplication: 'Code Duplication',
      naming: 'Naming Conventions',
      structure: 'File Structure',
      linting: 'Linting Issues',
      testing: 'Test Coverage',
      types: 'Type Safety',
      dependencies: 'Dependency Issues',
      dead_code: 'Dead Code',
      git_hygiene: 'Git Hygiene'
    }[category]
  });
}

export function getCodeQualitySeverityLabel(
  t: TFunction,
  severity: 'suggestion' | 'minor' | 'major' | 'critical'
): string {
  return t(`ideation.codeQualitySeverity.${severity}`, {
    defaultValue: {
      suggestion: 'Suggestion',
      minor: 'Minor',
      major: 'Major',
      critical: 'Critical'
    }[severity]
  });
}

export function getRoadmapPriorityLabel(t: TFunction, priority: RoadmapFeaturePriority): string {
  return t(`roadmap.priority.${priority}`, {
    defaultValue: {
      must: 'Must Have',
      should: 'Should Have',
      could: 'Could Have',
      wont: "Won't Have"
    }[priority]
  });
}

export function getRoadmapComplexityLabel(
  t: TFunction,
  complexity: 'low' | 'medium' | 'high'
): string {
  return t(`roadmap.complexity.${complexity}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High'
    }[complexity]
  });
}

export function getRoadmapImpactLabel(
  t: TFunction,
  impact: 'low' | 'medium' | 'high'
): string {
  return t(`roadmap.impact.${impact}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High'
    }[impact]
  });
}

export function getRoadmapFeatureStatusLabel(t: TFunction, status: RoadmapFeatureStatus): string {
  return t(`roadmap.status.${status}`, {
    defaultValue: {
      under_review: 'Under Review',
      planned: 'Planned',
      in_progress: 'In Progress',
      done: 'Done'
    }[status]
  });
}

export function getRoadmapPhaseStatusLabel(t: TFunction, status: RoadmapPhaseStatus): string {
  switch (status) {
    case 'planned':
      return t('roadmap.phaseStatus.planned', { defaultValue: 'Planned' });
    case 'in_progress':
      return t('roadmap.phaseStatus.in_progress', { defaultValue: 'In Progress' });
    case 'completed':
      return t('roadmap.phaseStatus.completed', { defaultValue: 'Completed' });
  }
}

export function getTaskCategoryLabel(t: TFunction, category: TaskCategory): string {
  return t(`tasks:form.classification.values.category.${category}`, {
    defaultValue: {
      feature: 'Feature',
      bug_fix: 'Bug Fix',
      refactoring: 'Refactoring',
      documentation: 'Docs',
      security: 'Security',
      performance: 'Performance',
      ui_ux: 'UI/UX',
      infrastructure: 'Infrastructure',
      testing: 'Testing'
    }[category]
  });
}

export function getTaskPriorityLabel(t: TFunction, priority: TaskPriority): string {
  return t(`tasks:form.classification.values.priority.${priority}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      urgent: 'Urgent'
    }[priority]
  });
}

export function getTaskComplexityLabel(t: TFunction, complexity: TaskComplexity): string {
  return t(`tasks:form.classification.values.complexity.${complexity}`, {
    defaultValue: {
      trivial: 'Trivial',
      small: 'Small',
      medium: 'Medium',
      large: 'Large',
      complex: 'Complex'
    }[complexity]
  });
}

export function getTaskImpactLabel(t: TFunction, impact: TaskImpact): string {
  return t(`tasks:form.classification.values.impact.${impact}`, {
    defaultValue: {
      low: 'Low Impact',
      medium: 'Medium Impact',
      high: 'High Impact',
      critical: 'Critical Impact'
    }[impact]
  });
}

export function getTaskSeverityLabel(
  t: TFunction,
  severity: 'low' | 'medium' | 'high' | 'critical'
): string {
  return t(`tasks:metadata.severityValues.${severity}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      critical: 'Critical'
    }[severity]
  });
}

export function getTaskSourceTypeLabel(
  t: TFunction,
  sourceType: 'manual' | 'imported' | 'insights' | 'roadmap' | 'linear' | 'github' | 'gitlab'
): string {
  return t(`tasks:metadata.sourceTypes.${sourceType}`, {
    defaultValue: {
      manual: 'Manual',
      imported: 'Imported',
      insights: 'Insights',
      roadmap: 'Roadmap',
      linear: 'Linear',
      github: 'GitHub',
      gitlab: 'GitLab'
    }[sourceType]
  });
}

export function getTaskExecutionPhaseLabel(t: TFunction, phase: ExecutionPhase): string {
  return t(`tasks:execution.phases.${phase}`, {
    defaultValue: {
      idle: 'Idle',
      planning: 'Planning',
      coding: 'Coding',
      rate_limit_paused: 'Rate Limited',
      auth_failure_paused: 'Auth Required',
      qa_review: 'AI Review',
      qa_fixing: 'Fixing Issues',
      complete: 'Complete',
      failed: 'Failed'
    }[phase]
  });
}

export function getAgentProfileLabel(
  t: TFunction,
  profileId: 'auto' | 'complex' | 'balanced' | 'quick' | 'custom'
): string {
  return t(`settings:agentProfile.profiles.${profileId}.label`, {
    defaultValue: {
      auto: 'Auto (Optimized)',
      complex: 'Complex Tasks',
      balanced: 'Balanced',
      quick: 'Quick Edits',
      custom: 'Custom'
    }[profileId]
  });
}

export function getAgentProfileDescription(
  t: TFunction,
  profileId: 'auto' | 'complex' | 'balanced' | 'quick' | 'custom'
): string {
  return t(`settings:agentProfile.profiles.${profileId}.description`, {
    defaultValue: {
      auto: 'Uses Opus across all phases with optimized thinking levels',
      complex: 'Maximum capability for large or difficult tasks',
      balanced: 'Balanced capability, speed, and cost for everyday work',
      quick: 'Faster responses for small focused edits',
      custom: 'Choose model & thinking level'
    }[profileId]
  });
}

export function getAgentThinkingLevelLabel(
  t: TFunction,
  thinkingLevel: 'low' | 'medium' | 'high' | 'xhigh'
): string {
  return t(`settings:agentProfile.thinkingLevels.${thinkingLevel}`, {
    defaultValue: {
      low: 'Low',
      medium: 'Medium',
      high: 'High',
      xhigh: 'Extra High'
    }[thinkingLevel]
  });
}
