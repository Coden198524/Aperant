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

const GENERIC_STANDARD_SPEC_EVIDENCE_PATTERN =
  /\brequirements\.md\s+(?:captures|records|contains)\b.*\b(?:user request|planning constraints?|requirements?)\b|\btasks\.md\s+(?:maps|links|traces)\b.*\bStandard\b|\bUser task description captured by Autocode\b|\bspec\.md planning scope and success criteria\b|requirements\.md\s+记录了本任务的用户请求和规划约束|tasks\.md\s+将实现工作映射回生成的\s*Standard\s*需求|Autocode\s+捕获的用户任务描述|spec\.md\s+中的规划范围和成功标准/iu;

const MANUAL_STANDARD_SPEC_SEED_PATTERN =
  /\bStandard mode task\b|Standard 标准模式任务|\bUse Standard Autocode planning\b|使用 Autocode Standard 规范流程|Follow the Autocode Standard spec-driven flow/iu;

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

const ANALYSIS_DOCUMENTATION_PLAN_PATTERN =
  /\b(?:analysis|analyze|documentation|docs?|research|investigation|audit|review|report|write[-\s]?up|explain|explanation)\b|分析|文档|说明|调研|研究|审计|复核|报告|梳理|定位/iu;

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
  /\b(?:source|project|docs?|memory|Project Memory|Memory Context|workflow recipe|pattern|decision|module insight|general guidance|engineering experience|official|standard|src\/|tests\/|spec\.md|requirements\.md|context\.md|MDN|Vite|Playwright)\b|[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+|通用工程经验|项目|记忆|源码|参考|模式|架构|来源|证据|官方|文档/iu;

const ARCHITECTURE_BOUNDARY_PATTERN =
  /\b(?:boundary|layer|module|component|service|adapter|core|domain|state|ui|view|renderer|rendering|input|browser|canvas|persistence|storage|api|ipc|worker|test|contract|model|store|repository|rules?|loop|hud)\b|架构|边界|分层|模块|组件|核心|领域|状态|渲染|输入|浏览器|持久|存储|接口|契约|规则|主循环|界面|页面|验证|测试/u;

const ARCHITECTURE_PATTERN_STRATEGY_PATTERN =
  /\b(?:pattern|strategy|architecture|separation|separate|decoupl|adapter|facade|repository|state machine|finite state|fsm|reducer|pure function|dependency injection|inject|ports?|event|command|pipeline|orchestrator|service|contract|interface|single responsibility|deterministic|idempotent)\b|模式|策略|分离|解耦|适配器|状态机|纯函数|注入|事件|命令|管道|确定性|幂等|职责|封装|统一|归一|共享|消费|推进|计算|管理|绘制|派生/u;

const TASK_ARCHITECTURE_GUIDANCE_MARKER_PATTERN =
  /\b(?:architecture|architecture\/pattern|design pattern|pattern guidance|boundary\/pattern)\s*:|架构\s*[:：]|设计模式\s*[:：]/iu;

const TASK_ARCHITECTURE_METADATA_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:[_*`]+)?\s*(?:Architecture|Architecture\/Pattern|Design Pattern|Pattern Guidance|Boundary\/Pattern|\u67B6\u6784|\u8BBE\u8BA1\u6A21\u5F0F)\s*[:\uFF1A]/iu;

const LOCALIZED_TASK_ARCHITECTURE_METADATA_LINE_PATTERN =
  /^\s*(?:[-*]\s*)?(?:[_*`]+)?\s*(?:\u67B6\u6784|\u8BBE\u8BA1\u6A21\u5F0F)\s*[:\uFF1A]/iu;

const RUNNABLE_DELIVERABLE_FILE_SIGNAL_PATTERN =
  /\.(?:html?|css|tsx|jsx|vue|svelte)\b|(?:^|[/\\])(?:public|static|assets|web|frontend)(?:[/\\]|$)|(?:^|[/\\])src[/\\](?:cli|command|launcher)\.(?:[cm]?[jt]sx?|py|go|rs|cs)\b/iu;

