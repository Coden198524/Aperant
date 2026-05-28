/**
 * Quality Improvements Integration
 * =================================
 *
 * Central integration point for all quality improvement features.
 * Automatically applies appropriate quality checks and enhancements
 * based on configuration.
 */

import type { SubtaskInfo } from './build-orchestrator';
import type { SessionResult } from '../session/types';
import type { MemoryServiceImpl } from '../memory/memory-service';
import type { ProjectType } from '../../../shared/types';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAutocodeImplementationPlanSync } from '@autocode/core';

// Import all quality improvement modules
import { runPreQASmokeTests, formatSmokeTestResults } from './pre-qa-smoke-tests';
import { runIncrementalValidation, formatValidationResults } from './incremental-validation';
import { enhanceCoderPrompt, shouldInjectPatterns, formatInjectionSummary } from './pattern-injection';
import { generatePreImplementationChecklist, formatChecklistForPrompt, formatChecklistSummary } from './pre-implementation-checklist';
import { runSelfCritique, formatCritiqueSummary } from './self-critique';
import { analyzeFailureAndRecover, formatFailureAnalysis, formatRecoverySummary, type FailureRecord } from './context-aware-recovery';
import { extractAndStoreKnowledge, formatKnowledgeSummary } from './active-memory-learning';
import { determineQualityTier, formatTierClassification, formatTierSummary, getQAChecksForTier } from './tiered-quality-standards';

// =============================================================================
// Types
// =============================================================================

export interface QualityConfig {
  /** Enable pre-QA smoke tests */
  enablePreQASmokeTests?: boolean;
  /** Enable incremental validation */
  enableIncrementalValidation?: boolean;
  /** Enable pattern injection */
  enablePatternInjection?: boolean;
  /** Enable pre-implementation checklist */
  enablePreImplementationChecklist?: boolean;
  /** Enable self-critique */
  enableSelfCritique?: boolean;
  /** Enable context-aware recovery */
  enableContextAwareRecovery?: boolean;
  /** Enable active memory learning */
  enableActiveMemoryLearning?: boolean;
  /** Enable tiered quality standards */
  enableTieredQualityStandards?: boolean;
  /** Enable local documentation quality checks for documentation-only workflows */
  enableDocumentationQualityGate?: boolean;
  /** Project type used by specialized quality gates */
  projectType?: ProjectType;
  /** Memory service for learning and pattern retrieval */
  memoryService?: MemoryServiceImpl;
  /** Project ID for memory scoping */
  projectId?: string;
}

// Default configuration - balanced optimization (core features only)
// This aligns with the BALANCED_PRESET from workflow-config.ts
const DEFAULT_CONFIG: Required<Omit<QualityConfig, 'memoryService' | 'projectId' | 'projectType'>> = {
  enablePreQASmokeTests: false, // Disabled for balanced optimization
  enableIncrementalValidation: true, // Core feature - keep enabled
  enablePatternInjection: false, // Disabled for balanced optimization
  enablePreImplementationChecklist: false, // Disabled for balanced optimization
  enableSelfCritique: false, // Disabled - redundant with QA review
  enableContextAwareRecovery: true, // Core feature - keep enabled
  enableActiveMemoryLearning: true, // Core feature - keep enabled
  enableTieredQualityStandards: false, // Disabled for balanced optimization
  enableDocumentationQualityGate: true,
};

// =============================================================================
// Main Integration Functions
// =============================================================================

/**
 * Enhance coder prompt with all applicable quality improvements.
 *
 * @param basePrompt - Original coder prompt
 * @param subtask - Subtask information
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @param failureHistory - History of failed attempts (for recovery)
 * @returns Enhanced prompt
 */
