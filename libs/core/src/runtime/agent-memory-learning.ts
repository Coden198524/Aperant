import type {
  AutocodeSessionError,
  AutocodeSessionMessage,
  AutocodeSessionResult,
} from './agent-session-types.js';

export interface AutocodeLearningSubtask {
  id: string;
  description: string;
  filesToModify?: string[];
  filesToCreate?: string[];
  patternFiles?: string[];
}

export interface AutocodeLearningAnalysisInput {
  sessionResult: AutocodeSessionResult;
  subtask: AutocodeLearningSubtask;
}

export interface AutocodeCreateExtractedKnowledgeInput extends AutocodeLearningAnalysisInput {
  codePatterns?: AutocodeCodePattern[];
  sessionId?: string;
  timestamp?: string;
}

export interface AutocodeExtractedKnowledge {
  sessionId: string;
  subtaskId: string;
  timestamp: string;
  outcome: string;
  successPatterns?: AutocodeSuccessPattern[];
  failurePatterns?: AutocodeFailureLearningPattern[];
  codePatterns?: AutocodeCodePattern[];
  insights: string[];
  keyFiles: string[];
}

export interface AutocodeSuccessPattern {
  description: string;
  approach: string;
  whyItWorked: string;
  keyDecisions: string[];
  effectiveTools: string[];
  confidence: number;
}

export interface AutocodeFailureLearningPattern {
  description: string;
  errorType: string;
  rootCause: string;
  prevention: string;
  attemptedApproach: string;
  confidence: number;
}

export interface AutocodeCodePattern {
  category: 'error_handling' | 'api_design' | 'state_management' | 'data_flow' | 'testing' | 'other';
  name: string;
  code: string;
  useCase: string;
  language: string;
  sourceFile: string;
}

export function createAutocodeExtractedKnowledge(
  input: AutocodeCreateExtractedKnowledgeInput,
): AutocodeExtractedKnowledge {
  const knowledge: AutocodeExtractedKnowledge = {
    sessionId: input.sessionId ?? generateAutocodeLearningSessionId(),
    subtaskId: input.subtask.id,
    timestamp: input.timestamp ?? new Date().toISOString(),
    outcome: input.sessionResult.outcome,
    insights: extractAutocodeInsights(input),
    keyFiles: identifyAutocodeKeyFiles(input),
  };

  if (input.sessionResult.outcome === 'completed') {
    knowledge.successPatterns = extractAutocodeSuccessPatterns(input);
  }

  if (input.sessionResult.outcome === 'error' || input.sessionResult.outcome === 'max_steps') {
    knowledge.failurePatterns = extractAutocodeFailurePatterns(input);
  }

  knowledge.codePatterns = input.codePatterns ?? [];

  return knowledge;
}

export function extractAutocodeSuccessPatterns(
  input: AutocodeLearningAnalysisInput,
): AutocodeSuccessPattern[] {
  const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);

  return [
    {
      description: input.subtask.description,
      approach: analyzeAutocodeApproach(toolCalls),
      whyItWorked: analyzeAutocodeWhyItWorked(input),
      keyDecisions: extractAutocodeKeyDecisions(input.sessionResult.messages),
      effectiveTools: identifyAutocodeEffectiveTools(toolCalls),
      confidence: 0.8,
    },
  ];
}

export function extractAutocodeFailurePatterns(
  input: AutocodeLearningAnalysisInput,
): AutocodeFailureLearningPattern[] {
  const error = input.sessionResult.error;
  if (!error) {
    return [];
  }

  const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);
  const rootCause = analyzeAutocodeFailureLearningRootCause(error, toolCalls);

  return [
    {
      description: input.subtask.description,
      errorType: error.code,
      rootCause,
      prevention: generateAutocodeFailurePreventionAdvice(error, rootCause),
      attemptedApproach: analyzeAutocodeApproach(toolCalls),
      confidence: 0.7,
    },
  ];
}

export function extractAutocodeCodePatternsFromContent(content: string, file: string): AutocodeCodePattern[] {
  return [
    ...extractAutocodeErrorHandlingPatterns(content, file),
    ...extractAutocodeApiPatterns(content, file),
    ...extractAutocodeStatePatterns(content, file),
  ];
}

export function extractAutocodeToolCallSequence(result: Pick<AutocodeSessionResult, 'messages'>): string[] {
  const toolCalls: string[] = [];

  for (const message of result.messages) {
    if (message.role !== 'assistant' || !message.content) {
      continue;
    }

    const content = stringifyAutocodeMessageContent(message.content);
    const toolNamePattern = /"toolName"\s*:\s*"([^"]+)"/g;
    for (const match of content.matchAll(toolNamePattern)) {
      const tool = match[1];
      if (tool) {
        toolCalls.push(tool);
      }
    }
  }

  return toolCalls;
}