const RUNNABLE_DELIVERABLE_TEXT_SIGNAL_PATTERN =
  /\b(?:user[-\s]?facing|browser|web\s?page|webapp|web\s?app|playable|interactive|canvas|cli|command[-\s]?line|launcher|startup|start screen|open path|launch path|dev server|localhost|file:\/\/|electron|smoke test|e2e|end[-\s]?to[-\s]?end)\b|\u7528\u6237\u754c\u9762|\u754c\u9762|\u6d4f\u89c8\u5668|\u7f51\u9875|\u9875\u9762|\u524d\u7aef|\u53ef\u73a9|\u53ef\u7528|\u4ea4\u4e92|\u753b\u5e03|\u547d\u4ee4\u884c|\u542f\u52a8|\u6253\u5f00|\u7aef\u5230\u7aef|\u5192\u70df/iu;

const STATIC_ONLY_VERIFICATION_PATTERN =
  /\b(?:node\s+--check|tsc\s+--noemit|typecheck|lint|biome|eslint|test-path|get-content|dir\b|ls\b|inspect|review|read|exist(?:s|ence)?|file[-\s]?existence|syntax|static|unit tests?)\b|\u8bed\u6cd5|\u9759\u6001|\u68c0\u67e5\u6587\u4ef6|\u6587\u4ef6\u5b58\u5728|\u67e5\u770b|\u9605\u8bfb/iu;

const RUNTIME_READINESS_VERIFICATION_PATTERN =
  /\b(?:playwright|cypress|selenium|e2e|end[-\s]?to[-\s]?end|headless|cdp|dev server|localhost|https?:\/\/|file:\/\/|page\.goto|browser smoke|chrome smoke|edge smoke|electron smoke|runtime smoke|startup smoke|open(?:ed)?\s+(?:the\s+)?[^.;\n]{0,80}\b(?:app|page|browser|screen|artifact|index\.html|html)\b|launch(?:ed)?\s+(?:the\s+)?[^.;\n]{0,80}\b(?:app|page|browser|screen|artifact)\b|start(?:ed)?\s+(?:the\s+)?[^.;\n]{0,80}\b(?:app|page|browser|server|cli|command|artifact)\b|manual(?:ly)? (?:opened|launched|started|checked)|cli smoke|command smoke|run(?:s|ning)?\s+(?:the\s+)?[^.;\n]{0,80}\b(?:cli|command|app)\b)\b|\u6253\u5f00(?:\u5e94\u7528|\u9875\u9762|\u6d4f\u89c8\u5668)?|\u542f\u52a8(?:\u5e94\u7528|\u9875\u9762|\u6d4f\u89c8\u5668|\u670d\u52a1|\u547d\u4ee4\u884c)?|\u6d4f\u89c8\u5668\u5192\u70df|\u542f\u52a8\u5192\u70df|\u8fd0\u884c\u5192\u70df|\u771f\u5b9e\u8fd0\u884c|\u7aef\u5230\u7aef|\u5192\u70df/iu;

