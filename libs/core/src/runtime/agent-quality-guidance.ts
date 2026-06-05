export type AutocodeBuildFailureType =
  | 'broken_build'
  | 'verification_failed'
  | 'circular_fix'
  | 'context_exhausted'
  | 'rate_limited'
  | 'auth_failure'
  | 'unknown';

export interface AutocodeBuildCheckpoint {
  specId: string;
  phase: string;
  lastCompletedSubtaskId: string | null;
  totalSubtasks: number;
  completedSubtasks: number;
  stuckSubtasks: string[];
  timestamp: string;
  isComplete: boolean;
}

export interface AutocodeChecklistItem {
  category: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  issue: string;
  prevention: string;
  references?: string[];
  likelihood: number;
}

export interface AutocodePreImplementationChecklist {
  subtaskId: string;
  items: AutocodeChecklistItem[];
  filesToReview: string[];
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  generatedAt: string;
}

export interface AutocodePatternInjectionResult {
  patterns: Array<{ category: string; file: string }>;
  successCases: Array<{ description: string; similarity: number }>;
}

export function classifyAutocodeBuildFailure(error: string): AutocodeBuildFailureType {
  const lower = error.toLowerCase();

  const buildErrors = [
    'syntax error',
    'compilation error',
    'module not found',
    'import error',
    'cannot find module',
    'unexpected token',
    'indentation error',
    'parse error',
  ];
  if (buildErrors.some((entry) => lower.includes(entry))) {
    return 'broken_build';
  }

  const verificationErrors = [
    'verification failed',
    'expected',
    'assertion',
    'test failed',
    'status code',
  ];
  if (verificationErrors.some((entry) => lower.includes(entry))) {
    return 'verification_failed';
  }

  if (lower.includes('context') || lower.includes('token limit') || lower.includes('maximum length')) {
    return 'context_exhausted';
  }

  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'rate_limited';
  }

  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('auth')) {
    return 'auth_failure';
  }

  return 'unknown';
}

export function createAutocodeSimpleHash(str: string): string {
  let hash = 0;
  const normalized = str.toLowerCase().trim();
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(36);
}

export function parseAutocodeBuildCheckpoint(content: string): AutocodeBuildCheckpoint | null {
  const getValue = (key: string): string | undefined => {
    const match = content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    return match?.[1]?.trim();
  };

  const specId = getValue('spec_id');
  const phase = getValue('phase');
  if (!specId || !phase) {
    return null;
  }

  const lastCompleted = getValue('last_completed_subtask');
  const stuckRaw = getValue('stuck_subtasks');

  return {
    specId,
    phase,
    lastCompletedSubtaskId: lastCompleted === 'none' ? null : (lastCompleted ?? null),
    totalSubtasks: Number.parseInt(getValue('total_subtasks') ?? '0', 10),
    completedSubtasks: Number.parseInt(getValue('completed_subtasks') ?? '0', 10),
    stuckSubtasks: stuckRaw && stuckRaw !== 'none' ? stuckRaw.split(',').map((item) => item.trim()) : [],
    timestamp: new Date().toISOString(),
    isComplete: getValue('is_complete') === 'true',
  };
}

export function calculateAutocodeChecklistRiskLevel(
  items: AutocodeChecklistItem[],
): 'low' | 'medium' | 'high' | 'critical' {
  const criticalCount = items.filter((item) => item.priority === 'critical').length;
  const highCount = items.filter((item) => item.priority === 'high').length;
  const avgLikelihood = items.reduce((sum, item) => sum + item.likelihood, 0) / (items.length || 1);

  if (criticalCount >= 2 || avgLikelihood > 0.7) {
    return 'critical';
  }
  if (criticalCount >= 1 || highCount >= 3 || avgLikelihood > 0.5) {
    return 'high';
  }
  if (highCount >= 1 || avgLikelihood > 0.3) {
    return 'medium';
  }
  return 'low';
}

