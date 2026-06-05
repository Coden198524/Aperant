/**
 * Context-aware recovery strategy selection for failed agent subtasks.
 */

export interface AutocodeFailureRecord {
  attempt: number;
  outcome: string;
  error?: string;
  toolCalls?: string[];
  filesAccessed?: string[];
  timestamp: string;
}

export type AutocodeFailurePattern =
  | 'missing_context'
  | 'pattern_mismatch'
  | 'verification_failure'
  | 'dependency_issue'
  | 'scope_too_large'
  | 'tool_error'
  | 'unknown';

export type AutocodeRecoveryStrategyType =
  | 'expand_context'
  | 'template_mode'
  | 'fix_verification'
  | 'revalidate_dependencies'
  | 'simplify_scope'
  | 'seek_help';

export interface AutocodeRecoveryStrategy {
  type: AutocodeRecoveryStrategyType;
  description: string;
  additionalFiles?: string[];
  template?: string;
  promptModifications: string;
  dependentSubtasks?: string[];
  confidence: number;
}

export interface AutocodeFailureAnalysis {
  pattern: AutocodeFailurePattern;
  rootCause: string;
  strategy: AutocodeRecoveryStrategy;
  alternatives: AutocodeRecoveryStrategy[];
}

export interface AutocodeRecoverySubtask {
  id: string;
  description: string;
  filesToModify?: string[];
  patternFiles?: string[];
  dependsOn?: string[];
}

export async function analyzeAutocodeFailureAndRecover(
  subtask: AutocodeRecoverySubtask,
  failureHistory: AutocodeFailureRecord[],
  projectDir = '',
  specDir = '',
): Promise<AutocodeFailureAnalysis> {
  const pattern = detectAutocodeFailurePattern(failureHistory);
  const rootCause = analyzeAutocodeFailureRootCause(pattern, failureHistory, subtask);
  const strategy = await selectAutocodeRecoveryStrategy(pattern, subtask, failureHistory, projectDir, specDir);
  const alternatives = await generateAutocodeAlternativeRecoveryStrategies(pattern, subtask, projectDir, specDir);

  return {
    pattern,
    rootCause,
    strategy,
    alternatives,
  };
}

export function detectAutocodeFailurePattern(history: readonly AutocodeFailureRecord[]): AutocodeFailurePattern {
  if (history.length === 0) {
    return 'unknown';
  }

  const latestFailure = history[history.length - 1];
  const errorMsg = latestFailure.error?.toLowerCase() ?? '';

  if (
    errorMsg.includes('cannot find') ||
    errorMsg.includes('not found') ||
    errorMsg.includes('undefined') ||
    errorMsg.includes('does not exist')
  ) {
    return 'missing_context';
  }

  if (
    errorMsg.includes('pattern') ||
    errorMsg.includes('style') ||
    errorMsg.includes('convention') ||
    errorMsg.includes('does not match')
  ) {
    return 'pattern_mismatch';
  }

  if (
    errorMsg.includes('verification failed') ||
    errorMsg.includes('test failed') ||
    errorMsg.includes('assertion') ||
    latestFailure.outcome === 'verification_failed'
  ) {
    return 'verification_failure';
  }

  if (
    errorMsg.includes('dependency') ||
    errorMsg.includes('import') ||
    errorMsg.includes('module') ||
    errorMsg.includes('package')
  ) {
    return 'dependency_issue';
  }

  if (latestFailure.filesAccessed && latestFailure.filesAccessed.length > 10) {
    return 'scope_too_large';
  }

  if (
    errorMsg.includes('tool') ||
    errorMsg.includes('command failed') ||
    errorMsg.includes('permission denied')
  ) {
    return 'tool_error';
  }

  if (history.length >= 2) {
    const errors = history.map((item) => item.error).filter(Boolean);
    const uniqueErrors = new Set(errors);
    if (uniqueErrors.size === 1) {
      return 'missing_context';
    }
  }

  return 'unknown';
}

export function analyzeAutocodeFailureRootCause(
  pattern: AutocodeFailurePattern,
  history: readonly AutocodeFailureRecord[],
  subtask: Pick<AutocodeRecoverySubtask, 'description'>,
): string {
  const latestFailure = history[history.length - 1];

  switch (pattern) {
    case 'missing_context':
      return `Agent lacks necessary context to implement "${subtask.description}". May need to read more related files or understand dependencies better.`;
    case 'pattern_mismatch':
      return 'Generated code does not follow established patterns. Agent may not have properly studied the pattern files or misunderstood the conventions.';
    case 'verification_failure':
      return 'Implementation does not pass verification tests. Either the code is incorrect or the verification criteria are unclear/wrong.';
    case 'dependency_issue':
      return 'Missing or incorrect dependencies. May need to install packages, fix imports, or check that dependent subtasks are truly complete.';
    case 'scope_too_large':
      return 'Subtask scope is too large - agent is trying to modify too many files at once. Should break down into smaller pieces.';
    case 'tool_error':
      return 'Tool execution failed. May be a permission issue, invalid command, or tool limitation.';
    default:
      return `Unknown failure cause. Error: ${latestFailure?.error ?? 'No error message'}`;
  }
}