export async function enhancePromptWithQuality(
  basePrompt: string,
  subtask: SubtaskInfo,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
  failureHistory?: FailureRecord[],
): Promise<string> {
  let enhancedPrompt = basePrompt;
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  // 1. Determine quality tier (if enabled)
  if (appliedConfig.enableTieredQualityStandards) {
    const tierClassification = determineQualityTier(subtask);
    console.log(formatTierSummary(tierClassification));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatTierClassification(tierClassification);
  }

  // 2. Add pre-implementation checklist (if enabled and first attempt)
  if (appliedConfig.enablePreImplementationChecklist && (!failureHistory || failureHistory.length === 0)) {
    const checklist = await generatePreImplementationChecklist({
      subtask,
      specDir,
      projectDir,
      memoryService: config.memoryService,
    });
    console.log(formatChecklistSummary(checklist));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatChecklistForPrompt(checklist);
  }

  // 3. Add context-aware recovery (if enabled and has failures)
  if (appliedConfig.enableContextAwareRecovery && failureHistory && failureHistory.length > 0) {
    const analysis = await analyzeFailureAndRecover(
      subtask,
      failureHistory,
      projectDir,
      specDir,
    );
    console.log(formatRecoverySummary(analysis));
    enhancedPrompt = enhancedPrompt + '\n\n' + formatFailureAnalysis(analysis);
  }

  // 4. Inject patterns (if enabled and pattern files exist)
  if (appliedConfig.enablePatternInjection && shouldInjectPatterns(subtask)) {
    const injectionResult = await enhanceCoderPrompt(enhancedPrompt, {
      subtask: {
        id: subtask.id,
        description: subtask.description,
        filesToModify: subtask.filesToModify,
        patternFiles: subtask.patternFiles,
      },
      projectDir,
      specDir,
      memoryService: config.memoryService,
    });
    console.log(formatInjectionSummary(injectionResult));
    enhancedPrompt = injectionResult.enhancedPrompt;
  }

  return enhancedPrompt;
}

/**
 * Validate subtask result with all applicable quality checks.
 *
 * @param subtask - Subtask information
 * @param sessionResult - Session result
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Validation result
 */
export async function validateSubtaskQuality(
  subtask: SubtaskInfo,
  sessionResult: SessionResult,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
): Promise<{ passed: boolean; issues: string[] }> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };
  const issues: string[] = [];

  // Only validate if session completed successfully
  if (sessionResult.outcome !== 'completed') {
    return { passed: true, issues: [] };
  }

  // 1. Run incremental validation (if enabled)
  if (appliedConfig.enableIncrementalValidation) {
    const validationResult = await runIncrementalValidation({
      subtaskId: subtask.id,
      filesModified: subtask.filesToModify || [],
      patternFiles: subtask.patternFiles,
      projectDir,
      specDir,
    });

    console.log(formatValidationResults(validationResult));

    if (!validationResult.passed) {
      const criticalFailures = validationResult.failures.filter(f => f.severity === 'error');
      issues.push(...criticalFailures.map(f => `${f.type}: ${f.message}`));
    }
  }

  // 2. Run self-critique (if enabled)
  // Note: This would require access to generated files, which we don't have here
  // Self-critique should be run within the agent session itself
  if (appliedConfig.projectType === 'game-mmo') {
    issues.push(...validateGameMmoCodingSummary(subtask, sessionResult));
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

/**
 * Run pre-QA quality checks.
 *
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 * @returns Whether checks passed and should proceed to QA
 */
export async function runPreQAQualityChecks(
  config: QualityConfig,
  projectDir: string,
  specDir: string,
): Promise<{ shouldProceedToQA: boolean; issues: string[] }> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  if (appliedConfig.enableDocumentationQualityGate) {
    const documentationResult = runDocumentationQualityGate(projectDir, specDir, appliedConfig.projectType);
    if (documentationResult.isDocumentationWorkflow && documentationResult.issues.length > 0) {
      return {
        shouldProceedToQA: false,
        issues: documentationResult.issues,
      };
    }
  }

  // Run pre-QA smoke tests (if enabled)
  if (appliedConfig.enablePreQASmokeTests) {
    const smokeTestResult = await runPreQASmokeTests(projectDir, specDir);
    console.log(formatSmokeTestResults(smokeTestResult));

    if (smokeTestResult.shouldReturnToCoding) {
      const criticalIssues = smokeTestResult.issues
        .filter(i => i.severity === 'critical')
        .map(i => `${i.check}: ${i.output.split('\n')[0]}`);

      return {
        shouldProceedToQA: false,
        issues: criticalIssues,
      };
    }
  }

  return {
    shouldProceedToQA: true,
    issues: [],
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function getDocumentationOutputs(plan: Record<string, unknown>): {
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
  base: 'spec' | 'project';
} {
  const outputs = plan.document_outputs && typeof plan.document_outputs === 'object'
    ? plan.document_outputs as Record<string, unknown>
    : {};
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const firstSubtask = phases
    .flatMap((phase) => phase && typeof phase === 'object' && Array.isArray((phase as Record<string, unknown>).subtasks)
      ? (phase as Record<string, unknown>).subtasks as unknown[]
      : [])
    .find((subtask) => subtask && typeof subtask === 'object') as Record<string, unknown> | undefined;
  const filesToCreate = stringArray(firstSubtask?.files_to_create);
  const markdownFromPlan = typeof outputs.final_markdown === 'string'
    ? outputs.final_markdown
    : filesToCreate.find((file) => file.toLowerCase().endsWith('.md'));

  return {
    finalMarkdown: markdownFromPlan || 'docs/analysis.md',
    outline: typeof outputs.outline === 'string' ? outputs.outline : 'doc_outline.json',
    evidenceIndex: typeof outputs.evidence_index === 'string' ? outputs.evidence_index : 'evidence_index.json',
    base: outputs.base === 'project' ? 'project' : 'spec',
  };
}

function validateJsonDocument(filePath: string, requiredKeys: string[]): string[] {
  const issues: string[] = [];
  const parsed = readJsonFile(filePath);
  if (!parsed) {
    return [`documentation: ${filePath} is missing or invalid JSON`];
  }
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      issues.push(`documentation: ${filePath} is missing "${key}"`);
    }
  }
  return issues;
}

