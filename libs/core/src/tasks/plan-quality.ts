import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import { parseAutocodeImplementationPlanMarkdown } from './plan-store.js';
import { formatAutocodeRetryErrorLines } from '../text/compaction.js';

export type AutocodeEvidenceConfidence = 'low' | 'medium' | 'high';

export interface AutocodeContextEvidenceSource {
  path: string;
  symbol?: string;
  lines?: string;
  proves: string;
  confidence: AutocodeEvidenceConfidence;
}

export interface AutocodePlanArtifactLimit {
  maxLines: number;
  maxChars: number;
}

export interface AutocodePlanQualityLimits {
  context: AutocodePlanArtifactLimit;
  spec: AutocodePlanArtifactLimit;
  requirements: AutocodePlanArtifactLimit;
  tasks: AutocodePlanArtifactLimit;
}

export interface ValidateAutocodeStandardPlanArtifactsInput {
  specMarkdown?: string | null;
  requirementsMarkdown?: string | null;
  tasksMarkdown?: string | null;
  contextMarkdown?: string | null;
  limits?: Partial<AutocodePlanQualityLimits>;
  requireSpecEvidence?: boolean;
  requireRequirementsEvidence?: boolean;
  requireTaskEvidence?: boolean;
  requireContextEvidence?: boolean;
}

export interface AutocodePlanQualityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export const AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS: AutocodePlanQualityLimits = {
  context: { maxLines: 220, maxChars: 18_000 },
  spec: { maxLines: 150, maxChars: 16_000 },
  requirements: { maxLines: 160, maxChars: 14_000 },
  tasks: { maxLines: 900, maxChars: 64_000 },
};

const EMPTY_EVIDENCE_TOKENS = new Set([
  'none',
  'n/a',
  'na',
  'unknown',
  'todo',
  'tbd',
  'no evidence',
  'unspecified',
]);