export async function selectAutocodeRecoveryStrategy(
  pattern: AutocodeFailurePattern,
  subtask: AutocodeRecoverySubtask,
  history: readonly AutocodeFailureRecord[],
  projectDir = '',
  specDir = '',
): Promise<AutocodeRecoveryStrategy> {
  void projectDir;
  void specDir;

  switch (pattern) {
    case 'missing_context':
      return expandAutocodeContextStrategy(subtask);
    case 'pattern_mismatch':
      return templateAutocodeModeStrategy(subtask);
    case 'verification_failure':
      return fixAutocodeVerificationStrategy(subtask);
    case 'dependency_issue':
      return revalidateAutocodeDependenciesStrategy(subtask);
    case 'scope_too_large':
      return simplifyAutocodeScopeStrategy(subtask);
    case 'tool_error':
      return seekAutocodeHelpStrategy(subtask, history);
    default:
      return expandAutocodeContextStrategy(subtask);
  }
}

export function expandAutocodeContextStrategy(
  subtask: Pick<AutocodeRecoverySubtask, 'description' | 'filesToModify'>,
): AutocodeRecoveryStrategy {
  const additionalFiles: string[] = [];

  if (subtask.filesToModify) {
    for (const file of subtask.filesToModify) {
      additionalFiles.push(file.replace(/\.(ts|js|tsx|jsx)$/, '.test.$1'));
      additionalFiles.push(file.replace(/\.(ts|tsx)$/, '.types.ts'));

      const dir = file.split('/').slice(0, -1).join('/');
      additionalFiles.push(`${dir}/index.ts`);
      additionalFiles.push(`${dir}/types.ts`);
      additionalFiles.push(`${dir}/utils.ts`);
    }
  }

  return {
    type: 'expand_context',
    description: 'Load additional related files to understand the full context',
    additionalFiles: [...new Set(additionalFiles)],
    promptModifications: `
## EXPANDED CONTEXT

Your previous attempt failed due to missing context. Before implementing:

1. **Read these additional files** to understand the full picture:
${additionalFiles.map((file) => `   - ${file}`).join('\n')}

2. **Understand the relationships** between files
3. **Check for dependencies** and imports
4. **Look for similar implementations** in the codebase

Only after reading and understanding the context, proceed with implementation.
`,
    confidence: 0.8,
  };
}

export function templateAutocodeModeStrategy(
  subtask: Pick<AutocodeRecoverySubtask, 'patternFiles'>,
): AutocodeRecoveryStrategy {
  const template = subtask.patternFiles?.[0];

  return {
    type: 'template_mode',
    description: 'Use pattern file as a strict template - fill in the blanks',
    template,
    promptModifications: `
## TEMPLATE MODE

Your previous attempt did not follow the established patterns. This time:

1. **Open the pattern file**: ${template}
2. **Copy its structure EXACTLY** - do not deviate
3. **Fill in the blanks** with your specific logic
4. **Match the style** - imports, naming, error handling, everything

Think of this as a fill-in-the-blank exercise, not a creative writing task.
DO NOT improvise or "improve" the pattern - just follow it.
`,
    confidence: 0.85,
  };
}

export function fixAutocodeVerificationStrategy(
  _subtask: Pick<AutocodeRecoverySubtask, 'description'>,
): AutocodeRecoveryStrategy {
  return {
    type: 'fix_verification',
    description: 'Verify that the verification criteria are correct',
    promptModifications: `
## VERIFICATION FIRST

Your previous attempt failed verification. Before re-implementing:

1. **Read the verification criteria** carefully
2. **Check if the verification is correct** - is it testing the right thing?
3. **Run the verification manually** to understand what it expects
4. **If verification is wrong**, fix it first
5. **If verification is correct**, understand why your code failed

Only after understanding the verification, implement the code to pass it.
`,
    confidence: 0.7,
  };
}