function isGameMmoDocumentationPlan(plan: Record<string, unknown>): boolean {
  return plan.project_type === 'game-mmo' ||
    plan.documentation_profile === 'game-mmo-source' ||
    stringArray(plan.documentation_focus).some((item) => /\b(gameplay|client\/engine|server authority|network sync|anti-cheat|live operations)\b/i.test(item));
}

function hasAnyTerm(text: string, terms: RegExp[]): boolean {
  return terms.some((term) => term.test(text));
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}

function validateGameMmoDocumentationSupportFiles(
  outlinePath: string,
  evidencePath: string,
  outputPath: string,
): string[] {
  const issues: string[] = [];
  const outline = readJsonFile(outlinePath);
  const evidence = readJsonFile(evidencePath);
  const outlineText = jsonText(outline);
  const evidenceText = jsonText(evidence);

  const outlineChecks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'system matrix or system inventory section',
      terms: [/\bsystem matrix\b/i, /\bsystem inventory\b/i, /\b系统矩阵\b/, /\b系统清单\b/],
    },
    {
      label: 'cross-end flow, protocol, or sequence section',
      terms: [/\bcross[-\s]?end\b/i, /\bprotocol\b/i, /\bsequence\b/i, /\bclient.*server\b/i, /\b跨端\b/, /\b协议\b/, /\b时序\b/],
    },
    {
      label: 'data lifecycle, persistence, config, or content pipeline section',
      terms: [/\bdata lifecycle\b/i, /\bpersist/i, /\bconfig/i, /\bcontent pipeline\b/i, /\b数据生命周期\b/, /\b持久化\b/, /\b配置\b/, /\b内容管线\b/],
    },
    {
      label: 'risk review section covering performance/security/liveops',
      terms: [/\brisks?\b/i, /\bperformance\b/i, /\bsecurity\b/i, /\bliveops\b/i, /\b风险\b/, /\b性能\b/, /\b安全\b/, /\b运营\b/],
    },
  ];

  for (const check of outlineChecks) {
    if (!hasAnyTerm(outlineText, check.terms)) {
      issues.push(`documentation: ${outputPath} outline should include MMO ${check.label}`);
    }
  }

  const evidenceChecks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'client or engine evidence',
      terms: [/\bclient\b/i, /\bengine\b/i, /\brender/i, /\banimation\b/i, /\basset\b/i, /\b客户端\b/, /\b引擎\b/, /\b渲染\b/],
    },
    {
      label: 'server authority or network evidence',
      terms: [/\bserver\b/i, /\bauthorit/i, /\bnetwork\b/i, /\bprotocol\b/i, /\bsync\b/i, /\b服务端\b/, /\b权威\b/, /\b网络\b/, /\b协议\b/],
    },
    {
      label: 'data/config/persistence/tooling evidence',
      terms: [/\bdata\b/i, /\bconfig/i, /\bpersist/i, /\bsave\b/i, /\btool/i, /\bgm\b/i, /\b配置\b/, /\b数据\b/, /\b持久化\b/, /\b工具\b/],
    },
  ];

  for (const check of evidenceChecks) {
    if (!hasAnyTerm(evidenceText, check.terms)) {
      issues.push(`documentation: ${outputPath} evidence index should include MMO ${check.label}`);
    }
  }

  return issues;
}