const TRACEABLE_EVIDENCE_PATTERN =
  /\b(spec\.md|requirements\.md|context\.md|research\.md|agents\.md|readme|official|standard|docs?|source|project)\b|[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/i;

const GENERIC_TASK_TITLE_PATTERN =
  /^(?:implement|build|add|create|update|modify|wire|integrate|refactor|fix|improve|clean ?up|test)\s+(?:the\s+)?(?:feature|functionality|logic|code|implementation|changes?|updates?|module|components?|ui|backend|frontend|api|tests?|test coverage|docs?|documentation|files?|system|workflow|integration|support|structure|bug|issue)$/i;

const GENERIC_TASK_DESCRIPTION_PATTERN =
  /^(?:update|modify|implement|add|create|fix|refactor|test)\s+(?:the\s+)?(?:code|logic|feature|functionality|implementation|files?|tests?|changes?)\.?$/i;

const TASK_TITLE_STATE_LABEL_PATTERN =
  /^\s*(?:[\[(]\s*(?:needs[_\s-]*revision|revision[_\s-]*required|obsolete|superseded|deprecated)\s*[\])]\s*(?:[-:]\s*)?|(?:needs[_\s-]*revision|revision[_\s-]*required|obsolete|superseded|deprecated)\s*[-:]\s*)/iu;

const READ_ONLY_VALIDATION_TASK_PATTERN =
  /\b(?:validate|verify|verification|manual qa|qa|smoke|test|typecheck|lint|build)\b/i;

const LOCALIZED_TASK_DONE_SIGNAL_PATTERN = /完成条件|完成标准|验收标准|验收条件|成功标准/u;

const TASK_DONE_SIGNAL_PATTERN =
  /\b(?:done when|complete when|finished when|ready when|completion criteria|acceptance criteria|success criteria|success criterion)\b|完成条件|完成标准|验收标准|验收条件|成功标准/iu;

const PROJECT_SPECIFIC_TASK_ANCHOR_PATTERN =
  /[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+|\b(?:package|tsconfig|vite|vitest|webpack|rollup|biome|eslint|cargo|go|pyproject)\.[A-Za-z0-9.]+|\b[A-Z][A-Za-z0-9]*(?:Service|Manager|Controller|Adapter|Provider|Store|Repository|Bridge|Machine|Orchestrator|Runner|Renderer|Handler|Client|Config|Panel|Dialog|View|Model|Schema)\b|\buse[A-Z][A-Za-z0-9]+\b|\b[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*\b/;

const TASK_GRANULARITY_ACTION_TERMS = [
  'implement',
  'add',
  'create',
  'update',
  'modify',
  'wire',
  'integrate',
  'render',
  'persist',
  'migrate',
  'remove',
  'refactor',
  'handle',
  'support',
  'expose',
  'bind',
  'configure',
  'generate',
  'validate',
  'verify',
  'test',
  'build',
  '实现',
  '创建',
  '新增',
  '添加',
  '更新',
  '修改',
  '接入',
  '绑定',
  '绘制',
  '渲染',
  '构建',
  '验证',
  '测试',
  '支持',
  '处理',
  '保存',
  '读取',
  '生成',
  '配置',
  '清除',
  '消除',
  '旋转',
  '移动',
  '软降',
  '硬降',
  '锁定',
  '下落',
  '持久化',
  '重开',
  '暂停',
  '判定',
];

const TASK_GRANULARITY_BOUNDARY_TERMS = [
  'ui',
  'view',
  'state',
  'store',
  'ipc',
  'api',
  'service',
  'domain',
  'persistence',
  'worker',
  'background',
  'build',
  'tooling',
  'test',
  'docs',
  'renderer',
  'input',
  'storage',
  'scoring',
  'layout',
  'rendering',
  'gameplay',
  '状态',
  '存储',
  '渲染',
  '输入',
  '布局',
  '测试',
  '构建',
  '持久化',
  '计分',
  '等级',
  '控制',
  '界面',
  '规则',
];

const COMPLEX_PLAN_SIGNAL_TERMS = [
  'cross-module',
  'public contract',
  'contract',
  'persistence',
  'storage',
  'localStorage',
  'database',
  'migration',
  'refactor',
  'concurrency',
  'security',
  'worker',
  'background',
  'ipc',
  'api',
  'runtime',
  'browser',
  'canvas',
  'render',
  'rendering',
  'input',
  'keyboard',
  'touch',
  'responsive',
  'game',
  'gameplay',
  'state machine',
  'launch',
  'startup',
  'HTTP',
  'file:',
];

const ARCHITECTURE_REFERENCE_HEADING_PATTERN =
  /^#{2,4}\s+(Architecture|Design\s+Patterns?|Architecture\s+(?:And|&)\s+Design\s+Pattern(?:s)?(?:\s+References?)?|Architecture\s+References?|Design\s+Pattern\s+References?|架构|设计模式)\b/im;

const ARCHITECTURE_REFERENCE_CONTENT_PATTERN =
  /\b(?:source|project|docs?|memory|Project Memory|Memory Context|workflow recipe|pattern|decision|module insight|general guidance|engineering experience|official|standard|src\/|tests\/)\b|[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+|通用工程经验|项目|记忆|源码|参考|模式|架构/iu;

const ARCHITECTURE_BOUNDARY_PATTERN =
  /\b(?:boundary|layer|module|component|service|adapter|core|domain|state|ui|view|renderer|rendering|input|browser|canvas|persistence|storage|api|ipc|worker|test|contract|model|store|repository|rules?|loop|hud)\b|架构|边界|分层|模块|组件|核心|领域|状态|渲染|输入|浏览器|持久|存储|接口|契约|规则|主循环|界面|测试/u;

const ARCHITECTURE_PATTERN_STRATEGY_PATTERN =
  /\b(?:pattern|strategy|architecture|separation|separate|decoupl|adapter|facade|repository|state machine|finite state|fsm|reducer|pure function|dependency injection|inject|ports?|event|command|pipeline|orchestrator|service|contract|interface|single responsibility|deterministic|idempotent)\b|模式|策略|分离|解耦|适配器|状态机|纯函数|注入|事件|命令|管道|确定性|幂等|职责/u;

const TASK_ARCHITECTURE_GUIDANCE_MARKER_PATTERN =
  /\b(?:architecture|architecture\/pattern|design pattern|pattern guidance|boundary\/pattern)\s*:|架构\s*[:：]|设计模式\s*[:：]/iu;

const PLAN_ARTIFACT_FILE_NAMES = new Set([
  AUTOCODE_TASK_ARTIFACTS.specFile.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.requirements.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.context.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.research.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.tasks.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.implementationPlan.toLowerCase(),
  AUTOCODE_TASK_ARTIFACTS.qaReport.toLowerCase(),
  'build-progress.txt',
]);

export function validateAutocodeStandardPlanArtifacts(
  input: ValidateAutocodeStandardPlanArtifactsInput,
): AutocodePlanQualityResult {
  const limits = mergeAutocodePlanQualityLimits(input.limits);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (input.specMarkdown !== undefined && input.specMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.specFile, input.specMarkdown, limits.spec));
    if (input.requireSpecEvidence) {
      errors.push(...validateSpecEvidence(input.specMarkdown));
    }
  } else if (input.requireSpecEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} is missing.`);
  }

  if (input.requirementsMarkdown !== undefined && input.requirementsMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.requirements, input.requirementsMarkdown, limits.requirements));
    if (input.requireRequirementsEvidence) {
      errors.push(...validateRequirementsEvidence(input.requirementsMarkdown));
    }
  } else if (input.requireRequirementsEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.requirements} is missing.`);
  }

  if (input.tasksMarkdown !== undefined && input.tasksMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.tasks, input.tasksMarkdown, limits.tasks));
    if (input.requireTaskEvidence) {
      errors.push(...validateTasksEvidence(input.tasksMarkdown));
      errors.push(...validateComplexPlanArchitectureReferences({
        specMarkdown: input.specMarkdown ?? undefined,
        tasksMarkdown: input.tasksMarkdown,
      }));
    }
  } else if (input.requireTaskEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} is missing.`);
  }

  if (input.contextMarkdown !== undefined && input.contextMarkdown !== null) {
    errors.push(...validateMarkdownSize(AUTOCODE_TASK_ARTIFACTS.context, input.contextMarkdown, limits.context));
    errors.push(...validateContextMarkdownEvidence(input.contextMarkdown, input.requireContextEvidence === true));
  } else if (input.requireContextEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} is missing.`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