export function analyzeAutocodeApproach(toolCalls: readonly string[]): string {
  const approaches: string[] = [];

  if (toolCalls[0] === 'Read' || toolCalls[0] === 'Grep') {
    approaches.push('Read existing code first to understand context');
  }

  if (toolCalls.some((tool) => tool === 'Write' && toolCalls.indexOf(tool) < toolCalls.length / 2)) {
    const writeIndex = toolCalls.indexOf('Write');
    const afterWrite = toolCalls.slice(writeIndex);
    if (afterWrite.some((tool) => tool === 'Bash' && tool.includes('test'))) {
      approaches.push('Test-driven: wrote tests before implementation');
    }
  }

  const writeCount = toolCalls.filter((tool) => tool === 'Write' || tool === 'Edit').length;
  if (writeCount > 3) {
    approaches.push('Incremental: made multiple small changes');
  }

  if (toolCalls.some((tool) => tool === 'Bash')) {
    approaches.push('Verified changes by running commands');
  }

  return approaches.join('; ') || 'Standard implementation approach';
}

export function extractAutocodeKeyDecisions(messages: readonly AutocodeSessionMessage[]): string[] {
  const decisions: string[] = [];

  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content !== 'string') {
      continue;
    }

    const content = message.content.toLowerCase();

    if (content.includes('decided to') || content.includes('chose to')) {
      const sentence = content.split('.').find((part) => part.includes('decided') || part.includes('chose'));
      if (sentence) {
        decisions.push(sentence.trim());
      }
    }

    if (content.includes('approach:') || content.includes('strategy:')) {
      const sentence = content.split('\n').find((part) => part.includes('approach') || part.includes('strategy'));
      if (sentence) {
        decisions.push(sentence.trim());
      }
    }
  }

  return decisions.slice(0, 5);
}

export function identifyAutocodeEffectiveTools(toolCalls: readonly string[]): string[] {
  const toolCounts = new Map<string, number>();

  for (const tool of toolCalls) {
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
  }

  return Array.from(toolCounts.entries())
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([tool]) => tool)
    .slice(0, 5);
}

export function analyzeAutocodeWhyItWorked(input: AutocodeLearningAnalysisInput): string {
  const reasons: string[] = [];

  if (input.subtask.patternFiles && input.subtask.patternFiles.length > 0) {
    reasons.push('Followed established patterns from reference files');
  }

  if (input.sessionResult.outcome === 'completed') {
    reasons.push('Implementation passed all verification checks');
  }

  if (input.sessionResult.usage.totalTokens < 50000) {
    reasons.push('Efficient implementation with minimal token usage');
  }

  if (input.sessionResult.stepsExecuted < 20) {
    reasons.push('Completed in few steps without excessive retries');
  }

  return reasons.join('; ') || 'Standard successful implementation';
}

export function analyzeAutocodeFailureLearningRootCause(
  error: AutocodeSessionError,
  toolCalls: readonly string[],
): string {
  const errorMsg = error.message?.toLowerCase() ?? '';

  if (errorMsg.includes('not found') || errorMsg.includes('cannot find')) {
    return 'Missing file or dependency - insufficient context loaded';
  }

  if (errorMsg.includes('syntax') || errorMsg.includes('parse')) {
    return 'Syntax error in generated code - pattern not followed correctly';
  }

  if (errorMsg.includes('type') || errorMsg.includes('undefined')) {
    return 'Type error - incorrect type usage or missing type definitions';
  }

  if (errorMsg.includes('permission') || errorMsg.includes('access')) {
    return 'Permission error - tool execution blocked';
  }

  if (toolCalls.length > 50) {
    return 'Too many tool calls - approach was inefficient or stuck in loop';
  }

  if (toolCalls.filter((tool) => tool === 'Read').length < 3) {
    return 'Insufficient context gathering - should have read more files';
  }

  return error.message || 'Unknown root cause';
}

export function generateAutocodeFailurePreventionAdvice(
  _error: AutocodeSessionError,
  rootCause: string,
): string {
  if (rootCause.includes('Missing file')) {
    return 'Load all related files before implementing. Use Glob to find dependencies.';
  }

  if (rootCause.includes('Syntax error')) {
    return 'Study pattern files more carefully. Copy structure exactly.';
  }

  if (rootCause.includes('Type error')) {
    return 'Read type definition files. Run typecheck after implementation.';
  }

  if (rootCause.includes('Permission error')) {
    return 'Check file permissions. Use appropriate tools for the operation.';
  }

  if (rootCause.includes('Too many tool calls')) {
    return 'Plan before implementing. Break down into smaller steps.';
  }

  if (rootCause.includes('Insufficient context')) {
    return 'Read pattern files and related implementations first.';
  }

  return 'Review error message carefully and adjust approach accordingly.';
}

export function extractAutocodeInsights(input: AutocodeLearningAnalysisInput): string[] {
  const insights: string[] = [];
  const stepsExecuted = Math.max(1, input.sessionResult.stepsExecuted);
  const tokensPerStep = input.sessionResult.usage.totalTokens / stepsExecuted;

  if (tokensPerStep < 2000) {
    insights.push('Efficient token usage - concise and focused implementation');
  } else if (tokensPerStep > 5000) {
    insights.push('High token usage per step - may need more focused approach');
  }

  if (input.sessionResult.stepsExecuted < 10) {
    insights.push('Completed quickly with few steps - good planning');
  } else if (input.sessionResult.stepsExecuted > 30) {
    insights.push('Many steps required - complex task or inefficient approach');
  }

  const toolCalls = extractAutocodeToolCallSequence(input.sessionResult);
  if (new Set(toolCalls).size > 5) {
    insights.push('Used diverse set of tools - comprehensive approach');
  }

  return insights;
}