function validateGameMmoDocumentation(markdown: string, outputPath: string): string[] {
  const issues: string[] = [];
  const checks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'gameplay systems/progression/combat/quests/economy',
      terms: [/\bgameplay\b/i, /\bcombat\b/i, /\bquest\b/i, /\bprogression\b/i, /\beconomy\b/i, /玩法|战斗|任务|成长|经济|装备|物品/],
    },
    {
      label: 'client, engine, rendering, animation, assets, or world streaming',
      terms: [/\bclient\b/i, /\bengine\b/i, /\brender/i, /\banimation\b/i, /\basset\b/i, /\bstreaming\b/i, /客户端|引擎|渲染|动画|资源|场景|地图|世界/],
    },
    {
      label: 'server authority, network sync, replication, protocol, prediction, or reconciliation',
      terms: [/\bserver\b/i, /\bauthorit/i, /\bnetwork\b/i, /\bsync\b/i, /\breplication\b/i, /\bprotocol\b/i, /\bprediction\b/i, /\breconciliation\b/i, /服务端|权威|网络|同步|协议|广播|预测|校正/],
    },
    {
      label: 'data/config/content pipeline, persistence, save state, account, GM, editor, or tooling',
      terms: [/\bdata\b/i, /\bconfig/i, /\bcontent\b/i, /\bpersist/i, /\bsave\b/i, /\baccount\b/i, /\bGM\b/, /\beditor\b/i, /\btool/i, /配置|数据|持久化|存档|账号|工具|编辑器|后台/],
    },
    {
      label: 'performance, security, anti-cheat, telemetry, live operations, or release risk',
      terms: [/\bperformance\b/i, /\bframe\b/i, /\blatency\b/i, /\bsecurity\b/i, /\banti[-\s]?cheat\b/i, /\btelemetry\b/i, /\bliveops\b/i, /\brelease\b/i, /性能|帧|延迟|安全|反作弊|埋点|运营|发布/],
    },
  ];

  for (const check of checks) {
    if (!hasAnyTerm(markdown, check.terms)) {
      issues.push(`documentation: ${outputPath} should cover MMO ${check.label}`);
    }
  }

  const hasProfessionalStructure = /\bmatrix\b|\bsequence\b|\blifecycle\b|\bstate machine\b|\bprotocol\b|\bdata lifecycle\b|系统矩阵|时序|生命周期|状态机|协议|数据流转/i.test(markdown);
  if (!hasProfessionalStructure) {
    issues.push(`documentation: ${outputPath} should include MMO professional structures such as system matrices, sequence flows, state machines, protocol/config tables, or data lifecycles`);
  }

  if (markdown.trim().length < 1600) {
    issues.push(`documentation: ${outputPath} is too short for MMO source documentation`);
  }

  return issues;
}

function isDocumentationSubtask(subtask: SubtaskInfo): boolean {
  const text = [
    subtask.description,
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].join(' ').toLowerCase();
  return /\b(documentation|document|docs|markdown|source analysis)\b/.test(text) ||
    /文档|源码分析|代码分析/.test(text);
}