export function buildAutocodePlanQualityRetryPrompt(errors: string[]): string {
  return [
    'REWRITE STANDARD PLAN ARTIFACTS',
    '',
    'The previous Standard planning artifacts failed quality validation.',
    '',
    'Errors:',
    ...formatAutocodeRetryErrorLines(errors),
    '',
    'Repair only the affected artifacts with the Write/Edit tools.',
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.specFile} as a compact decision index, not a full analysis dump.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.requirements} focused on requirements, acceptance criteria, constraints, evidence sources, standards, and assumptions.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.tasks} detailed but compact: split broad work into OpenSpec-grade leaf tasks while keeping each task guidance short.`,
    '- A leaf task should cover one independently reviewable behavior or contract and one focused verification path.',
    '- Split tasks that cover more than three behaviors, more than three requirement/acceptance references, or more than four write-intent files.',
    '- If split tasks touch the same file, use _Depends on: ..._ to serialize the writes instead of merging independent behavior.',
    '- Replace generic task text with concrete behavior, affected project boundary, likely files/APIs, and the existing pattern to follow.',
    '- For complex or high-risk plans only, include a detailed but compact Architecture And Design Pattern References section in spec.md or tasks.md: 4-8 bullets covering affected boundaries/layers, recommended pattern or strategy, source/docs/Project Memory reference or labeled general guidance, and which task IDs/boundaries should apply it.',
    '- For complex or high-risk plans, each non-read-only executable task must include one short _Architecture: boundary; pattern/strategy; source/reference_ line so implementation agents can apply the guidance directly.',
    '- Never prefix executable task titles with revision, obsolete, or other state labels. Do not introduce revision/history markers unless real human Request Changes context already requires them.',
    '- Every executable task must include _Requirements: ..._, _Evidence: ..._, a done signal such as _Done when: ..._, and _Verification: ..._.',
    '- Preserve requirement IDs and unaffected design/task content during Request Changes iterations.',
    '- Use Evidence references instead of copying source code or long research notes.',
    '- If evidence is missing, add an assumption/open question or validation task instead of inventing implementation work.',
  ].join('\n');
}

export function isAutocodePlanTaskGranularityError(error: string): boolean {
  return /\btasks\.md task \S+ is too broad;/.test(error);
}

export function hasOnlyAutocodePlanTaskGranularityErrors(errors: string[]): boolean {
  return errors.length > 0 && errors.every(isAutocodePlanTaskGranularityError);
}

function validateComplexPlanArchitectureReferences(input: {
  specMarkdown?: string;
  tasksMarkdown: string;
}): string[] {
  if (!isComplexStandardPlan(input.tasksMarkdown, input.specMarkdown)) {
    return [];
  }
  const sections = [
    ...getArchitectureReferenceSections(input.tasksMarkdown),
    ...getArchitectureReferenceSections(input.specMarkdown ?? ''),
  ];
  if (sections.length === 0) {
    return [
      `${AUTOCODE_TASK_ARTIFACTS.tasks} describes a complex or high-risk plan but ${AUTOCODE_TASK_ARTIFACTS.specFile}/${AUTOCODE_TASK_ARTIFACTS.tasks} has no visible Architecture And Design Pattern References section; add a compact 4-8 bullet section for complex tasks only, citing project source/docs/Project Memory or labeled general engineering guidance.`,
    ];
  }
  return [
    ...validateArchitectureReferenceSectionDetail(sections.join('\n\n')),
    ...validateComplexTaskArchitectureGuidance(input.tasksMarkdown),
  ];
}

function isComplexStandardPlan(tasksMarkdown: string, specMarkdown?: string): boolean {
  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  } catch {
    return false;
  }

  const subtasks = getPlanSubtasks(plan);
  if (subtasks.length >= 8) {
    return true;
  }

  const writeIntentFiles = uniqueStringArray(subtasks.flatMap((subtask) => [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ])).filter((item) => !EMPTY_EVIDENCE_TOKENS.has(item.toLowerCase()));
  if (writeIntentFiles.length >= 6 && getPlanWriteBoundaryCount(writeIntentFiles) >= 3) {
    return true;
  }

  const planText = `${singleLine(plan.feature)}\n${tasksMarkdown}\n${specMarkdown ?? ''}`;
  const signalCount = countTermSignals(planText, COMPLEX_PLAN_SIGNAL_TERMS);
  return signalCount >= 4 && (subtasks.length >= 3 || writeIntentFiles.length >= 4);
}

function getPlanWriteBoundaryCount(files: string[]): number {
  const boundaries = new Set<string>();
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    if (normalized.includes('/test') || normalized.startsWith('test')) {
      boundaries.add('tests');
    } else if (normalized.endsWith('.html')) {
      boundaries.add('html');
    } else if (normalized.endsWith('.css') || normalized.endsWith('.scss')) {
      boundaries.add('styles');
    } else if (/\b(?:storage|persistence|db)\b/.test(normalized)) {
      boundaries.add('persistence');
    } else if (/\b(?:game|canvas|render|renderer|ui|app)\b/.test(normalized)) {
      boundaries.add('runtime-ui');
    } else if (/\b(?:core|domain|model|state)\b/.test(normalized)) {
      boundaries.add('domain');
    } else {
      boundaries.add(normalized.split('/').slice(0, 2).join('/') || normalized);
    }
  }
  return boundaries.size;
}

function getArchitectureReferenceSections(markdown: string): string[] {
  return findArchitectureReferenceHeadings(markdown)
    .map((heading) => getMarkdownSection(markdown, heading))
    .filter((section) => section.length > 0 && ARCHITECTURE_REFERENCE_CONTENT_PATTERN.test(section));
}

function validateArchitectureReferenceSectionDetail(section: string): string[] {
  const errors: string[] = [];
  const bullets = section
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line));
  const detailedBullets = bullets.filter(hasDetailedArchitectureReferenceBullet);
  const taskApplicationSignals = countTaskApplicationSignals(section);

  if (bullets.length < 4) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} Architecture And Design Pattern References is too thin; include 4-8 bullets covering boundaries/layers, pattern or strategy, source/reference, and task application.`);
  }
  if (detailedBullets.length < 3) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} Architecture And Design Pattern References needs at least three actionable bullets that each name a boundary/layer, a pattern or strategy, and a project/source/general reference.`);
  }
  if (taskApplicationSignals < 2) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} Architecture And Design Pattern References must say where the guidance applies, such as affected task IDs, phases, work packages, or implementation boundaries.`);
  }

  return errors;
}