export function identifyAutocodeKeyFiles(input: Pick<AutocodeLearningAnalysisInput, 'subtask'>): string[] {
  const keyFiles: string[] = [];

  if (input.subtask.filesToModify) {
    keyFiles.push(...input.subtask.filesToModify);
  }

  if (input.subtask.patternFiles) {
    keyFiles.push(...input.subtask.patternFiles);
  }

  return [...new Set(keyFiles)];
}

export function mapAutocodeSessionOutcome(
  outcome: AutocodeSessionResult['outcome'] | string,
): 'success' | 'failure' | 'partial' | 'abandoned' {
  switch (outcome) {
    case 'completed':
      return 'success';
    case 'max_steps':
    case 'context_window':
      return 'partial';
    case 'cancelled':
      return 'abandoned';
    default:
      return 'failure';
  }
}

export function summarizeAutocodeSessionForMemory(
  knowledge: Pick<
    AutocodeExtractedKnowledge,
    'successPatterns' | 'failurePatterns' | 'insights' | 'subtaskId' | 'outcome'
  >,
): string {
  const parts = [
    knowledge.successPatterns?.[0]?.description,
    knowledge.successPatterns?.[0]?.approach,
    knowledge.failurePatterns?.[0]?.prevention,
    knowledge.insights[0],
  ].filter(Boolean);

  return parts.length > 0
    ? parts.join('\n')
    : `Completed work unit ${knowledge.subtaskId} with outcome ${knowledge.outcome}.`;
}

export function generateAutocodeLearningSessionId(
  timestampMs = Date.now(),
  randomValue = Math.random(),
): string {
  return `${timestampMs}_${randomValue.toString(36).slice(2, 11)}`;
}

export function formatAutocodeKnowledgeSummary(knowledge: AutocodeExtractedKnowledge): string {
  const lines: string[] = [];

  lines.push(`Session ${knowledge.sessionId} (${knowledge.outcome})`);
  lines.push(`- Success patterns: ${knowledge.successPatterns?.length ?? 0}`);
  lines.push(`- Failure patterns: ${knowledge.failurePatterns?.length ?? 0}`);
  lines.push(`- Code patterns: ${knowledge.codePatterns?.length ?? 0}`);
  lines.push(`- Insights: ${knowledge.insights.length}`);
  lines.push(`- Key files: ${knowledge.keyFiles.length}`);

  return lines.join('\n');
}

function extractAutocodeErrorHandlingPatterns(content: string, file: string): AutocodeCodePattern[] {
  const patterns: AutocodeCodePattern[] = [];
  const tryCatchMatch = content.match(/try\s*\{[\s\S]{20,200}\}\s*catch\s*\([^)]+\)\s*\{[\s\S]{20,200}\}/);

  if (tryCatchMatch) {
    patterns.push({
      category: 'error_handling',
      name: 'Try-Catch Block',
      code: tryCatchMatch[0].trim(),
      useCase: 'Handling errors in async operations',
      language: detectAutocodeCodeLanguage(file),
      sourceFile: file,
    });
  }

  return patterns;
}

function extractAutocodeApiPatterns(content: string, file: string): AutocodeCodePattern[] {
  const patterns: AutocodeCodePattern[] = [];
  const responseMatch = content.match(/return\s*\{[\s\S]{20,200}(success|data|error)[\s\S]{0,100}\}/);

  if (responseMatch) {
    patterns.push({
      category: 'api_design',
      name: 'API Response Format',
      code: responseMatch[0].trim(),
      useCase: 'Standardized API response structure',
      language: detectAutocodeCodeLanguage(file),
      sourceFile: file,
    });
  }

  return patterns;
}

function extractAutocodeStatePatterns(content: string, file: string): AutocodeCodePattern[] {
  const patterns: AutocodeCodePattern[] = [];
  const useStateMatch = content.match(/const\s*\[([^\]]+)\]\s*=\s*useState\([^)]*\)/);

  if (useStateMatch) {
    patterns.push({
      category: 'state_management',
      name: 'React useState Hook',
      code: useStateMatch[0].trim(),
      useCase: 'Managing component state in React',
      language: 'typescript',
      sourceFile: file,
    });
  }

  return patterns;
}

function detectAutocodeCodeLanguage(file: string): string {
  if (file.endsWith('.ts') || file.endsWith('.tsx')) {
    return 'typescript';
  }
  if (file.endsWith('.js') || file.endsWith('.jsx')) {
    return 'javascript';
  }
  if (file.endsWith('.py')) {
    return 'python';
  }
  if (file.endsWith('.go')) {
    return 'go';
  }
  if (file.endsWith('.rs')) {
    return 'rust';
  }
  return 'unknown';
}

function stringifyAutocodeMessageContent(content: AutocodeSessionMessage['content'] | unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}