function isGameMmoRiskRelevantSubtask(subtask: SubtaskInfo): boolean {
  const text = [
    subtask.description,
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].join(' ').toLowerCase();

  return /\b(server|client|network|protocol|sync|replication|prediction|reconciliation|database|persistence|save|account|economy|inventory|combat|quest|skill|item|engine|render|animation|asset|streaming|performance|security|anti[-\s]?cheat|telemetry|liveops|gm|tool|editor|build|release)\b/i.test(text) ||
    /服务端|客户端|网络|协议|同步|数据库|持久化|存档|账号|经济|背包|战斗|任务|技能|物品|引擎|渲染|动画|资源|性能|安全|反作弊|运营|工具|编辑器|构建|发布/.test(text);
}

function validateGameMmoCodingSummary(subtask: SubtaskInfo, sessionResult: SessionResult): string[] {
  if (isDocumentationSubtask(subtask) || !isGameMmoRiskRelevantSubtask(subtask)) {
    return [];
  }

  const summary = [
    ...sessionResult.messages.map((message) => {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      return content;
    }),
  ].join('\n');

  if (!summary.trim()) {
    return ['mmo-quality: completion summary is missing MMO risk and verification details'];
  }

  const lower = summary.toLowerCase();
  const issues: string[] = [];
  const hasVerification = /\bverification\b|\bverified\b|\btest\b|\bbuild\b|\btypecheck\b|\bsmoke\b|\bmanual\b|验证|测试|构建|检查/.test(lower);
  const hasMmoRiskLanguage = /\bserver authority\b|\bnetwork sync\b|\bpersistence\b|\bdata safety\b|\bperformance\b|\bsecurity\b|\banti[-\s]?cheat\b|\bliveops\b|\btooling\b|\bcontent pipeline\b|服务端|权威|网络|同步|持久化|数据|性能|安全|反作弊|运营|工具/.test(lower);
  const hasBoundaryLanguage = /\bclient\b|\bserver\b|\bauthoritative\b|\btrust boundary\b|\bprotocol\b|\bconfig\b|\bsave\b|\bruntime owner\b|客户端|服务端|权威|边界|协议|配置|存档|运行时/.test(lower);

  if (!hasVerification) {
    issues.push('mmo-quality: completion summary should state verification run or exact verification limitation');
  }
  if (!hasMmoRiskLanguage) {
    issues.push('mmo-quality: completion summary should include relevant MMO risk review domains');
  }
  if (!hasBoundaryLanguage) {
    issues.push('mmo-quality: completion summary should identify runtime owner, authority/trust boundary, or changed protocol/data/config contract when relevant');
  }

  return issues;
}