function hasDetailedArchitectureReferenceBullet(line: string): boolean {
  return line.length >= 48 &&
    ARCHITECTURE_BOUNDARY_PATTERN.test(line) &&
    ARCHITECTURE_PATTERN_STRATEGY_PATTERN.test(line) &&
    ARCHITECTURE_REFERENCE_CONTENT_PATTERN.test(line);
}

function countTaskApplicationSignals(text: string): number {
  const signals = new Set<string>();
  for (const match of text.matchAll(/\b\d+\.\d+\b/g)) {
    signals.add(match[0]);
  }
  if (/\b(?:task|subtask|work package|phase|apply|applies|follow in|use in|implementation boundary|executable)\b/i.test(text)) {
    signals.add('english-application');
  }
  if (/任务|子任务|工作包|阶段|应用|适用|执行|落地|边界/u.test(text)) {
    signals.add('localized-application');
  }
  return signals.size;
}

function validateComplexTaskArchitectureGuidance(tasksMarkdown: string): string[] {
  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  } catch {
    return [];
  }

  const tasksNeedingGuidance = getPlanSubtasks(plan).filter((subtask) => {
    const record = subtask as Record<string, unknown>;
    return !isReadOnlyValidationTask(record, singleLine(record.title), singleLine(record.description));
  });
  if (tasksNeedingGuidance.length === 0) {
    return [];
  }

  const missing = tasksNeedingGuidance
    .filter((subtask) => !hasTaskArchitectureGuidance(subtask as Record<string, unknown>))
    .map((subtask) => singleLine((subtask as Record<string, unknown>).id) || 'unknown');

  if (missing.length === 0) {
    return [];
  }

  const preview = missing.slice(0, 8).join(', ');
  return [
    `${AUTOCODE_TASK_ARTIFACTS.tasks} complex task(s) missing _Architecture: ..._ guidance (${preview}${missing.length > 8 ? ', ...' : ''}); each non-read-only executable task must name boundary, pattern/strategy, and source/reference or labeled general guidance.`,
  ];
}

function hasTaskArchitectureGuidance(subtask: Record<string, unknown>): boolean {
  const text = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.evidence),
    ...stringArrayField(subtask.pattern_files),
  ].join('\n');
  if (!TASK_ARCHITECTURE_GUIDANCE_MARKER_PATTERN.test(text)) {
    return false;
  }
  return ARCHITECTURE_BOUNDARY_PATTERN.test(text) &&
    ARCHITECTURE_PATTERN_STRATEGY_PATTERN.test(text) &&
    ARCHITECTURE_REFERENCE_CONTENT_PATTERN.test(text);
}

function findArchitectureReferenceHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = ARCHITECTURE_REFERENCE_HEADING_PATTERN.exec(line);
    if (match) {
      headings.push(match[1].trim());
    }
  }
  return headings;
}

export function normalizeAutocodeContextEvidenceSources(value: unknown): AutocodeContextEvidenceSource[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(normalizeAutocodeContextEvidenceSource)
    .filter((item): item is AutocodeContextEvidenceSource => Boolean(item));
}

export function normalizeAutocodeContextEvidenceSource(value: unknown): AutocodeContextEvidenceSource | null {
  if (typeof value === 'string') {
    const [pathPart, ...rest] = value.split(/\s+-\s+/);
    const path = singleLine(pathPart);
    const proves = singleLine(rest.join(' - ')) || path;
    if (!path || !proves) {
      return null;
    }
    return {
      path,
      proves,
      confidence: 'medium',
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.source);
  const symbol = singleLine(record.symbol ?? record.name ?? record.function ?? record.class);
  const lines = singleLine(record.lines ?? record.line_range ?? record.range);
  const proves = singleLine(record.proves ?? record.reason ?? record.claim ?? record.description ?? record.pattern);
  const confidence = normalizeAutocodeEvidenceConfidence(record.confidence);
  if (!path || !proves) {
    return null;
  }

  return {
    path,
    ...(symbol ? { symbol } : {}),
    ...(lines ? { lines } : {}),
    proves,
    confidence,
  };
}

export function isMeaningfulAutocodeEvidence(value: unknown): boolean {
  const text = singleLine(value).toLowerCase();
  return text.length >= 6 && !EMPTY_EVIDENCE_TOKENS.has(text);
}

export function isTraceableAutocodeEvidence(value: unknown): boolean {
  const text = singleLine(value);
  return isMeaningfulAutocodeEvidence(text) && TRACEABLE_EVIDENCE_PATTERN.test(text);
}

function mergeAutocodePlanQualityLimits(
  overrides?: Partial<AutocodePlanQualityLimits>,
): AutocodePlanQualityLimits {
  return {
    context: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.context, ...overrides?.context },
    spec: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.spec, ...overrides?.spec },
    requirements: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.requirements, ...overrides?.requirements },
    tasks: { ...AUTOCODE_STANDARD_PLAN_QUALITY_LIMITS.tasks, ...overrides?.tasks },
  };
}