export function formatAutocodeChecklistForPrompt(checklist: AutocodePreImplementationChecklist): string {
  const lines: string[] = [];

  lines.push('## Pre-Implementation Checklist\n');
  lines.push(`**Subtask**: ${checklist.subtaskId}`);
  lines.push(`**Risk Level**: ${checklist.riskLevel.toUpperCase()}`);
  lines.push(`**Generated**: ${new Date(checklist.generatedAt).toLocaleString()}\n`);

  if (checklist.items.length === 0) {
    lines.push('No specific risks identified. Follow general best practices.\n');
    return lines.join('\n');
  }

  lines.push('Review these predicted issues before implementing:\n');

  const critical = checklist.items.filter((item) => item.priority === 'critical');
  const high = checklist.items.filter((item) => item.priority === 'high');
  const medium = checklist.items.filter((item) => item.priority === 'medium');

  if (critical.length > 0) {
    lines.push('### Critical Issues\n');
    for (const item of critical) {
      lines.push(`**${item.issue}** (${(item.likelihood * 100).toFixed(0)}% likely)`);
      lines.push(`- Prevention: ${item.prevention}`);
      if (item.references) {
        lines.push(`- References: ${item.references.join(', ')}`);
      }
      lines.push('');
    }
  }

  if (high.length > 0) {
    lines.push('### High Priority Issues\n');
    for (const item of high) {
      lines.push(`**${item.issue}** (${(item.likelihood * 100).toFixed(0)}% likely)`);
      lines.push(`- Prevention: ${item.prevention}`);
      lines.push('');
    }
  }

  if (medium.length > 0 && medium.length <= 3) {
    lines.push('### Medium Priority Issues:\n');
    for (const item of medium) {
      lines.push(`- ${item.issue}: ${item.prevention}`);
    }
    lines.push('');
  }

  if (checklist.filesToReview.length > 0) {
    lines.push('### Files to Review Before Implementing:\n');
    for (const file of checklist.filesToReview.slice(0, 5)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  lines.push('**Acknowledgment Required**: Confirm you have reviewed this checklist before proceeding.\n');

  return lines.join('\n');
}

export function formatAutocodeCompactChecklistForPrompt(
  checklist: AutocodePreImplementationChecklist,
  maxItems = 5,
): string {
  const importantItems = checklist.items
    .filter((item) => item.priority === 'critical' || item.priority === 'high')
    .slice(0, maxItems);
  const reviewFiles = checklist.filesToReview.slice(0, 3);
  const lines: string[] = [
    '## Pre-Implementation Risk Check',
    `- Risk: ${checklist.riskLevel}`,
  ];

  if (importantItems.length > 0) {
    lines.push('- Before editing, prevent:');
    for (const item of importantItems) {
      lines.push(`  - ${item.issue}: ${item.prevention}`);
    }
  }

  if (reviewFiles.length > 0) {
    lines.push(`- Review first: ${reviewFiles.join(', ')}`);
  }

  lines.push('- Keep this checklist in mind; do not restate it in the final answer.');
  return lines.join('\n');
}

export function formatAutocodeChecklistSummary(checklist: AutocodePreImplementationChecklist): string {
  const critical = checklist.items.filter((item) => item.priority === 'critical').length;
  const high = checklist.items.filter((item) => item.priority === 'high').length;
  const medium = checklist.items.filter((item) => item.priority === 'medium').length;

  return `Pre-Implementation Checklist: ${checklist.items.length} items (${critical} critical, ${high} high, ${medium} medium) - Risk: ${checklist.riskLevel}`;
}

export function shouldInjectAutocodePatterns(subtask: { patternFiles?: string[] }): boolean {
  return !!(subtask.patternFiles && subtask.patternFiles.length > 0);
}

export function formatAutocodeCategory(category: string): string {
  return category
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function formatAutocodePatternInjectionSummary(result: AutocodePatternInjectionResult): string {
  const lines: string[] = [];

  lines.push('=== Pattern Injection Summary ===');
  lines.push(`Patterns injected: ${result.patterns.length}`);

  if (result.patterns.length > 0) {
    for (const pattern of result.patterns) {
      lines.push(`  - ${formatAutocodeCategory(pattern.category)} (from ${pattern.file})`);
    }
  }

  lines.push(`Success cases injected: ${result.successCases.length}`);

  if (result.successCases.length > 0) {
    for (const successCase of result.successCases) {
      lines.push(`  - ${successCase.description} (${(successCase.similarity * 100).toFixed(0)}% similar)`);
    }
  }

  return lines.join('\n');
}