function runDocumentationQualityGate(
  projectDir: string,
  specDir: string,
  projectType?: ProjectType,
): { isDocumentationWorkflow: boolean; issues: string[] } {
  const plan = loadAutocodeImplementationPlanSync(specDir);
  const isDocumentationWorkflow = typeof plan?.workflow_type === 'string' &&
    plan.workflow_type.toLowerCase() === 'documentation';
  if (!isDocumentationWorkflow || !plan) {
    return { isDocumentationWorkflow: false, issues: [] };
  }

  const outputs = getDocumentationOutputs(plan);
  const issues: string[] = [];
  const isGameMmoDocumentation = projectType === 'game-mmo' || isGameMmoDocumentationPlan(plan);
  const outputBaseDir = outputs.base === 'project' ? projectDir : specDir;
  const outlinePath = join(outputBaseDir, outputs.outline);
  const evidencePath = join(outputBaseDir, outputs.evidenceIndex);
  const markdownPath = join(outputBaseDir, outputs.finalMarkdown);

  issues.push(...validateJsonDocument(outlinePath, ['document_type', 'audience', 'sections']));
  issues.push(...validateJsonDocument(evidencePath, ['files_read', 'evidence_backed_claims', 'open_questions']));
  if (isGameMmoDocumentation) {
    issues.push(...validateGameMmoDocumentationSupportFiles(outlinePath, evidencePath, outputs.finalMarkdown));
  }

  if (!existsSync(markdownPath)) {
    issues.push(`documentation: ${outputs.finalMarkdown} is missing`);
  } else {
    const markdown = readFileSync(markdownPath, 'utf-8');
    const hasHeadings = /^##\s+/m.test(markdown);
    const hasEvidence = /evidence|source|file|来源|证据|文件/i.test(markdown);
    const hasFlow = /flow|data flow|state|sequence|mermaid|流程|数据流|状态|时序/i.test(markdown);
    const hasRisksOrOpenQuestions = /risk|open question|unknown|unverified|风险|未确认|未知|待确认/i.test(markdown);
    if (markdown.trim().length < 800) {
      issues.push(`documentation: ${outputs.finalMarkdown} is too short for deep source documentation`);
    }
    if (!hasHeadings) {
      issues.push(`documentation: ${outputs.finalMarkdown} needs structured section headings`);
    }
    if (!hasEvidence) {
      issues.push(`documentation: ${outputs.finalMarkdown} must cite source/evidence files`);
    }
    if (!hasFlow) {
      issues.push(`documentation: ${outputs.finalMarkdown} should describe core flow, data flow, state flow, or sequence`);
    }
    if (!hasRisksOrOpenQuestions) {
      issues.push(`documentation: ${outputs.finalMarkdown} should include risks or open questions`);
    }
    if (isGameMmoDocumentation) {
      issues.push(...validateGameMmoDocumentation(markdown, outputs.finalMarkdown));
    }
  }

  return { isDocumentationWorkflow: true, issues };
}

/**
 * Learn from completed session (success or failure).
 *
 * @param subtask - Subtask information
 * @param sessionResult - Session result
 * @param config - Quality configuration
 * @param projectDir - Project directory
 * @param specDir - Spec directory
 */
export async function learnFromSession(
  subtask: SubtaskInfo,
  sessionResult: SessionResult,
  config: QualityConfig,
  projectDir: string,
  specDir: string,
): Promise<void> {
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  // Extract and store knowledge (if enabled)
  if (appliedConfig.enableActiveMemoryLearning && config.memoryService && config.projectId) {
    try {
      const knowledge = await extractAndStoreKnowledge({
        sessionResult,
        subtask,
        projectDir,
        specDir,
        memoryService: config.memoryService,
        projectId: config.projectId,
      });

      console.log(formatKnowledgeSummary(knowledge));
    } catch (error) {
      console.error('Failed to extract knowledge from session:', error);
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get default quality configuration.
 */
export function getDefaultQualityConfig(): QualityConfig {
  return { ...DEFAULT_CONFIG };
}

/**
 * Create quality configuration with specific features enabled.
 */
export function createQualityConfig(overrides: Partial<QualityConfig>): QualityConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

/**
 * Check if any quality features are enabled.
 */
export function hasQualityFeaturesEnabled(config: QualityConfig): boolean {
  return Object.values(config).some(v => v === true);
}

/**
 * Get list of enabled quality features.
 */
export function getEnabledFeatures(config: QualityConfig): string[] {
  const features: string[] = [];
  const appliedConfig = { ...DEFAULT_CONFIG, ...config };

  if (appliedConfig.enablePreQASmokeTests) features.push('Pre-QA Smoke Tests');
  if (appliedConfig.enableIncrementalValidation) features.push('Incremental Validation');
  if (appliedConfig.enablePatternInjection) features.push('Pattern Injection');
  if (appliedConfig.enablePreImplementationChecklist) features.push('Pre-Implementation Checklist');
  if (appliedConfig.enableSelfCritique) features.push('Self-Critique');
  if (appliedConfig.enableContextAwareRecovery) features.push('Context-Aware Recovery');
  if (appliedConfig.enableActiveMemoryLearning) features.push('Active Memory Learning');
  if (appliedConfig.enableTieredQualityStandards) features.push('Tiered Quality Standards');

  return features;
}