function validateMarkdownSize(fileName: string, content: string, limit: AutocodePlanArtifactLimit): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n').length;
  const chars = content.length;
  const errors: string[] = [];
  if (lines > limit.maxLines) {
    errors.push(`${fileName} is too large: ${lines} lines exceeds ${limit.maxLines}; compress it and keep detailed evidence in context/research/tasks references.`);
  }
  if (chars > limit.maxChars) {
    errors.push(`${fileName} is too large: ${chars} chars exceeds ${limit.maxChars}; remove copied source, long rationale, or duplicate analysis.`);
  }
  return errors;
}

function validateSpecEvidence(specMarkdown: string): string[] {
  const errors: string[] = [];
  const evidenceSection = getMarkdownSection(specMarkdown, 'Evidence');
  const hasGlobalEvidence = Boolean(evidenceSection && /(?:^|\n)\s*(?:[-*]|\d+\.)\s+\S/.test(evidenceSection));
  if (!/^\s*##\s+Evidence\b/im.test(specMarkdown)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} missing "## Evidence" section.`);
  }
  if (hasSectionContent(specMarkdown, 'Requirements') && !sectionContainsEvidence(specMarkdown, 'Requirements') && !hasGlobalEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Requirements section must cite Evidence for requirements or acceptance criteria.`);
  }
  if (hasSectionContent(specMarkdown, 'Design Notes') && !sectionContainsEvidence(specMarkdown, 'Design Notes') && !hasGlobalEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Design Notes must cite Evidence or move unverified claims to Assumptions/Open Questions.`);
  }
  return errors;
}

function validateRequirementsEvidence(requirementsMarkdown: string): string[] {
  const evidenceSection = getMarkdownSection(requirementsMarkdown, 'Evidence Sources');
  if (!evidenceSection || !/-\s+\S/.test(evidenceSection)) {
    return [`${AUTOCODE_TASK_ARTIFACTS.requirements} missing non-empty "Evidence Sources" section.`];
  }
  return [];
}

function validateTasksEvidence(tasksMarkdown: string): string[] {
  let plan;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  } catch (error) {
    return [`${AUTOCODE_TASK_ARTIFACTS.tasks} could not be parsed: ${error instanceof Error ? error.message : String(error)}`];
  }

  const errors: string[] = [];
  const subtasks = getPlanSubtasks(plan);
  if (subtasks.length === 0) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} contains no executable subtasks.`);
  }

  for (const subtask of subtasks) {
    const record = subtask as Record<string, unknown>;
    const id = singleLine(record.id) || 'unknown';
    const title = singleLine(record.title);
    if (hasTaskTitleStateLabel(title)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} has a state label in its title; move needs_revision/obsolete markers to a detail note or metadata line and keep the executable title behavior-focused.`);
    }
    if (!hasMeaningfulTaskRequirements(record)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing _Requirements: ..._ metadata; cite requirement, scenario, acceptance criterion, or success criterion IDs.`);
    }
    if (!isMeaningfulAutocodeEvidence(record.evidence)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing _Evidence: ..._ metadata.`);
    } else if (!isTraceableAutocodeEvidence(record.evidence)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} has vague _Evidence_; cite spec.md, requirements.md, ${AUTOCODE_TASK_ARTIFACTS.context}, ${AUTOCODE_TASK_ARTIFACTS.research}, project source/docs, or official/industry references.`);
    }
    if (!hasTaskDoneSignal(record)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} missing a done signal; add _Done when: ..._ or explicit completion criteria.`);
    }
  }
  errors.push(...validateTaskProjectSpecificity(plan));
  errors.push(...validateTaskGranularity(plan));
  return errors;
}