const RUNTIME_HEALTH_CHECK_PATTERN =
  /\b(?:console|resource(?:s)?|load(?:ing)?|blank screen|white screen|non[-\s]?blank|render(?:ed|s)?|canvas|startup (?:passed|ok|succeeded)|started successfully|no startup errors?|exit code|exit status|primary path|click(?:ed)?|interact(?:ed|ion)?|no crash|no hang|no runtime errors?|no page errors?|no console errors?|no resource[-\s]?load failures?)\b|\u63a7\u5236\u53f0|\u8d44\u6e90|\u52a0\u8f7d|\u767d\u5c4f|\u7a7a\u767d|\u975e\u7a7a|\u6e32\u67d3|\u753b\u5e03|\u542f\u52a8|\u9000\u51fa\u7801|\u4e3b\u8def\u5f84|\u70b9\u51fb|\u4ea4\u4e92|\u65e0\u5d29\u6e83|\u65e0\u5361\u6b7b|\u65e0\u9519\u8bef/iu;

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
    ...formatAutocodeRetryErrorLines(errors, { maxCharsPerError: 160 }),
    '',
    'Repair only the affected artifacts with the Write/Edit tools.',
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.specFile} as a compact decision index, not a full analysis dump.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.requirements} focused on requirements, acceptance criteria, constraints, evidence sources, standards, and assumptions.`,
    `- Keep ${AUTOCODE_TASK_ARTIFACTS.tasks} detailed but compact: split broad work into focused leaf tasks while keeping each task guidance short.`,
    '- A leaf task should cover one independently reviewable behavior or contract and one focused verification path.',
    '- Split tasks that cover more than three behaviors, more than three requirement/acceptance references, or more than four write-intent files.',
    '- If split tasks touch the same file, keep them as separate leaf tasks and add _Depends on: ..._ only for real data, contract, or verification order; the runtime file-conflict scheduler will queue overlapping writes safely.',
    '- Replace generic task text with concrete behavior, affected project boundary, likely files/APIs, and the existing pattern to follow.',
    `- If ${AUTOCODE_TASK_ARTIFACTS.specFile} is still a manual Standard planning seed, replace it with a compact spec: concrete requirements, key decisions or assumptions, evidence, and acceptance/verification notes needed for coding.`,
    `- Generic Standard Evidence scaffolding is not enough by itself; ${AUTOCODE_TASK_ARTIFACTS.specFile} Evidence must cite the user request, concrete requirements, project files/docs, or verified standards that prove scope and acceptance criteria.`,
    '- For complex or high-risk plans only, include a detailed but compact Architecture And Design Pattern References section in spec.md or tasks.md: 4-8 bullets covering affected boundaries/layers, recommended pattern or strategy, source/docs/Project Memory reference or labeled general guidance, and which task IDs/boundaries should apply it.',
    '- For complex or high-risk plans, each non-read-only executable task must include one short _Architecture: boundary; pattern/strategy; source/reference_ line so implementation agents can apply the guidance directly.',
    '- Use exactly one architecture metadata line per task and keep the metadata key in English: _Architecture: ..._. Do not use localized keys such as _架构: ..._ or include both labels.',
    '- For runnable/user-facing deliverables, add runtime-readiness verification that starts/opens the artifact, exercises the primary path, and checks console/resource loading/blank-screen/startup/exit status; node --check, lint, typecheck, file existence, or inspect-only review is not enough.',
    '- Never prefix executable task titles with revision, obsolete, or other state labels. Do not introduce revision/history markers unless real human Request Changes context already requires them.',
    `- ${AUTOCODE_TASK_ARTIFACTS.requirements} must include concrete User Requirements and Acceptance Criteria; do not leave either section as None when ${AUTOCODE_TASK_ARTIFACTS.tasks} derives requirements or acceptance criteria.`,
    `- Do not keep the only concrete Requirement Index inside ${AUTOCODE_TASK_ARTIFACTS.tasks}; mirror concrete requirements and acceptance criteria into ${AUTOCODE_TASK_ARTIFACTS.requirements}.`,
    '- Every executable task must include _Requirements: ..._, _Evidence: ..._, a done signal such as _Done when: ..._, and _Verification: ..._.',
    '- Preserve requirement IDs and unaffected design/task content during Request Changes iterations.',
    '- Use Evidence references instead of copying source code or long research notes.',
    '- If evidence is missing, add an assumption/open question or validation task instead of inventing implementation work.',
    '- For analysis, investigation, report, or documentation-only tasks, keep the final Markdown reader-first: early Conclusion Snapshot, early Main Flow, scenario-based sections, and evidence/verification templates near the end or in appendices.',
    '- Do not use implementation-contract headings such as inputs/outputs/side effects/lifecycle/errors as the top-level structure for documentation deliverables unless the user explicitly asks for that format.',
  ].join('\n');
}

export function isAutocodePlanTaskGranularityError(error: string): boolean {
  return /\btasks\.md task \S+ is too broad;/.test(error);
}

export function isAutocodePlanArchitectureGuidanceError(error: string): boolean {
  return /\btasks\.md Architecture And Design Pattern References (?:is too thin|needs at least three actionable bullets|must say where)/.test(error) ||
    /\btasks\.md complex task\(s\) missing _Architecture: \.\.\._ guidance/.test(error);
}

export function isAutocodePlanRecoverableQualityError(error: string): boolean {
  return isAutocodePlanTaskGranularityError(error) || isAutocodePlanArchitectureGuidanceError(error);
}

export function hasOnlyAutocodePlanTaskGranularityErrors(errors: string[]): boolean {
  return errors.length > 0 && errors.every(isAutocodePlanTaskGranularityError);
}

export function hasOnlyAutocodePlanRecoverableQualityErrors(errors: string[]): boolean {
  return errors.length > 0 && errors.every(isAutocodePlanRecoverableQualityError);
}

function validateComplexPlanArchitectureReferences(input: {
  specMarkdown?: string;
  tasksMarkdown: string;
}): string[] {
  if (isDocumentationAnalysisOnlyPlan(input.tasksMarkdown)) {
    return [];
  }
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

function isDocumentationAnalysisOnlyPlan(tasksMarkdown: string): boolean {
  let plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>;
  try {
    plan = parseAutocodeImplementationPlanMarkdown(tasksMarkdown);
  } catch {
    return false;
  }

  const subtasks = getPlanSubtasks(plan);
  if (subtasks.length === 0) {
    return false;
  }

  const writeIntentFiles = uniqueStringArray(subtasks.flatMap((subtask) => [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ])).filter((item) => !EMPTY_EVIDENCE_TOKENS.has(item.toLowerCase()));

  if (writeIntentFiles.some((file) => !isDocumentationWriteIntentFile(file))) {
    return false;
  }

  const planText = [
    singleLine(plan.feature),
    singleLine(plan.description),
    singleLine(plan.workflow_type),
    tasksMarkdown,
  ].join('\n');

  if (ANALYSIS_DOCUMENTATION_PLAN_PATTERN.test(planText)) {
    return true;
  }

  return writeIntentFiles.length > 0 &&
    subtasks.every((subtask) => isDocumentationAnalysisTask(subtask as Record<string, unknown>));
}

function isDocumentationAnalysisTask(subtask: Record<string, unknown>): boolean {
  const taskText = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.evidence),
    stringifyTaskValue(subtask.verification),
  ].join(' ');
  return ANALYSIS_DOCUMENTATION_PLAN_PATTERN.test(taskText);
}

function isDocumentationWriteIntentFile(file: string): boolean {
  const normalized = file
    .replace(/[`*_]/g, '')
    .replace(/\\/g, '/')
    .trim()
    .toLowerCase();
  if (!normalized || EMPTY_EVIDENCE_TOKENS.has(normalized)) {
    return true;
  }
  return /\.(?:md|mdx|txt|rst|adoc)$/.test(normalized);
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
  const architecture = stringifyTaskValue(subtask.architecture);
  const text = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    architecture,
    stringifyTaskValue(subtask.evidence),
    ...stringArrayField(subtask.pattern_files),
  ].join('\n');
  if (!architecture && !TASK_ARCHITECTURE_GUIDANCE_MARKER_PATTERN.test(text)) {
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
  } else if (hasOnlyGenericStandardSpecEvidence(evidenceSection)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Evidence section is only generic Standard scaffolding; cite the user request, concrete requirements, project files/docs, or verified standards that prove scope and acceptance criteria.`);
  }
  if (isManualStandardSpecSeed(specMarkdown)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} is still the manual Standard planning seed; replace it with a compact Standard spec containing concrete requirements, key decisions or assumptions, evidence, and acceptance/verification notes before planning.`);
  }
  if (hasSectionContent(specMarkdown, 'Requirements') && !sectionContainsEvidence(specMarkdown, 'Requirements') && !hasGlobalEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Requirements section must cite Evidence for requirements or acceptance criteria.`);
  }
  if (hasSectionContent(specMarkdown, 'Design Notes') && !sectionContainsEvidence(specMarkdown, 'Design Notes') && !hasGlobalEvidence) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.specFile} Design Notes must cite Evidence or move unverified claims to Assumptions/Open Questions.`);
  }
  return errors;
}