export function revalidateAutocodeDependenciesStrategy(
  subtask: Pick<AutocodeRecoverySubtask, 'dependsOn'>,
): AutocodeRecoveryStrategy {
  return {
    type: 'revalidate_dependencies',
    description: 'Check that dependent subtasks are truly complete',
    dependentSubtasks: subtask.dependsOn,
    promptModifications: `
## DEPENDENCY CHECK

Your previous attempt failed due to dependency issues. Before proceeding:

1. **Verify dependent subtasks** are truly complete:
${subtask.dependsOn?.map((dependency) => `   - ${dependency}`).join('\n') ?? '   (none)'}

2. **Check their outputs** - do they provide what you need?
3. **Test the dependencies** - run them to ensure they work
4. **If dependencies are incomplete**, document what is missing

Only proceed if all dependencies are verified working.
`,
    confidence: 0.75,
  };
}

export function simplifyAutocodeScopeStrategy(
  _subtask: Pick<AutocodeRecoverySubtask, 'description' | 'filesToModify'>,
): AutocodeRecoveryStrategy {
  return {
    type: 'simplify_scope',
    description: 'Reduce scope - implement only the core functionality',
    promptModifications: `
## SIMPLIFIED SCOPE

Your previous attempt tried to do too much. This time:

1. **Focus on the core requirement** only
2. **Modify fewer files** - start with just the essential ones
3. **Skip nice-to-haves** - no extra features, no refactoring
4. **Get it working first** - optimize later

Implement the MINIMUM to satisfy the requirement. Nothing more.
`,
    confidence: 0.65,
  };
}

export function seekAutocodeHelpStrategy(
  subtask: Pick<AutocodeRecoverySubtask, 'id' | 'description'>,
  history: readonly AutocodeFailureRecord[],
): AutocodeRecoveryStrategy {
  return {
    type: 'seek_help',
    description: 'Escalate to human - this subtask needs manual intervention',
    promptModifications: `
## ESCALATION NEEDED

After ${history.length} attempts, this subtask cannot be completed automatically.

**Subtask**: ${subtask.id}
**Description**: ${subtask.description}

**Failure history**:
${history.map((item, index) => `${index + 1}. ${item.outcome}: ${item.error ?? 'No error message'}`).join('\n')}

Please document:
1. What you tried
2. What failed
3. What you think the blocker is
4. What help you need from a human

Then mark this subtask as "needs_human_review".
`,
    confidence: 0.5,
  };
}

export async function generateAutocodeAlternativeRecoveryStrategies(
  pattern: AutocodeFailurePattern,
  subtask: AutocodeRecoverySubtask,
  projectDir = '',
  specDir = '',
): Promise<AutocodeRecoveryStrategy[]> {
  void projectDir;
  void specDir;

  const alternatives: AutocodeRecoveryStrategy[] = [];

  if (pattern !== 'scope_too_large') {
    alternatives.push(simplifyAutocodeScopeStrategy(subtask));
  }

  if (subtask.patternFiles && subtask.patternFiles.length > 0 && pattern !== 'pattern_mismatch') {
    alternatives.push(templateAutocodeModeStrategy(subtask));
  }

  if (pattern !== 'missing_context') {
    alternatives.push(expandAutocodeContextStrategy(subtask));
  }

  return alternatives;
}

export function formatAutocodeFailureAnalysis(analysis: AutocodeFailureAnalysis): string {
  const lines: string[] = [];

  lines.push('## Failure Analysis\n');
  lines.push(`**Pattern**: ${analysis.pattern}`);
  lines.push(`**Root Cause**: ${analysis.rootCause}\n`);

  lines.push('### Recommended Recovery Strategy\n');
  lines.push(`**Type**: ${analysis.strategy.type}`);
  lines.push(`**Description**: ${analysis.strategy.description}`);
  lines.push(`**Confidence**: ${(analysis.strategy.confidence * 100).toFixed(0)}%\n`);

  if (analysis.strategy.additionalFiles && analysis.strategy.additionalFiles.length > 0) {
    lines.push('**Additional Files to Load**:');
    for (const file of analysis.strategy.additionalFiles.slice(0, 5)) {
      lines.push(`- ${file}`);
    }
    lines.push('');
  }

  if (analysis.alternatives.length > 0) {
    lines.push('### Alternative Strategies\n');
    for (const alternative of analysis.alternatives) {
      lines.push(
        `- **${alternative.type}**: ${alternative.description} (${(alternative.confidence * 100).toFixed(0)}% confidence)`,
      );
    }
    lines.push('');
  }

  lines.push('### Modified Instructions\n');
  lines.push(analysis.strategy.promptModifications);

  return lines.join('\n');
}

export function formatAutocodeRecoverySummary(analysis: AutocodeFailureAnalysis): string {
  return `Recovery Strategy: ${analysis.strategy.type} (${(analysis.strategy.confidence * 100).toFixed(0)}% confidence) - ${analysis.rootCause}`;
}