function validateTaskProjectSpecificity(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): string[] {
  const errors: string[] = [];
  let executableTaskCount = 0;
  let anchoredTaskCount = 0;

  for (const subtask of getPlanSubtasks(plan)) {
    executableTaskCount += 1;
    const record = subtask as Record<string, unknown>;
    const id = singleLine(record.id) || 'unknown';
    const title = singleLine(record.title);
    const description = singleLine(record.description);
    const hasAnchor = hasProjectSpecificTaskAnchor(record);
    if (hasAnchor) {
      anchoredTaskCount += 1;
    }

    if (isReadOnlyValidationTask(record, title, description)) {
      continue;
    }
    if (isGenericTaskTitle(title) && !hasAnchor) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} is too generic; name the concrete project boundary, behavior, and source/API pattern it follows.`);
    } else if (isGenericTaskDescription(title, description) && !hasAnchor) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} has boilerplate guidance; add project-specific files, APIs, module boundaries, or existing patterns.`);
    }
  }

  if (executableTaskCount > 0 && anchoredTaskCount === 0) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} has no project-specific task anchors; cite source files, project docs, APIs, commands, or explicit files to create/modify.`);
  }

  return errors;
}

function validateTaskGranularity(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): string[] {
  const errors: string[] = [];

  for (const subtask of getPlanSubtasks(plan)) {
    const record = subtask as Record<string, unknown>;
    const id = singleLine(record.id) || 'unknown';
    const title = singleLine(record.title);
    const description = singleLine(record.description);

    if (isReadOnlyValidationTask(record, title, description)) {
      continue;
    }

    const metrics = analyzeTaskGranularity(record, title, description);
    if (!isTaskTooBroad(metrics)) {
      continue;
    }

    errors.push(
      `${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} is too broad; split it into OpenSpec-grade leaf tasks by behavior, requirement/acceptance scenario, file or contract boundary, and verification path (${describeTaskGranularityMetrics(metrics)}).`,
    );
  }

  return errors;
}

interface TaskGranularityMetrics {
  behaviorSignals: number;
  boundarySignals: number;
  requirementReferences: number;
  writeIntentFiles: number;
  listSeparators: number;
  descriptionChars: number;
}

function analyzeTaskGranularity(
  subtask: Record<string, unknown>,
  title: string,
  description: string,
): TaskGranularityMetrics {
  const taskText = `${title}\n${description}`;
  return {
    behaviorSignals: countTermSignals(taskText, TASK_GRANULARITY_ACTION_TERMS),
    boundarySignals: countTermSignals(taskText, TASK_GRANULARITY_BOUNDARY_TERMS),
    requirementReferences: estimateTaskRequirementReferenceCount(subtask),
    writeIntentFiles: countTaskWriteIntentFiles(subtask),
    listSeparators: countTaskListSeparators(taskText),
    descriptionChars: description.length,
  };
}

function isTaskTooBroad(metrics: TaskGranularityMetrics): boolean {
  if (metrics.behaviorSignals >= 8) {
    return true;
  }
  if (metrics.requirementReferences >= 4 && metrics.behaviorSignals >= 4) {
    return true;
  }
  if (metrics.writeIntentFiles >= 5 && metrics.requirementReferences >= 3) {
    return true;
  }
  if (metrics.descriptionChars >= 360 && metrics.listSeparators >= 6) {
    return true;
  }

  let score = 0;
  if (metrics.behaviorSignals >= 6) score += 2;
  else if (metrics.behaviorSignals >= 4) score += 1;
  if (metrics.requirementReferences >= 4) score += 2;
  if (metrics.writeIntentFiles >= 5) score += 2;
  else if (metrics.writeIntentFiles >= 4) score += 1;
  if (metrics.listSeparators >= 8) score += 1;
  if (metrics.boundarySignals >= 4) score += 1;
  return score >= 3;
}

function describeTaskGranularityMetrics(metrics: TaskGranularityMetrics): string {
  return [
    `${metrics.behaviorSignals} behavior signal(s)`,
    `${metrics.requirementReferences} requirement/acceptance reference(s)`,
    `${metrics.writeIntentFiles} write-intent file(s)`,
  ].join(', ');
}

function getPlanSubtasks(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): Record<string, unknown>[] {
  const subtasks: Record<string, unknown>[] = [];
  for (const phase of plan.phases ?? []) {
    const phaseSubtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const subtask of phaseSubtasks) {
      if (subtask && typeof subtask === 'object' && !Array.isArray(subtask)) {
        subtasks.push(subtask as Record<string, unknown>);
      }
    }
  }
  return subtasks;
}

function hasMeaningfulTaskRequirements(subtask: Record<string, unknown>): boolean {
  return stringArrayField(subtask.requirements).some(isMeaningfulTaskRequirement);
}

function isMeaningfulTaskRequirement(value: string): boolean {
  const text = singleLine(value).toLowerCase();
  return text.length > 0 && !EMPTY_EVIDENCE_TOKENS.has(text) && text !== 'no requirements';
}

function hasTaskDoneSignal(subtask: Record<string, unknown>): boolean {
  const explicitDoneFields = [
    subtask.done_when,
    subtask.doneWhen,
    subtask.completion_criteria,
    subtask.completionCriteria,
    subtask.acceptance_criteria,
    subtask.acceptanceCriteria,
    subtask.success_criteria,
    subtask.successCriteria,
  ];
  if (explicitDoneFields.some(isMeaningfulAutocodeEvidence)) {
    return true;
  }

  const taskText = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.completion_summary),
    stringifyTaskValue(subtask.notes),
  ].join(' ');
  return TASK_DONE_SIGNAL_PATTERN.test(taskText) || LOCALIZED_TASK_DONE_SIGNAL_PATTERN.test(taskText);
}

function isReadOnlyValidationTask(
  subtask: Record<string, unknown>,
  title: string,
  description: string,
): boolean {
  const writeIntent = [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ].filter((item) => !EMPTY_EVIDENCE_TOKENS.has(item.toLowerCase()));
  if (writeIntent.length > 0) {
    return false;
  }

  return READ_ONLY_VALIDATION_TASK_PATTERN.test([title, description].join(' '));
}

function hasProjectSpecificTaskAnchor(subtask: Record<string, unknown>): boolean {
  const fileAnchors = [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
    ...stringArrayField(subtask.pattern_files),
  ];
  if (fileAnchors.some(isProjectSpecificFileAnchor)) {
    return true;
  }

  const taskText = stripPlanArtifactMentions([
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.evidence),
    stringifyTaskValue(subtask.verification),
  ].join(' '));

  return PROJECT_SPECIFIC_TASK_ANCHOR_PATTERN.test(taskText);
}

function isGenericTaskTitle(title: string): boolean {
  return GENERIC_TASK_TITLE_PATTERN.test(normalizeTaskQualityText(title));
}

function hasTaskTitleStateLabel(title: string): boolean {
  return TASK_TITLE_STATE_LABEL_PATTERN.test(title);
}

function isGenericTaskDescription(title: string, description: string): boolean {
  const normalizedDescription = normalizeTaskQualityText(description);
  if (!normalizedDescription || normalizedDescription === normalizeTaskQualityText(title)) {
    return true;
  }
  return GENERIC_TASK_DESCRIPTION_PATTERN.test(normalizedDescription);
}

function normalizeTaskQualityText(value: string): string {
  return value
    .replace(/[`*_()[\]{}:;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isProjectSpecificFileAnchor(value: string): boolean {
  const normalized = value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .trim()
    .toLowerCase();
  if (!normalized || EMPTY_EVIDENCE_TOKENS.has(normalized)) {
    return false;
  }
  const fileName = normalized.split('/').pop() ?? normalized;
  return !PLAN_ARTIFACT_FILE_NAMES.has(fileName);
}