function hasOnlyGenericStandardSpecEvidence(evidenceSection: string): boolean {
  const bullets = evidenceSection
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter(Boolean);
  return bullets.length > 0 && bullets.every((line) => GENERIC_STANDARD_SPEC_EVIDENCE_PATTERN.test(line));
}

function isManualStandardSpecSeed(specMarkdown: string): boolean {
  return MANUAL_STANDARD_SPEC_SEED_PATTERN.test(specMarkdown) &&
    !hasSectionContent(specMarkdown, 'Requirements') &&
    !hasSectionContent(specMarkdown, 'Design Notes') &&
    !hasSectionContent(specMarkdown, 'Implementation Notes') &&
    !hasSectionContent(specMarkdown, 'Success Criteria');
}

function validateRequirementsEvidence(requirementsMarkdown: string): string[] {
  const errors: string[] = [];
  const evidenceSection = getMarkdownSection(requirementsMarkdown, 'Evidence Sources');
  if (!evidenceSection || !/-\s+\S/.test(evidenceSection)) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.requirements} missing non-empty "Evidence Sources" section.`);
  }

  if (!hasMeaningfulRequirementsSection(requirementsMarkdown, 'User Requirements', ['Requirements'])) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.requirements} User Requirements section must list at least one concrete requirement; do not leave it as None when tasks.md derives requirements.`);
  }
  if (!hasMeaningfulRequirementsSection(requirementsMarkdown, 'Acceptance Criteria')) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.requirements} Acceptance Criteria section must list at least one concrete acceptance criterion; do not leave it as None when tasks.md derives acceptance criteria.`);
  }

  return errors;
}

function hasMeaningfulRequirementsSection(markdown: string, heading: string, fallbackHeadings: string[] = []): boolean {
  const sections = [heading, ...fallbackHeadings]
    .map((candidate) => getMarkdownSection(markdown, candidate))
    .filter(Boolean);
  return sections.some((section) => hasMeaningfulRequirementList(section) || hasMeaningfulRequirementSubsection(section, heading));
}

function isMeaningfulRequirementListItem(value: string): boolean {
  const raw = singleLine(value);
  const text = raw.toLowerCase();
  return raw.length >= 4 &&
    !EMPTY_EVIDENCE_TOKENS.has(text) &&
    !/^(?:no requirements?|none identified|not applicable)$/i.test(text);
}

function hasMeaningfulRequirementList(section: string): boolean {
  return section
    .split(/\r?\n/)
    .map((line) => line.match(/^\s*(?:[-*]|\d+\.)\s+(.*?)\s*$/)?.[1] ?? '')
    .some(isMeaningfulRequirementListItem);
}

function hasMeaningfulRequirementSubsection(section: string, parentHeading: string): boolean {
  const isAcceptanceSection = /acceptance/i.test(parentHeading);
  const lines = section.replace(/\r\n/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = /^\s*#{3,6}\s+(.+?)\s*$/.exec(lines[index]);
    if (!headingMatch) {
      continue;
    }

    const headingText = singleLine(headingMatch[1]);
    if (!isRequirementSubsectionHeading(headingText, isAcceptanceSection)) {
      continue;
    }

    const headingPayload = normalizeRequirementSubsectionHeading(headingText, isAcceptanceSection);
    if (!isAcceptanceSection && isMeaningfulRequirementListItem(headingPayload)) {
      return true;
    }

    const bodyLines: string[] = [];
    for (let bodyIndex = index + 1; bodyIndex < lines.length; bodyIndex += 1) {
      if (/^\s*#{3,6}\s+/.test(lines[bodyIndex])) {
        break;
      }
      bodyLines.push(lines[bodyIndex]);
    }
    if (hasMeaningfulRequirementParagraph(bodyLines.join('\n'))) {
      return true;
    }
  }
  return false;
}

function isRequirementSubsectionHeading(headingText: string, isAcceptanceSection: boolean): boolean {
  return isAcceptanceSection
    ? /\b(?:AC\d+(?:\.\d+)?|Acceptance\s+Criteria?|Acceptance\s+Criterion)\b/i.test(headingText)
    : /\b(?:R\d+(?:\.\d+)?|Requirement\s+\d+|User\s+Requirement\s+\d+)\b/i.test(headingText);
}

function normalizeRequirementSubsectionHeading(headingText: string, isAcceptanceSection: boolean): string {
  const withoutId = headingText
    .replace(/\bR\d+(?:\.\d+)?\b/gi, ' ')
    .replace(/\bAC\d+(?:\.\d+)?\b/gi, ' ');
  if (!isAcceptanceSection) {
    return withoutId
      .replace(/\b(?:User\s+Requirements?|Requirements?)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return withoutId
    .replace(/\b(?:Acceptance\s+Criteria|Acceptance\s+Criterion)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasMeaningfulRequirementParagraph(section: string): boolean {
  return section
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '').trim())
    .filter((line) => line && !/^\s*#{1,6}\s+/.test(line))
    .some((line) => isMeaningfulRequirementListItem(line) && singleLine(line).length >= 12);
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
  errors.push(...validateDuplicateTaskArchitectureMetadata(tasksMarkdown));
  errors.push(...validateTaskArchitectureMetadataLabels(tasksMarkdown));

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
  errors.push(...validateRunnableRuntimeVerification(plan));
  return errors;
}

function validateDuplicateTaskArchitectureMetadata(tasksMarkdown: string): string[] {
  const errors: string[] = [];
  for (const block of getTaskMarkdownBlocks(tasksMarkdown)) {
    const architectureLineCount = block.lines.filter(isTaskArchitectureMetadataLine).length;
    if (architectureLineCount > 1) {
      errors.push(
        `${AUTOCODE_TASK_ARTIFACTS.tasks} task ${block.id} has duplicate architecture metadata; use exactly one _Architecture: ..._ line and keep the metadata key in English.`,
      );
    }
  }
  return errors;
}

function validateTaskArchitectureMetadataLabels(tasksMarkdown: string): string[] {
  const errors: string[] = [];
  for (const block of getTaskMarkdownBlocks(tasksMarkdown)) {
    if (block.lines.some(isLocalizedTaskArchitectureMetadataLine)) {
      errors.push(
        `${AUTOCODE_TASK_ARTIFACTS.tasks} task ${block.id} uses localized architecture metadata; use _Architecture: ..._ so task metadata keys stay consistent with Depends on, Requirements, Evidence, Done when, and Verification.`,
      );
    }
  }
  return errors;
}

function getTaskMarkdownBlocks(markdown: string): Array<{ id: string; lines: string[] }> {
  const blocks: Array<{ id: string; lines: string[] }> = [];
  let current: { id: string; lines: string[] } | null = null;
  for (const rawLine of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^\s*-\s+\[[ xX/!\-]\]\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\.)?\s+/.exec(rawLine);
    if (match) {
      if (current) {
        blocks.push(current);
      }
      current = { id: match[1], lines: [] };
      continue;
    }
    current?.lines.push(rawLine);
  }
  if (current) {
    blocks.push(current);
  }
  return blocks;
}

function isTaskArchitectureMetadataLine(line: string): boolean {
  return TASK_ARCHITECTURE_METADATA_LINE_PATTERN.test(line);
}

function isLocalizedTaskArchitectureMetadataLine(line: string): boolean {
  return LOCALIZED_TASK_ARCHITECTURE_METADATA_LINE_PATTERN.test(line);
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
      `${AUTOCODE_TASK_ARTIFACTS.tasks} task ${id} is too broad; split it into focused leaf tasks by behavior, requirement/acceptance scenario, file or contract boundary, and verification path (${describeTaskGranularityMetrics(metrics)}).`,
    );
  }

  return errors;
}

function validateRunnableRuntimeVerification(plan: ReturnType<typeof parseAutocodeImplementationPlanMarkdown>): string[] {
  const subtasks = getPlanSubtasks(plan);
  const runnableTasks = subtasks.filter(isRunnableDeliverableTask);
  if (runnableTasks.length === 0) {
    return [];
  }

  const runtimeVerificationTasks = subtasks.filter(hasRuntimeReadinessVerification);
  if (runtimeVerificationTasks.length > 0) {
    return [];
  }

  const runnableIds = runnableTasks
    .map((subtask) => singleLine(subtask.id) || 'unknown')
    .slice(0, 8)
    .join(', ');
  return [
    `${AUTOCODE_TASK_ARTIFACTS.tasks} describes runnable/user-facing deliverable task(s) (${runnableIds}) but has no runtime-readiness verification; add a leaf task or verification that starts/opens the artifact, exercises the primary path, and checks console/resource loading/blank-screen/startup/exit status. Static checks such as node --check, lint, typecheck, file existence, or inspect-only verification are not enough.`,
  ];
}

function isRunnableDeliverableTask(subtask: Record<string, unknown>): boolean {
  const narrativeText = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.evidence),
    stringifyTaskValue(subtask.verification),
  ].join(' ');
  const fileText = [
    ...stringArrayField(subtask.files),
    ...stringArrayField(subtask.files_to_create),
    ...stringArrayField(subtask.files_to_modify),
  ].join(' ');

  if (
    !RUNNABLE_DELIVERABLE_FILE_SIGNAL_PATTERN.test(fileText) &&
    !RUNNABLE_DELIVERABLE_TEXT_SIGNAL_PATTERN.test(narrativeText)
  ) {
    return false;
  }
  if (isReadOnlyValidationTask(subtask, singleLine(subtask.title), singleLine(subtask.description))) {
    return true;
  }
  return true;
}

function hasRuntimeReadinessVerification(subtask: Record<string, unknown>): boolean {
  const text = [
    stringifyTaskValue(subtask.title),
    stringifyTaskValue(subtask.description),
    stringifyTaskValue(subtask.verification),
    stringifyTaskValue(subtask.completion_summary),
    stringifyTaskValue(subtask.notes),
  ].join(' ');
  return RUNTIME_READINESS_VERIFICATION_PATTERN.test(text) &&
    RUNTIME_HEALTH_CHECK_PATTERN.test(text) &&
    !isStaticOnlyVerificationOnly(text);
}

function isStaticOnlyVerificationOnly(text: string): boolean {
  return STATIC_ONLY_VERIFICATION_PATTERN.test(text) &&
    !RUNTIME_READINESS_VERIFICATION_PATTERN.test(text);
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
  const granularityDescription = stripTaskMetadataLinesForGranularity(description);
  const taskText = `${title}\n${granularityDescription}`;
  return {
    behaviorSignals: countTermSignals(taskText, TASK_GRANULARITY_ACTION_TERMS),
    boundarySignals: countTermSignals(taskText, TASK_GRANULARITY_BOUNDARY_TERMS),
    requirementReferences: estimateTaskRequirementReferenceCount(subtask),
    writeIntentFiles: countTaskWriteIntentFiles(subtask),
    listSeparators: countTaskListSeparators(taskText),
    descriptionChars: granularityDescription.length,
  };
}

function stripTaskMetadataLinesForGranularity(description: string): string {
  return description
    .split(/\r?\n/)
    .filter((line) => !isTaskMetadataLineForGranularity(line))
    .join('\n');
}

function isTaskMetadataLineForGranularity(line: string): boolean {
  if (isTaskArchitectureMetadataLine(line)) {
    return true;
  }
  return /^\s*(?:[-*]\s*)?(?:[_*`]+)?\s*(?:Architecture|Architecture\/Pattern|Design Pattern|Boundary\/Pattern|Files?|Files to create\/modify|Files to modify|Files to create|Depends on|Requirements?|Acceptance Criteria|Evidence|Done when|Complete when|Finished when|Completion Criteria|Success Criteria|Verification|Validation|Pattern files)\s*[:\uFF1A]/iu.test(line);
}

function isTaskTooBroad(metrics: TaskGranularityMetrics): boolean {
  if (
    metrics.behaviorSignals <= 6 &&
    metrics.requirementReferences <= 2 &&
    metrics.writeIntentFiles <= 2
  ) {
    return false;
  }
  if (
    metrics.behaviorSignals <= 7 &&
    metrics.requirementReferences <= 2 &&
    metrics.writeIntentFiles <= 4 &&
    metrics.descriptionChars <= 280 &&
    metrics.listSeparators <= 5
  ) {
    return false;
  }
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
  const separators = text.match(/[\u3001\uFF0C,;\uFF1B]/gu) ?? [];
  const conjunctions = text.match(/\b(?:and|plus)\b|\u4EE5\u53CA|\u5E76\u4E14|\u540C\u65F6/giu) ?? [];
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