function countTermSignals(text: string, terms: string[]): number {
  return terms.filter((term) => containsTaskTerm(text, term)).length;
}

function containsTaskTerm(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/^[A-Za-z0-9_-]+$/u.test(term)) {
    return new RegExp(`\\b${escaped}\\b`, 'iu').test(text);
  }
  return text.includes(term);
}

function estimateTaskRequirementReferenceCount(subtask: Record<string, unknown>): number {
  const requirements = stringArrayField(subtask.requirements);
  if (requirements.length === 0) {
    return 0;
  }

  const text = requirements.join(', ');
  const rangePattern = /\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\b/g;
  let count = 0;
  for (const match of text.matchAll(rangePattern)) {
    count += estimateNumericRangeSize(match[1], match[2]);
  }
  const textWithoutRanges = text.replace(rangePattern, ' ');
  const individualReferences = textWithoutRanges.match(/\b\d+(?:\.\d+)?\b/g) ?? [];
  count += individualReferences.length;
  if (/\b(?:all|every)\b|全部|所有/u.test(text)) {
    count += 4;
  }
  return Math.max(count, requirements.length);
}

function estimateNumericRangeSize(startValue: string, endValue: string): number {
  const start = Number(startValue.split('.')[0]);
  const end = Number(endValue.split('.')[0]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return 2;
  }
  return Math.min(12, end - start + 1);
}

function countTaskWriteIntentFiles(subtask: Record<string, unknown>): number {
  return uniqueStringArray([
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ].filter((item) => !EMPTY_EVIDENCE_TOKENS.has(item.toLowerCase()))).length;
}

function countTaskListSeparators(text: string): number {
  const separators = text.match(/[、，,;；]/gu) ?? [];
  const conjunctions = text.match(/\b(?:and|plus)\b|以及|并且|同时/uig) ?? [];
  return separators.length + conjunctions.length;
}

function uniqueStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    unique.push(value);
  }
  return unique;
}

function stripPlanArtifactMentions(value: string): string {
  return value.replace(/\b(?:spec|requirements|context|research|tasks|implementation_plan|build-progress|qa_report|human_input|change_requests)\.(?:md|jsonl?)\b/gi, ' ');
}

function stringArrayField(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => singleLine(item)).filter(Boolean);
}

function stringifyTaskValue(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return singleLine(value);
  }
  if (Array.isArray(value)) {
    return value.map(stringifyTaskValue).filter(Boolean).join(' ');
  }
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).map(stringifyTaskValue).filter(Boolean).join(' ');
  }
  return '';
}

export function stringifyAutocodeContextMarkdown(contextData: unknown): string {
  const context = parseContextObject(contextData) ?? {};
  const lines: string[] = ['# Project Context', ''];
  const taskDescription = singleLine(context.task_description);
  if (taskDescription) {
    addSection(lines, 'Task', [taskDescription]);
  }

  addSection(lines, 'Scoped Services', toBulletItems(context.scoped_services));

  const architectureSummary = singleLine(context.architecture_summary);
  if (architectureSummary) {
    addSection(lines, 'Architecture Summary', [architectureSummary]);
  }

  addSection(lines, 'Files To Modify', formatFileModificationItems(context.files_to_modify));
  addSection(lines, 'Files To Reference', formatFileReferenceItems(context.files_to_reference));
  addSection(lines, 'Design Patterns', formatDesignPatternItems(context.design_patterns));
  addSection(lines, 'Implementation Notes', toBulletItems(context.implementation_notes));
  addSection(lines, 'Risks', toBulletItems(context.risks));
  addSection(lines, 'Verification Suggestions', toBulletItems(context.verification_suggestions));
  addSection(lines, 'Standards References', toBulletItems(context.standards_references));
  addSection(lines, 'Assumptions', toBulletItems(context.assumptions));

  const evidence = normalizeAutocodeContextEvidenceSources(
    Array.isArray(context.evidence_sources) ? context.evidence_sources : [],
  );
  addSection(
    lines,
    'Evidence Sources',
    evidence.map((item) => formatContextEvidenceSource(item)),
  );

  const createdAt = singleLine(context.created_at);
  if (createdAt) {
    addSection(lines, 'Metadata', [`Created At: ${createdAt}`]);
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function validateContextMarkdownEvidence(contextMarkdown: string, requireEvidence: boolean): string[] {
  const evidenceSection = getMarkdownSection(contextMarkdown, 'Evidence Sources');
  const errors: string[] = [];
  if (requireEvidence && hasContextMarkdownClaims(contextMarkdown) && !/-\s+\S/.test(evidenceSection)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} missing non-empty "Evidence Sources" section.`);
    return errors;
  }

  const evidenceLines = evidenceSection
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line));
  evidenceLines.forEach((line, index) => {
    if (!isTraceableAutocodeEvidence(line)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.context} Evidence Sources item ${index + 1} is vague; cite a file, project doc, or verified reference.`);
    }
  });
  return errors;
}

function addSection(lines: string[], heading: string, items: string[]): void {
  const normalized = items.map(singleLine).filter(Boolean);
  if (normalized.length === 0) {
    return;
  }

  lines.push(`## ${heading}`, '');
  if (normalized.length === 1 && !normalized[0].includes(':')) {
    lines.push(normalized[0], '');
    return;
  }

  lines.push(...normalized.map((item) => `- ${item}`), '');
}

function toBulletItems(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringifyContextMarkdownValue).filter(Boolean);
  }
  const text = stringifyContextMarkdownValue(value);
  return text ? [text] : [];
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return [value];
}

function formatFileModificationItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.name);
    const reason = singleLine(record.reason ?? record.purpose ?? record.description);
    const change = singleLine(record.change_needed ?? record.changeNeeded ?? record.action ?? record.status);
    return [path, reason ? `reason: ${reason}` : '', change ? `change: ${change}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatFileReferenceItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const path = singleLine(record.path ?? record.file ?? record.file_path ?? record.name);
    const reason = singleLine(record.reason ?? record.purpose ?? record.description);
    const pattern = singleLine(record.pattern ?? record.guidance ?? record.existing_usage);
    return [path, reason ? `reason: ${reason}` : '', pattern ? `pattern: ${pattern}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatDesignPatternItems(value: unknown): string[] {
  return toArray(value).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return stringifyContextMarkdownValue(item);
    }
    const record = item as Record<string, unknown>;
    const name = singleLine(record.name ?? record.pattern ?? record.title);
    const usage = singleLine(record.existing_usage ?? record.usage ?? record.location);
    const guidance = singleLine(record.guidance ?? record.description ?? record.reason);
    return [name, usage ? `usage: ${usage}` : '', guidance ? `guidance: ${guidance}` : '']
      .filter(Boolean)
      .join(' - ');
  }).filter(Boolean);
}

function formatContextEvidenceSource(item: AutocodeContextEvidenceSource): string {
  const detail = [
    item.symbol ? `symbol: ${item.symbol}` : '',
    item.lines ? `lines: ${item.lines}` : '',
    `confidence: ${item.confidence}`,
  ].filter(Boolean).join('; ');
  return `${item.path}${detail ? ` (${detail})` : ''} - ${item.proves}`;
}

function hasContextMarkdownClaims(contextMarkdown: string): boolean {
  return [
    'Architecture Summary',
    'Files To Modify',
    'Files To Reference',
    'Design Patterns',
    'Implementation Notes',
    'Risks',
  ].some((heading) => {
    const section = getMarkdownSection(contextMarkdown, heading);
    return Boolean(section && /\S/.test(section));
  });
}

function stringifyContextMarkdownValue(value: unknown): string {
  if (typeof value === 'string') {
    return singleLine(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(stringifyContextMarkdownValue).filter(Boolean).join('; ');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const preferred = singleLine(
      record.path ??
      record.name ??
      record.title ??
      record.proves ??
      record.description ??
      record.reason,
    );
    return preferred || JSON.stringify(value);
  }
  return '';
}

function parseContextObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasSectionContent(markdown: string, heading: string): boolean {
  const section = getMarkdownSection(markdown, heading);
  return Boolean(section && /(?:^|\n)\s*(?:[-*]|\d+\.)\s+\S/.test(section));
}

function sectionContainsEvidence(markdown: string, heading: string): boolean {
  const section = getMarkdownSection(markdown, heading);
  return Boolean(section && /\bEvidence\s*:/i.test(section));
}

function getMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^##\\s+${escaped}\\b[^\\n]*\\n([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im').exec(markdown);
  return match?.[1]?.trim() ?? '';
}

function normalizeAutocodeEvidenceConfidence(value: unknown): AutocodeEvidenceConfidence {
  const text = singleLine(value).toLowerCase();
  if (text === 'low' || text === 'medium' || text === 'high') {
    return text;
  }
  return 'medium';
}

function singleLine(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, ' ').trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return '';
}
