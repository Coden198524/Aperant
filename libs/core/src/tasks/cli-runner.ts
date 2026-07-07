import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildAutocodeProjectDocsReferencePrompt } from '../project/project-docs.js';
import {
  type AutocodeAgentLanguage,
  CHANGE_REQUEST_AUDIT_MAX_CHARS,
  compactChangeRequestJsonlForPrompt,
  DIRECT_CHANGE_REQUEST_LIMIT,
  DIRECT_PROJECT_DOCS_REFERENCE_MAX_BYTES,
} from '../runtime/agent-messages.js';
import { AUTOCODE_TASK_EVENT_PREFIX } from '../runtime/agent-events.js';
import {
  type AutocodeTaskRuntimeConcurrencyResolved,
  resolveAutocodeTaskRuntimeConcurrency,
} from '../runtime/concurrency.js';
import {
  AUTOCODE_DIRECT_SESSION_STATE_VERSION,
  compactAutocodeDirectSessionLatestSummary,
  resolveAutocodeDirectSessionState,
} from '../runtime/direct-session-state.js';
import { foldRepeatedAutocodePromptLines } from '../runtime/prompt-context.js';
import { AUTOCODE_TASK_ARTIFACTS } from './artifacts.js';
import {
  type AutocodeCli,
  type AutocodeCliContinuationStrategy,
  type AutocodeCliJsonEventParser,
  type AutocodeCliPreflightAction,
  type AutocodeCliTaskRunStrategy,
  getAutocodeCliContinuationStrategy,
  getAutocodeCliJsonEventParsers,
  getAutocodeCliPreflightActions,
  resolveAutocodeCliTaskRunInvocation,
} from './cli-catalog.js';
import { loadAutocodeImplementationPlanSync } from './plan-store.js';
import {
  type AutocodePlanStatus,
  type AutocodeTask,
  getAutocodeSpecDir,
  listAutocodeTasks,
  resolveAutocodeTaskDevelopmentMode,
} from './spec-store.js';

export type AutocodeTaskRunPhase = 'direct' | 'spec' | 'planning' | 'coding';

export interface CreateAutocodeTaskRunPlanInput {
  projectRoot: string;
  dataDirName: string;
  taskId: string;
  projectId?: string;
  cli: AutocodeCli;
  customCommand?: string;
  model?: string;
  bypassPermissions?: boolean;
  phase?: AutocodeTaskRunPhase;
  language?: AutocodeAgentLanguage;
  directCliContinuationStrategy?: AutocodeCliContinuationStrategy;
  directCliJsonEventParser?: AutocodeCliJsonEventParser;
  directCliRuntimeRouteId?: string;
  directCliRuntimeRouteDisplayName?: string;
  directCliPermissionBypassArgs?: string[];
  directCliTaskRunStrategy?: AutocodeCliTaskRunStrategy;
  directCliPreflightActions?: AutocodeCliPreflightAction[];
}

export interface AutocodeTaskRunPlan {
  task: AutocodeTask;
  phase: AutocodeTaskRunPhase;
  cwd: string;
  command: string;
  args: string[];
  planStatus: AutocodePlanStatus;
  executionPhase: string;
  promptFilePath: string;
  runnerFilePath: string;
  prompt: string;
}

const PROMPT_FILE_NAME = 'autocode-run-prompt.md';
const RUNNER_FILE_NAME = 'autocode-runner.cjs';
const requireFromCore = createRequire(import.meta.url);
export const AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS = 4_000;
const CLI_TASK_DESCRIPTION_COMPACTION_NOTICE =
  '\n\n...[task description middle omitted for prompt budget; read the task metadata if exact omitted detail is required]...\n\n';

interface AutocodeTaskRunnerDependencyResolutionOptions {
  resolveModule?: (moduleName: string) => string;
  resourcesPath?: string;
}

export function createAutocodeTaskRunPlan(input: CreateAutocodeTaskRunPlanInput): AutocodeTaskRunPlan {
  const task = resolveTask(input.projectRoot, input.dataDirName, input.taskId);
  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const specDir = getAutocodeSpecDir({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specId: task.specId,
  });
  const phase = input.phase ?? resolveRunPhase(specDir, task);
  const runtimeConcurrency = resolveAutocodeTaskRuntimeConcurrency(task.metadata);
  const prompt = buildTaskRunPrompt({
    task,
    phase,
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    specDir,
    language: input.language,
  });
  const promptFilePath = join(specDir, PROMPT_FILE_NAME);
  const runnerFilePath = join(specDir, RUNNER_FILE_NAME);
  const cliInvocation = resolveAutocodeCliTaskRunInvocation({
    cli: input.cli,
    customCommand: input.customCommand,
    model: input.model,
    bypassPermissions: input.bypassPermissions === true,
    permissionBypassArgs: input.directCliPermissionBypassArgs,
    taskRunStrategy: input.directCliTaskRunStrategy,
  });
  writeFileSync(promptFilePath, `${prompt}\n`, 'utf8');
  writeFileSync(
    runnerFilePath,
    buildNodeRunnerScript({
      cwd: input.projectRoot,
      command: cliInvocation.command,
      args: cliInvocation.args,
      promptFilePath,
      phase,
      specDir,
      taskTitle: task.title,
      taskDescription: compactTaskRunTaskDescription(task.description || task.title),
      taskMetadata: task.metadata,
      projectId: input.projectId,
      language: input.language,
      runtimeConcurrency,
      cli: input.cli,
      directCliContinuationStrategy: input.directCliContinuationStrategy ?? getAutocodeCliContinuationStrategy(input.cli),
      directCliJsonEventParser: input.directCliJsonEventParser,
      directCliRuntimeRouteId: input.directCliRuntimeRouteId,
      directCliRuntimeRouteDisplayName: input.directCliRuntimeRouteDisplayName,
      directCliPreflightActions: input.directCliPreflightActions ?? getAutocodeCliPreflightActions(input.cli),
      model: input.model,
    }),
    'utf8',
  );

  return {
    task,
    phase,
    cwd: input.projectRoot,
    command: cliInvocation.command,
    args: cliInvocation.args,
    planStatus: isCodingRunPhase(phase) ? 'coding' : 'planning',
    executionPhase: isCodingRunPhase(phase) ? 'coding' : 'planning',
    promptFilePath,
    runnerFilePath,
    prompt,
  };
}

export function buildAutocodeTaskRunShellCommand(plan: Pick<AutocodeTaskRunPlan, 'command' | 'args'>): string {
  return [plan.command, ...plan.args].map(quoteShellArg).join(' ');
}

export function buildAutocodeTaskRunnerShellCommand(plan: Pick<AutocodeTaskRunPlan, 'runnerFilePath'>): string {
  return ['node', plan.runnerFilePath].map(quoteShellArg).join(' ');
}

export function mapAutocodeAgentRuntimeModeToTaskRunPhase(
  mode: 'direct' | 'spec' | 'planning' | 'coding',
): AutocodeTaskRunPhase {
  return mode;
}


function resolveTask(projectRoot: string, dataDirName: string, taskId: string): AutocodeTask | null {
  return listAutocodeTasks({ projectRoot, dataDirName })
    .find((task) => task.id === taskId || task.specId === taskId) ?? null;
}

function resolveRunPhase(specDir: string, task: AutocodeTask): AutocodeTaskRunPhase {
  if (resolveAutocodeTaskDevelopmentMode(task.metadata) === 'direct' || task.metadata?.workflowMode === 'off') {
    return 'direct';
  }

  const hasSpec = existsSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile));
  const plan = loadAutocodeImplementationPlanSync(specDir) as { phases?: Array<{ subtasks?: unknown[]; chunks?: unknown[] }> } | null;
  const hasSubtasks = plan?.phases?.some((phase) => {
    const subtasks = Array.isArray(phase.subtasks) ? phase.subtasks : Array.isArray(phase.chunks) ? phase.chunks : [];
    return subtasks.length > 0;
  }) === true;

  if (!hasSpec) {
    return 'spec';
  }
  return hasSubtasks ? 'coding' : 'planning';
}

function buildTaskRunPrompt(input: {
  task: AutocodeTask;
  phase: AutocodeTaskRunPhase;
  projectRoot: string;
  dataDirName?: string;
  specDir: string;
  language?: AutocodeAgentLanguage;
}): string {
  const isChinese = isTaskRunChineseLanguage(input.language);
  const languageInstruction = buildTaskRunLanguageInstruction(input.language);
  const header = isChinese
    ? [
        '# Autocode \u4efb\u52a1\u8fd0\u884c',
        '',
        'Project root: ' + input.projectRoot,
        'Spec directory: ' + input.specDir,
        'Task ID: ' + input.task.specId,
        'Task title: ' + input.task.title,
        '',
        ...(languageInstruction ? ['## \u8bed\u8a00', '', languageInstruction, ''] : []),
      ].join('\n')
    : [
        '# Autocode Task Run',
        '',
        'Project root: ' + input.projectRoot,
        'Spec directory: ' + input.specDir,
        'Task ID: ' + input.task.specId,
        'Task title: ' + input.task.title,
        '',
        ...(languageInstruction ? ['## Language', '', languageInstruction, ''] : []),
      ].join('\n');

  const projectDocsReference = buildAutocodeProjectDocsReferencePrompt({
    projectRoot: input.projectRoot,
    dataDirName: input.dataDirName,
    maxBytes: input.phase === 'direct' ? DIRECT_PROJECT_DOCS_REFERENCE_MAX_BYTES : undefined,
    language: input.language,
  });
  const contextReference = projectDocsReference ? `${projectDocsReference}\n\n` : '';
  const humanInputReference = [
    buildTaskHumanInputReference(input.specDir, input.language),
    buildTaskChangeRequestReference(input.specDir, input.language),
  ].join('');
  const directContinuationReference = input.phase === 'direct'
    ? buildDirectCliContinuationReference(input.specDir)
    : '';
  const taskDescription = compactTaskRunTaskDescription(input.task.description || input.task.title);
  const hasHumanReviewContext = hasTaskHumanReviewContext(input.specDir);

  if (input.phase === 'direct') {
    if (isChinese) {
      return header + contextReference + humanInputReference + directContinuationReference + [
        '## \u76ee\u6807',
        '',
        '\u76f4\u63a5\u5b8c\u6210\u4efb\u52a1\uff1b\u4e0d\u542f\u52a8\u72ec\u7acb\u7684\u89c4\u683c\u3001\u8ba1\u5212\u6216 QA \u5de5\u4f5c\u6d41\u3002',
        '',
        '## \u4efb\u52a1\u63cf\u8ff0',
        '',
        taskDescription,
        '',
        '## \u5fc5\u987b\u9075\u5faa\u7684\u6d41\u7a0b',
        '',
        '- \u7f16\u8f91\u524d\u5148\u68c0\u67e5\u76f8\u5173\u9879\u76ee\u6587\u4ef6\u3002',
        '- \u53ea\u505a\u6700\u5c0f\u4e14\u6709\u6548\u7684\u53d8\u66f4\u3002',
        '- \u8fd0\u884c\u6700\u76f8\u5173\u7684\u9a8c\u8bc1\u547d\u4ee4\u3002',
        '- \u5728 Node 24+ \u4e2d\uff0c\u4e0d\u8981\u5728 node -e\u3001stdin \u6216 eval \u811a\u672c\u91cc\u6df7\u7528 require(...) \u548c\u9876\u5c42 await\uff1b\u8bf7\u4f7f\u7528 async IIFE\uff0c\u6216\u914d\u5408 node --input-type=module \u4f7f\u7528 ESM import\u3002',
        '- \u907f\u514d\u9488\u5bf9\u4efb\u52a1\u521d\u59cb\u72b6\u6001\u6216\u77ac\u65f6\u72b6\u6001\u7f16\u5199\u8106\u5f31\u7684\u5192\u70df\u65ad\u8a00\uff1b\u91cd\u8bd5\u548c\u6062\u590d\u53ef\u80fd\u63a8\u8fdb\u72b6\u6001\u3002\u9664\u975e\u4efb\u52a1\u660e\u786e\u4fee\u6539\u72b6\u6001\u673a\u4ee3\u7801\uff0c\u5426\u5219\u9a8c\u8bc1\u6700\u7ec8\u884c\u4e3a\u6216\u6301\u4e45\u5316\u6587\u4ef6\u3002',
        buildCliMemoryNotesInstruction(input.language),
        '- \u5728 ' + input.specDir + '/' + AUTOCODE_TASK_ARTIFACTS.directSummary + ' \u7559\u4e0b\u4e00\u6bb5\u7b80\u77ed\u5b9e\u73b0\u603b\u7ed3\u3002',
      ].join('\n');
    }

    return header + contextReference + humanInputReference + directContinuationReference + [
      '## Goal',
      '',
      'Implement the task directly; no separate spec workflow.',
      '',
      '## Task Description',
      '',
      taskDescription,
      '',
      '## Required Workflow',
      '',
      '- Inspect the relevant project files before editing.',
      '- Make the smallest useful change.',
      '- Run the most relevant validation.',
      '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
      '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the task explicitly changes state-machine code.',
      buildCliMemoryNotesInstruction(input.language),
      '- Leave a short implementation summary in ' + input.specDir + '/' + AUTOCODE_TASK_ARTIFACTS.directSummary + '.',
    ].join('\n');
  }

  if (input.phase === 'spec') {
    if (isChinese) {
      return `${header}${contextReference}${humanInputReference}${[
        '## 目标',
        '',
        '创建初始规格产物。',
        '',
        '## 任务描述',
        '',
        taskDescription,
        '',
        '## 必须生成的内容',
        '',
        `- 编写 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile}，包含概览、范围、实现说明和成功标准。`,
        `- 如果当前任务描述需要结构化需求，更新 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements}。`,
        `- 当证据或假设会影响任务时，在 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} 中包含 evidence_sources、standards_references 和 assumptions。`,
        `- 编写 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks}，使用 Autocode Markdown 清单组织具体阶段和任务。`,
        `- 不要编写 ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}；运行器会基于 ${AUTOCODE_TASK_ARTIFACTS.tasks} 推导运行时工作包。`,
        '- 需求、设计说明、任务范围和验证必须基于项目源码/文档、现有模式，或经过核实的官方/行业参考；如果缺少证据，请写明假设或验证任务，不要猜测。',
        '- 对分析、调查、报告或纯文档任务，规划最终 Markdown 为“读者优先”交付物：先回答用户问题，再展示主流程，再说明证据和限制。',
        '- 文档类产物应要求早期包含“结论速览”和“主流程”，主流程优先使用小型 Mermaid 图或编号决策流；源码证据矩阵、手工演练模板和检查清单放到后部或附录。',
        '- 不要把“输入/输出/副作用/生命周期/错误边界”等内部实现契约作为文档顶层结构，除非用户明确要求这种格式。',
        '- 待办子任务使用 [ ]，并附上简洁元数据项：_Depends on_、_Requirements_ 和 _Verification_。如果已知写入意图，也包含 _Files to create/modify_。',
      ].join('\n')}`;
    }

    return `${header}${contextReference}${humanInputReference}${[
      '## Goal',
      '',
      'Create initial spec artifacts.',
      '',
      '## Task Description',
      '',
      taskDescription,
      '',
      '## Required Output',
      '',
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} with overview, scope, implementation notes, and success criteria.`,
      `- Update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if the current task description needs structured requirements.`,
      `- Include evidence_sources, standards_references, and assumptions in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} when evidence or assumptions affect the task.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks} as an Autocode Markdown checklist with concrete phases and tasks.`,
      `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runner derives runtime work packages from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      '- Ground requirements, design notes, task scope, and verification in project source/docs, existing patterns, or verified official/industry references; if evidence is missing, write an assumption or validation task instead of guessing.',
      '- For analysis, investigation, report, or documentation-only tasks, plan the final Markdown as a reader-first deliverable: answer the user questions first, show the main flow second, then explain evidence and caveats.',
      '- Documentation deliverables should require an early Conclusion Snapshot, an early Main Flow with a Mermaid or numbered decision flow, scenario-based sections, and a late source-evidence appendix for large matrices/templates.',
      '- Do not make implementation-contract headings such as inputs/outputs/side effects/lifecycle/errors the top-level document structure unless the user explicitly asks for that format.',
      '- Use [ ] for pending subtasks and concise metadata bullets: _Depends on_, _Requirements_, _Evidence_, _Done when_, and _Verification_. Include _Files to create/modify_ when write intent is known.',
      '- Cover every spec success criterion with at least one task, or explicitly mark it blocked/out of scope.',
    ].join('\n')}`;
  }

  if (input.phase === 'planning') {
    if (isChinese) {
      return `${header}${contextReference}${humanInputReference}${[
        '## 目标',
        '',
        '创建或修复实施计划。',
        '',
        '## 必须生成的内容',
        '',
        `- 按需阅读 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} 和 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements}。`,
        ...buildPlanningIterationContextLines({ hasHumanReviewContext, language: input.language, specDir: input.specDir }),
        `- ${AUTOCODE_TASK_ARTIFACTS.requirements} 是规范化需求文档；如果仍是 None 占位，或本轮规划推导出具体 R1/R2 需求、场景或验收标准，先更新 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements}。`,
        `- 不要把唯一具体的 Requirement Index 只放在 ${AUTOCODE_TASK_ARTIFACTS.tasks}；请把具体需求和验收标准同步写回 ${AUTOCODE_TASK_ARTIFACTS.requirements}。`,
        `- 将 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks} 写成上游 Autocode 任务列表。`,
        `- 不要编写 ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}；运行器会基于 ${AUTOCODE_TASK_ARTIFACTS.tasks} 推导运行时工作包。`,
        '- 所有新增或修订的需求、设计说明、任务、依赖和验证命令，都必须基于项目源码/文档、现有模式，或经过核实的官方/行业参考。',
        '- 如果缺少证据，请添加假设/开放问题或验证任务；不要基于猜测创建实现工作。',
        '- 保持任务可独立实现和验证。',
        '- 将宽泛工作拆成聚焦的叶子任务：一个任务通常只覆盖一个可独立评审的行为/契约和一个聚焦验证路径。',
        '- 单个任务如果覆盖超过三个行为、超过三个需求/验收引用，或超过四个写入意图文件，就必须拆分；即使触碰同一文件，也不要把独立行为合并成大任务。',
        '- _Depends on_ 只用于真实前置关系；同文件但互不依赖的叶子任务可使用 _Depends on: none_，运行时会用文件冲突调度安全排队重叠写入。',
        '- 每个可执行任务都必须包含 _Depends on_、_Verification_ 和简短 _Evidence_ 说明。如果已知写入意图，也包含 _Files to create/modify_。',
        '- 对分析、调查、报告或纯文档任务，tasks.md 必须把最终 Markdown 规划成“读者优先”交付物：前部包含“结论速览”和“主流程”，中部按用户场景/操作路径说明，后部或附录放源码证据、手工演练模板和覆盖矩阵。',
        '- 文档类任务不要把“输入/输出/副作用/生命周期/错误边界”等内部实现契约作为最终文档顶层结构；这些内容只能作为分析细节服务于用户问题和流程说明。',
        '- 保持本轮迭代可测试、可提交：每个新增或修订任务都需要聚焦的验证命令，并且下一轮编码在验证通过后应能使用正常任务提交流程。',
        '- 新任务复选框保持 [ ]。',
      ].join('\n')}`;
    }

    return `${header}${contextReference}${humanInputReference}${[
      '## Goal',
      '',
      'Create or repair the implementation plan.',
      '',
      '## Required Output',
      '',
      `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} and ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} if needed.`,
      ...buildPlanningIterationContextLines({ hasHumanReviewContext, language: input.language, specDir: input.specDir }),
      `- Treat ${AUTOCODE_TASK_ARTIFACTS.requirements} as the canonical requirements artifact. If it still contains None placeholders, or if planning derives concrete R1/R2 requirements, scenarios, or acceptance criteria, update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} before writing ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      `- Do not keep the only concrete Requirement Index inside ${AUTOCODE_TASK_ARTIFACTS.tasks}; mirror concrete requirements and acceptance criteria into ${AUTOCODE_TASK_ARTIFACTS.requirements}.`,
      `- Write ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.tasks} as the upstream Autocode task list.`,
      `- Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runner derives runtime work packages from ${AUTOCODE_TASK_ARTIFACTS.tasks}.`,
      '- Ground every new or revised requirement, design note, task, dependency, and verification command in project source/docs, existing patterns, or verified official/industry references.',
      '- If evidence is missing, add an assumption/open question or validation task; do not create implementation work from a guess.',
      '- Keep tasks independently implementable and verifiable.',
      '- Cover every requirement, scenario, acceptance criterion, or success criterion from spec.md/requirements.md; call out blocked or out-of-scope items instead of silently dropping them.',
      '- Keep each executable task small enough for one focused coding session and include a clear done signal in guidance or _Done when: ..._.',
      '- Split broad work into focused leaf tasks: one independently reviewable behavior or contract plus one focused verification path.',
      '- A task covering more than three behaviors, more than three requirement/acceptance references, or more than four write-intent files is too broad; split it into leaf tasks even when they touch the same file.',
      '- Use _Depends on_ only for real prerequisites. For independent leaf tasks that touch the same file, use _Depends on: none_ or their actual prerequisite; the runtime queues overlapping file writes safely.',
      '- Every executable task must include _Depends on_, _Requirements_, _Verification_, and a short _Evidence_ note. Include _Files to create/modify_ when write intent is known.',
      '- For analysis, investigation, report, or documentation-only tasks, tasks.md must plan the final Markdown as reader-first: early Conclusion Snapshot, early Main Flow, scenario/operational-path sections, and source evidence plus manual templates near the end or in appendices.',
      '- Documentation tasks must not use implementation-contract headings such as inputs/outputs/side effects/lifecycle/errors as the final document top-level structure unless the user explicitly asks for that format.',
      '- Keep the iteration testable and commit-ready: every new or revised task needs a focused verification command, and the next coding pass should be able to use the normal task commit flow after validation succeeds.',
      '- Set new task checkboxes to [ ].',
    ].join('\n')}`;
  }

  if (isChinese) {
    return `${header}${contextReference}${humanInputReference}${[
      '## 目标',
      '',
      '根据现有规格和运行工作计划实现任务。',
      '',
      '## 必须遵循的流程',
      '',
      `- 首先阅读 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan}。`,
      `- 仅在缺少验收细节时参考 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile}。`,
      '- 运行器会针对每个运行时工作包调用你一次。每次调用只实现 Current Work Item 章节。',
      '- 不要提前开始后续工作包，即使它们看起来相关。',
      '- 编码期间不要编辑 implementation_plan.md 的状态复选框；运行器会在本次调用结束后负责更新状态。',
      '- 将完成详情放在最终回复或实现总结中，不要通过编辑计划状态来表达完成。',
      '- 运行项目最相关的验证命令。',
      '- 当 HUMAN_INPUT.md 或 change_requests.jsonl 存在时，将最新变更请求视为同一任务迭代：满足其中的验证指导，并在测试通过后保持变更可进入正常任务提交流程。',
      '- 编辑既有文件前，读取当前的窄范围上下文，并只针对当前精确行打补丁；如果编辑未命中，重新读取一次周边行再重试。',
      '- 将旧版或非 UTF-8 文件视为编码敏感：不要对它们使用 apply_patch 或 UTF-8 重写。请使用保留编码的脚本/工具，并保持原始文件编码。',
      '- 在旧版 Windows 游戏项目中，假设带中文注释或乱码的文件可能不是 UTF-8；编辑前先确认或保留编码。',
      '- 在 Node 24+ 中，不要在 node -e、stdin 或 eval 脚本里混用 require(...) 和顶层 await；请使用 async IIFE，或配合 node --input-type=module 使用 ESM import。',
      '- 避免针对任务初始状态或瞬时状态编写脆弱的冒烟断言；重试和恢复可能推进状态。除非任务明确修改状态机代码，否则验证最终行为或持久化文件。',
      buildCliMemoryNotesInstruction(input.language),
      `- 在 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary} 留下一段简短实现总结，或在最终回复中包含完成详情。`,
    ].join('\n')}`;
  }

  return `${header}${contextReference}${humanInputReference}${[
    '## Goal',
    '',
    'Implement the task from the existing spec and runtime work plan.',
    '',
    '## Required Workflow',
    '',
    `- Read ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan} first.`,
    `- Use ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} only for missing acceptance details.`,
    '- The runner invokes you once per runtime work package. In each invocation, implement only the Current Work Item section.',
    '- Do not start later work packages early, even if they look related.',
    '- Do not edit implementation_plan.md status checkboxes during coding; the runner owns status updates after this invocation.',
    '- Put completion details in your final response or the implementation summary, not by editing plan status.',
    '- Run the most relevant validation command for the project.',
    '- When HUMAN_INPUT.md or change_requests.jsonl exists, treat the latest change request as a same-task iteration: satisfy its validation guidance and keep the changes ready for the normal task commit flow after tests pass.',
    '- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread the surrounding lines once before retrying.',
    '- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.',
    '- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.',
    '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
    '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the task explicitly changes state-machine code.',
    buildCliMemoryNotesInstruction(input.language),
    `- Leave a short implementation summary in ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.directSummary} or include completion details in your final response.`,
  ].join('\n')}`;
}

function buildCliMemoryNotesInstruction(language?: AutocodeAgentLanguage): string {
  if (isTaskRunChineseLanguage(language)) {
    return [
      '- \u5982\u679c\u53d1\u73b0\u53ef\u957f\u671f\u590d\u7528\u7684\u9879\u76ee\u77e5\u8bc6\uff0c\u8bf7\u5728\u6700\u7ec8\u56de\u590d\u672b\u5c3e\u6dfb\u52a0\u4e00\u4e2a\u51c6\u786e\u547d\u540d\u4e3a "Memory Notes" \u7684\u7ae0\u8282\u3002',
      '- Memory Notes \u683c\u5f0f\uff1a"- [gotcha|decision|pattern|error_pattern|module_insight] \u7b80\u6d01\u53ef\u590d\u7528\u7684\u8bf4\u660e"\u3002',
      '- \u5982\u679c\u6ca1\u6709\u503c\u5f97\u957f\u671f\u8bb0\u4f4f\u7684\u5185\u5bb9\uff0c\u7701\u7565 Memory Notes\u3002',
    ].join('\n');
  }

  return [
    '- If you discover durable project knowledge, add a final "Memory Notes" section.',
    '- Memory Notes format: "- [gotcha|decision|pattern|error_pattern|module_insight] concise reusable note".',
    '- Omit Memory Notes when there is nothing durable to remember.',
  ].join('\n');
}

function buildTaskHumanInputReference(specDir: string, language?: AutocodeAgentLanguage): string {
  const humanInputPath = join(specDir, 'HUMAN_INPUT.md');
  if (!existsSync(humanInputPath)) {
    return '';
  }
  try {
    const rawContent = readFileSync(humanInputPath, 'utf8').trim();
    const content = limitTaskRunPromptText(
      rawContent,
      DIRECT_CHANGE_REQUEST_LIMIT,
      '\n...[HUMAN_INPUT.md truncated; read the file directly if exact omitted feedback is required]',
    );
    if (!content) {
      return '';
    }
    const fence = String.fromCharCode(96).repeat(3);
    if (isTaskRunChineseLanguage(language)) {
      return [
        '## \u7528\u6237\u53cd\u9988',
        '',
        '\u7528\u6237\u5728 ' + humanInputPath + ' \u63d0\u4ea4\u4e86\u540e\u7eed\u53cd\u9988\u3002\u8bf7\u5c06\u8fd9\u4e9b\u53cd\u9988\u4f5c\u4e3a\u4e0b\u4e00\u6b21\u8fd0\u884c\u7684\u5fc5\u9700\u4e0a\u4e0b\u6587\u3002',
        '',
        fence + 'markdown',
        content,
        fence,
        '',
      ].join('\n');
    }

    return [
      '## Human Input',
      '',
      'The user submitted follow-up feedback in ' + humanInputPath + '. Treat this feedback as required context for the next run.',
      '',
      fence + 'markdown',
      content,
      fence,
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

function buildTaskChangeRequestReference(specDir: string, language?: AutocodeAgentLanguage): string {
  const changeRequestsPath = join(specDir, 'change_requests.jsonl');
  if (!existsSync(changeRequestsPath)) {
    return '';
  }
  try {
    const content = readFileSync(changeRequestsPath, 'utf8').trim();
    if (!content) {
      return '';
    }
    const compactContent = compactChangeRequestJsonlForPrompt(content, {
      maxEntries: 3,
      maxChars: CHANGE_REQUEST_AUDIT_MAX_CHARS,
    });
    const fence = String.fromCharCode(96).repeat(3);

    if (isTaskRunChineseLanguage(language)) {
      return [
        '## \u53d8\u66f4\u8bf7\u6c42\u6458\u8981',
        '',
        '\u6765\u81ea ' + changeRequestsPath + '\u3002\u4f7f\u7528\u6700\u65b0\u6761\u76ee\u4f5c\u4e3a\u5f53\u524d\u540c\u4e00\u4efb\u52a1\u7684\u8fed\u4ee3\u5951\u7ea6\uff1b\u53ea\u6709\u9700\u8981\u65e7\u5386\u53f2\u7ec6\u8282\u65f6\u518d\u8bfb\u53d6\u539f JSONL \u6587\u4ef6\u3002',
        '',
        fence + 'text',
        compactContent,
        fence,
        '',
      ].join('\n');
    }

    return [
      '## Change Request Summary',
      '',
      'From ' + changeRequestsPath + '. Use the latest entry as the active same-task iteration contract; read the JSONL file directly only if older history is required.',
      '',
      fence + 'text',
      compactContent,
      fence,
      '',
    ].join('\n');
  } catch {
    return '';
  }
}

function buildDirectCliContinuationReference(specDir: string): string {
  const state = resolveAutocodeDirectSessionState(specDir);
  if (!state) {
    return '';
  }

  const lines: string[] = [];
  if (state.latestSummary) {
    lines.push('## Prior Direct Session Summary');
    lines.push('');
    lines.push(compactAutocodeDirectSessionLatestSummary(state.latestSummary) ?? '');
    lines.push('');
  }
  if (Array.isArray(state.changedFiles) && state.changedFiles.length > 0) {
    lines.push('## Files Changed Previously');
    for (const filePath of state.changedFiles.slice(0, 25)) {
      lines.push(`- ${filePath}`);
    }
    if (state.changedFiles.length > 25) {
      lines.push(`- ...${state.changedFiles.length - 25} more omitted`);
    }
    lines.push('');
  }
  return lines.length > 0 ? lines.join('\n') : '';
}

function hasTaskHumanReviewContext(specDir: string): boolean {
  return hasNonEmptyTaskFile(join(specDir, 'HUMAN_INPUT.md')) ||
    hasNonEmptyTaskFile(join(specDir, 'change_requests.jsonl'));
}

function hasNonEmptyTaskFile(filePath: string): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    return readFileSync(filePath, 'utf8').trim().length > 0;
  } catch {
    return false;
  }
}

function buildPlanningIterationContextLines(input: {
  hasHumanReviewContext: boolean;
  language?: AutocodeAgentLanguage;
  specDir: string;
}): string[] {
  if (isTaskRunChineseLanguage(input.language)) {
    if (!input.hasHumanReviewContext) {
      return [
        '- 本轮没有有效的 HUMAN_INPUT.md 或非空 change_requests.jsonl：按新任务或普通计划修复处理，不要把它当作 RequestChanges 迭代。',
        '- 从当前 spec.md、requirements.md、context.md 和项目文件生成普通待办任务；不要保留历史任务编号，不要提及旧任务历史，不要添加 revision-state 或 obsolete 标记。',
      ];
    }
    return [
      `- 如果 ${input.specDir}/HUMAN_INPUT.md 存在，将它作为计划评审反馈处理。`,
      `- 如果 ${input.specDir}/change_requests.jsonl 存在，将它作为迭代审计轨迹读取并保留此前的变更请求历史。使用最新条目的迭代契约作为当前同一任务的有效变更请求。`,
      '- 仅因为存在有效的人审反馈，本轮才按同一任务的 RequestChanges 迭代处理。',
      `- 当反馈改变需求、验收标准、用户可见行为或约束时，更新 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile}。`,
      `- 当最新变更请求改变结构化需求或验收标准时，更新 ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements}。`,
      '- 如果既有工作确实需要按最新人审反馈修订，编辑原清单项并重置为待办；needs_revision 只能出现在详情说明或元数据行，不能写进任务标题。',
      '- 只为真正新增的需求或验证缺口添加新待办任务；记录变更后，移除或压缩过时的可执行清单项，避免重复任务。',
    ];
  }

  if (!input.hasHumanReviewContext) {
    return [
      '- No valid HUMAN_INPUT.md or non-empty change_requests.jsonl is present. Treat this as a new task or ordinary planning repair, not a RequestChanges iteration.',
      '- Generate ordinary pending tasks from the current spec.md, requirements.md, context.md, and project files. Do not preserve historical task IDs, mention old task history, or add revision-state/obsolete markers.',
    ];
  }

  return [
    `- If ${input.specDir}/HUMAN_INPUT.md exists, address it as plan-review feedback.`,
    `- If ${input.specDir}/change_requests.jsonl exists, read it as the iteration audit trail and preserve prior change-request history. Use the latest entry's iteration contract as the active same-task change request.`,
    '- Only because valid human review feedback exists, treat this planning pass as a same-task RequestChanges iteration.',
    `- Update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.specFile} when feedback changes requirements, acceptance criteria, user-visible behavior, or constraints.`,
    `- Update ${input.specDir}/${AUTOCODE_TASK_ARTIFACTS.requirements} when the latest change request changes structured requirements or acceptance criteria.`,
    '- If existing work truly needs revision for the latest human feedback, edit that checklist item in place, reset it to pending, and put any needs_revision marker only in a detail note or metadata line, never in the task title.',
    '- Add pending tasks only for genuinely new requirements or verification gaps. After recording the change request, remove or compact obsolete executable checklist items to avoid duplicate tasks.',
  ];
}

function limitTaskRunPromptText(value: string, maxLength: number, suffix: string): string {
  if (maxLength <= 0) {
    return '';
  }
  const compact = compactTaskRunPromptSourceText(value);
  if (compact.length <= maxLength) {
    return compact;
  }
  const budget = Math.max(0, maxLength - suffix.length);
  if (budget <= 0) {
    return compact.slice(0, maxLength);
  }
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${compact.slice(0, headBudget).trimEnd()}${suffix}${compact.slice(-tailBudget).trimStart()}`;
}

function compactTaskRunTaskDescription(value: string): string {
  const compact = compactTaskRunPromptSourceText(value);
  if (compact.length <= AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS) {
    return compact;
  }

  const budget = Math.max(0, AUTOCODE_CLI_TASK_DESCRIPTION_MAX_CHARS - CLI_TASK_DESCRIPTION_COMPACTION_NOTICE.length);
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    compact.slice(0, headBudget).trimEnd(),
    CLI_TASK_DESCRIPTION_COMPACTION_NOTICE,
    compact.slice(-tailBudget).trimStart(),
  ].join('');
}

function compactTaskRunPromptSourceText(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  return foldRepeatedAutocodePromptLines(normalized).trim();
}

function buildTaskRunLanguageInstruction(language: AutocodeAgentLanguage): string {
  if (isTaskRunChineseLanguage(language)) {
    return [
      '\u9664\u4ee3\u7801\u3001\u8def\u5f84\u3001\u547d\u4ee4\u3001API \u540d\u79f0\u3001\u5305\u540d\u3001\u6e90\u6587\u672c\u548c\u5fc5\u8981\u82f1\u6587\u4e13\u6709\u540d\u8bcd\u5916\uff0c\u6240\u6709\u8bf4\u660e\u3001\u8ba1\u5212\u3001\u89c4\u683c\u3001\u603b\u7ed3\u548c\u8bc4\u5ba1\u5907\u6ce8\u90fd\u5fc5\u987b\u4f7f\u7528\u7b80\u4f53\u4e2d\u6587\u3002',
      '\u6700\u7ec8\u7b54\u590d\u5fc5\u987b\u662f\u7b80\u6d01\u7684\u4e2d\u6587 Markdown \u8868\u683c\uff0c\u5305\u542b\u201c\u53d8\u66f4\u201d\u201c\u9a8c\u8bc1\u201d\u201c\u8bc4\u5ba1\u5907\u6ce8\u201d\u3002',
    ].join(' ');
  }

  if (language === 'fr') {
    return [
      'Write all non-code prose in French, including plans, specs, summaries, and review notes.',
      'Keep code identifiers, commands, paths, API names, package names, and source text unchanged unless translation is requested.',
      'Final answer: concise French markdown table with rows for changes, verification, and review notes.',
    ].join(' ');
  }

  return '';
}

function isTaskRunChineseLanguage(language: AutocodeAgentLanguage): boolean {
  return typeof language === 'string' && language.trim().toLowerCase().replace(/_/g, '-').startsWith('zh');
}

export function resolveAutocodeTaskRunnerDependency(
  moduleName: string,
  options: AutocodeTaskRunnerDependencyResolutionOptions = {},
): string | undefined {
  const resolved = tryResolveAutocodeTaskRunnerDependency(
    options.resolveModule ?? ((name) => requireFromCore.resolve(name)),
    moduleName,
  );
  if (resolved) {
    return resolved;
  }

  const resourcesPath = options.resourcesPath ?? getAutocodeElectronResourcesPath();
  if (!resourcesPath) {
    return undefined;
  }

  const resourcesRequire = createRequire(join(resourcesPath, 'node_modules', '__autocode_runner_dependency__.cjs'));
  const resolvedFromResources = tryResolveAutocodeTaskRunnerDependency(
    (name) => resourcesRequire.resolve(name),
    moduleName,
  );
  if (resolvedFromResources) {
    return resolvedFromResources;
  }

  return resolvePackagedAutocodeCoreModuleFile(moduleName, resourcesPath);
}

function resolveOptionalRunnerDependency(moduleName: string): string | undefined {
  return resolveAutocodeTaskRunnerDependency(moduleName);
}

function tryResolveAutocodeTaskRunnerDependency(
  resolveModule: (moduleName: string) => string,
  moduleName: string,
): string | undefined {
  try {
    return resolveModule(moduleName);
  } catch {
    return undefined;
  }
}

function getAutocodeElectronResourcesPath(): string | undefined {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return typeof resourcesPath === 'string' && resourcesPath.length > 0 ? resourcesPath : undefined;
}

function resolvePackagedAutocodeCoreModuleFile(
  moduleName: string,
  resourcesPath: string,
): string | undefined {
  const coreDistSubpath = getPackagedAutocodeCoreDistSubpath(moduleName);
  if (!coreDistSubpath) {
    return undefined;
  }

  const candidate = join(resourcesPath, 'node_modules', '@autocode', 'core', 'dist', `${coreDistSubpath}.js`);
  return existsSync(candidate) ? candidate : undefined;
}

function getPackagedAutocodeCoreDistSubpath(moduleName: string): string | undefined {
  if (moduleName.startsWith('@autocode/core/')) {
    return moduleName.slice('@autocode/core/'.length);
  }

  if (moduleName.startsWith('./')) {
    return `tasks/${moduleName.slice(2).replace(/\.js$/u, '')}`;
  }

  return undefined;
}

function buildNodeRunnerScript(input: {
  cwd: string;
  command: string;
  args: string[];
  promptFilePath: string;
  phase: AutocodeTaskRunPhase;
  specDir: string;
  taskTitle: string;
  taskDescription: string;
  taskMetadata?: unknown;
  projectId?: string;
  language?: AutocodeAgentLanguage;
  runtimeConcurrency: AutocodeTaskRuntimeConcurrencyResolved;
  cli: AutocodeCli;
  directCliContinuationStrategy?: AutocodeCliContinuationStrategy;
  directCliJsonEventParser?: AutocodeCliJsonEventParser;
  directCliRuntimeRouteId?: string;
  directCliRuntimeRouteDisplayName?: string;
  directCliPreflightActions?: AutocodeCliPreflightAction[];
  model?: string;
}): string {
  return `const { spawn, spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { basename, dirname, isAbsolute, join, relative, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const { TextDecoder } = require('node:util');

const cwd = ${JSON.stringify(input.cwd)};
const command = ${JSON.stringify(input.command)};
const args = ${JSON.stringify(input.args)};
const cli = ${JSON.stringify(input.cli)};
const directCliRuntimeRouteId = ${JSON.stringify(input.directCliRuntimeRouteId ?? '')};
const directCliRuntimeRouteDisplayName = ${JSON.stringify(input.directCliRuntimeRouteDisplayName ?? '')};
const directCliModelId = ${JSON.stringify(input.model ?? '')};
const directCliContinuationStrategy = ${JSON.stringify(input.directCliContinuationStrategy ?? null)};
const cliPreflightActions = ${JSON.stringify(input.directCliPreflightActions ?? [])};
const cliJsonEventParsers = ${JSON.stringify([
    ...(input.directCliJsonEventParser ? [input.directCliJsonEventParser] : []),
    ...getAutocodeCliJsonEventParsers(),
  ])};
const iconvLiteModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('iconv-lite'))};
const workPackagesModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@autocode/core/tasks/work-packages') ?? resolveOptionalRunnerDependency('./work-packages.js'))};
const planQualityModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@autocode/core/tasks/plan-quality') ?? resolveOptionalRunnerDependency('./plan-quality.js'))};
const directTaskSummaryModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@autocode/core/runtime/direct-task-summary') ?? resolveOptionalRunnerDependency('../runtime/direct-task-summary.js'))};
const libsqlSqlite3ModulePath = ${JSON.stringify(resolveOptionalRunnerDependency('@libsql/client/sqlite3'))};
const promptFilePath = ${JSON.stringify(input.promptFilePath)};
const phase = ${JSON.stringify(input.phase)};
const specDir = ${JSON.stringify(input.specDir)};
const projectDataRelativeDir = inferRunnerProjectDataRelativeDir();
const taskTitle = ${JSON.stringify(input.taskTitle)};
const taskDescription = ${JSON.stringify(input.taskDescription)};
const taskMetadata = ${JSON.stringify(input.taskMetadata ?? {})};
const projectId = ${JSON.stringify(input.projectId)};
const language = ${JSON.stringify(input.language)};
const runtimeConcurrency = ${JSON.stringify(input.runtimeConcurrency)};
const artifacts = ${JSON.stringify(AUTOCODE_TASK_ARTIFACTS)};
const directSessionStateVersion = ${JSON.stringify(AUTOCODE_DIRECT_SESSION_STATE_VERSION)};
const taskEventPrefix = ${JSON.stringify(AUTOCODE_TASK_EVENT_PREFIX)};
const fileWriteLockScope = inferFileWriteLockScope();
const iconvLite = loadIconvLite();
const prompt = readFileSync(promptFilePath, 'utf8');
const logPhase = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
const executionPhase = logPhase === 'coding' ? 'coding' : 'planning';
const activeCliJsonEventParser = resolveCliJsonEventParser(command, args);
const cliJsonMode = Boolean(activeCliJsonEventParser);
const DEFAULT_CLI_JSON_PAYLOAD_FIELDS = ['payload', 'msg.payload', 'msg', 'event', 'data', 'item', 'response_item', 'response'];
const DEFAULT_CLI_JSON_EVENT_TYPE_FIELDS = ['type', 'event_type', 'eventType', 'kind', 'name'];
const DEFAULT_CLI_JSON_SESSION_ID_FIELDS = ['session_id', 'sessionId', 'conversation_id', 'conversationId', 'thread_id', 'threadId', 'run_id', 'runId', 'session.id', 'conversation.id', 'thread.id'];
const DEFAULT_CLI_JSON_MESSAGE_FIELDS = ['message', 'content', 'text', 'output', 'delta', 'response.output_text', 'response.outputText'];
const DEFAULT_CLI_JSON_COMPLETION_EVENT_TYPES = ['turn_completed', 'response_completed', 'completed', 'done', 'finish', 'finished', 'message_stop', 'result'];
const DEFAULT_CLI_JSON_IGNORED_EVENT_TYPES = [];
const DEFAULT_CLI_JSON_IGNORED_EVENT_TYPE_INCLUDES = [];
const DEFAULT_CLI_JSON_TOOL_START_EVENT_TYPES = [];
const DEFAULT_CLI_JSON_TOOL_END_EVENT_TYPES = [];
const DEFAULT_CLI_JSON_TOOL_NAME_FIELDS = ['name', 'tool_name', 'toolName'];
const DEFAULT_CLI_JSON_TOOL_INPUT_FIELDS = ['arguments', 'input', 'args', 'command', 'cmd'];
const DEFAULT_CLI_JSON_TOOL_OUTPUT_FIELDS = ['output', 'content', 'result', 'aggregated_output', 'stdout', 'stderr'];
const DEFAULT_CLI_JSON_TOOL_CALL_ID_FIELDS = ['call_id', 'callId', 'id'];
const DEFAULT_CLI_JSON_TOOL_SUCCESS_FIELDS = ['success'];
const DEFAULT_CLI_JSON_TOOL_EXIT_CODE_FIELDS = ['exit_code', 'exitCode'];
const DEFAULT_CLI_JSON_TOOL_STATUS_FIELDS = ['status'];
const activeFileWriteLockDirs = new Set();
const maxValidationRetries = phase === 'spec' || phase === 'planning' ? 2 : 0;
const maxDirectRetries = phase === 'direct' ? 2 : 0;
const DIRECT_QUALITY_RETRY_FEEDBACK_MAX_CHARS = 1600;
const DIRECT_QUALITY_RETRY_FILE_PREVIEW_LIMIT = 12;
const VALIDATION_RETRY_BASE_PROMPT_MAX_CHARS = 6000;
const VALIDATION_RETRY_ERROR_MAX_CHARS = 1200;
const RUNNER_REPEATED_LINE_MIN_CHARS = 24;
let validationRetryCount = 0;
let directRetryCount = 0;
const directFailureSignatures = [];
let attemptId = 0;
let currentAttemptStartedAt = Date.now();
let currentAttemptDurationRecorded = false;
let directActiveDurationMs = 0;
let activeCliJsonSessionId = '';
let memoryContextBlock = '';
const pendingMemoryWrites = [];
const runStartedAt = Date.now();
const startMessage = logPhase === 'coding'
  ? localizeMessage('startCoding', \`Starting Autocode \${phase} coding session with \${command}.\`, { phase, command })
  : localizeMessage('startPlanning', \`Starting Autocode \${phase} planning session with \${command}.\`, { phase, command });

emitPhase(executionPhase, startMessage, 0);
updatePlanRunningState();
updateTaskLogs(logPhase, 'active', startMessage);
runCliPreflightActions();

let finalized = false;
let tokenUsageEventCount = 0;
let tokenUsageImplicitSessionCounted = false;
let lastTokenUsageLogTotal = 0;
let gb18030Decoder = undefined;
let directTaskSummaryModulePromise = undefined;
const defaultAttemptState = createAttemptState('main');
const directChangedFileBaseline = phase === 'direct'
  ? collectRunnerGitChangedFileSnapshot()
  : { files: new Set() };
const codingWorkerLimit = phase === 'coding' && runtimeConcurrency.mode === 'concurrent'
  ? Math.max(1, Math.floor(runtimeConcurrency.workers || 1))
  : 1;
const activeCodingAttempts = new Map();
const activeCodingSubtaskIds = new Set();
const completedCodingSubtaskIds = new Set();
const failedCodingSubtaskIds = new Set();
const codingFailures = [];
let nextCodingWorkerId = 0;
const MODEL_OUTPUT_FLUSH_MS = 750;
const MODEL_OUTPUT_MAX_CHARS = 3500;
const CLI_MEMORY_CONTEXT_MAX_CHARS = 1800;
const CLI_MEMORY_ITEM_MAX_CHARS = 260;
const CLI_MEMORY_RELATED_FILES_MAX = 3;
const CLI_MEMORY_FILE_MAX_CHARS = 80;
const CLI_MEMORY_LOCAL_CONTENT_MAX_CHARS = 600;
const CLI_MEMORY_STORAGE_CONTENT_MAX_CHARS = 1200;
const CLI_MEMORY_STORAGE_FIELD_MAX_CHARS = 500;
const CLI_MEMORY_STORAGE_FILE_REF_LIMIT = 12;
const CLI_MEMORY_STORAGE_FILE_REF_MAX_CHARS = 160;
const CLI_LOW_VALUE_WHOLE_MEMORY_LINE_PATTERNS = [
  /^(?:Summary:\\s*)?No memory search run\\b/i,
  /^(?:Summary:\\s*)?No relevant (?:[\\w/-]+\\s+)*memories found\\b/i,
  /^(?:Summary:\\s*)?Memory search results\\b/i,
  /^(?:Summary:\\s*)?Memory system not available\\b/i,
  /^(?:Summary:\\s*)?Memory (?:recorded|skipped|noted locally|not persisted|search unavailable|system not available)\\b/i,
  /^(?:Summary:\\s*)?Work unit .+ finished with outcome:\\s*success\\.?$/i,
];
const CLI_LOW_VALUE_MEMORY_LINE_PATTERNS = [
  ...CLI_LOW_VALUE_WHOLE_MEMORY_LINE_PATTERNS,
  /^(?:Summary:\\s*)?Efficient token usage\\b/i,
  /^(?:Summary:\\s*)?High token usage per step\\b/i,
  /^(?:Summary:\\s*)?inspect focused files next\\.?$/i,
  /^(?:Summary:\\s*)?Completed quickly with few steps\\b/i,
  /^(?:Summary:\\s*)?Many steps required\\b/i,
  /^(?:Summary:\\s*)?Used diverse set of tools\\b/i,
  /^(?:Summary:\\s*)?(?:task|implementation|session|work|subtask)\\s+(?:completed|finished|done|succeeded)\\b/i,
  /^(?:Summary:\\s*)?completed successfully\\b/i,
  /^(?:Summary:\\s*)?(?:tests?|checks?|typecheck|lint|build)\\s+(?:passed|succeeded)\\.?$/i,
  /^(?:Summary:\\s*)?(?:[\\w./:-]+\\s+){1,5}(?:tests?|checks?|typecheck|lint|build)\\s+(?:passed|succeeded)\\.?$/i,
  /^(?:Summary:\\s*)?all tests passed\\b/i,
  /^(?:Summary:\\s*)?no issues found\\b/i,
  /^Completed at:\\s*\\S+/i,
  /^Duration:\\s*\\d+ms$/i,
  /^(?:Summary:\\s*)?\\u9ad8\\u6548\\s*token\\s*(?:\\u4f7f\\u7528|\\u6d88\\u8017)/i,
  /^(?:Summary:\\s*)?token\\s*(?:\\u4f7f\\u7528|\\u6d88\\u8017|\\u7528\\u91cf).*(?:\\u9ad8|\\u4f4e|\\u5c11|\\u591a)/i,
  /^(?:Summary:\\s*)?(?:\\u4efb\\u52a1|\\u5b9e\\u73b0|\\u4f1a\\u8bdd|\\u5de5\\u4f5c|\\u5b50\\u4efb\\u52a1)\\s*(?:\\u5df2)?(?:\\u5b8c\\u6210|\\u7ed3\\u675f|\\u6210\\u529f)/i,
  /^(?:Summary:\\s*)?(?:\\u5168\\u90e8|\\u6240\\u6709)?\\s*\\u6d4b\\u8bd5\\s*(?:\\u5df2)?\\u901a\\u8fc7/i,
  /^(?:Summary:\\s*)?(?:\\u7c7b\\u578b\\u68c0\\u67e5|\\u6784\\u5efa|\\u7f16\\u8bd1|\\u68c0\\u67e5|lint)\\s*(?:\\u5df2)?\\u901a\\u8fc7[.\\u3002]?$/i,
  /^(?:Summary:\\s*)?(?:\\u6ca1\\u6709|\\u672a)\\s*\\u53d1\\u73b0\\u95ee\\u9898/i,
  /^(?:Summary:\\s*)?\\u65e0\\u95ee\\u9898/i,
];
const CLI_LOW_VALUE_MEMORY_FRAGMENT_SPLIT_PATTERN = /(?<=[.!?\\u3002\\uff01\\uff1f])\\s+|;\\s+/;
const CODING_WORKER_INACTIVITY_WARNING_MS = readNonNegativeInteger(
  process.env.AUTOCODE_WORKER_INACTIVITY_WARNING_MS,
  10 * 60 * 1000,
);
const CODING_WORKER_INACTIVITY_TIMEOUT_MS = readNonNegativeInteger(
  process.env.AUTOCODE_WORKER_INACTIVITY_TIMEOUT_MS,
  45 * 60 * 1000,
);
const CODING_WORKER_COMPLETION_GRACE_MS = readPositiveInteger(
  process.env.AUTOCODE_WORKER_COMPLETION_GRACE_MS,
  45 * 1000,
);
const DIRECT_ATTEMPT_COMPLETION_GRACE_MS = readPositiveInteger(
  process.env.AUTOCODE_DIRECT_COMPLETION_GRACE_MS,
  CODING_WORKER_COMPLETION_GRACE_MS,
);
const DIRECT_ATTEMPT_INACTIVITY_WARNING_MS = readNonNegativeInteger(
  process.env.AUTOCODE_DIRECT_INACTIVITY_WARNING_MS,
  CODING_WORKER_INACTIVITY_WARNING_MS,
);
const DIRECT_ATTEMPT_INACTIVITY_TIMEOUT_MS = readNonNegativeInteger(
  process.env.AUTOCODE_DIRECT_INACTIVITY_TIMEOUT_MS,
  CODING_WORKER_INACTIVITY_TIMEOUT_MS,
);
const NOISY_CLI_DIAGNOSTIC_PATTERNS = [
  /WARN\\s+codex_core::shell_snapshot:\\s+Failed to create shell snapshot for powershell\\b/i,
  /WARN\\s+codex_core_plugins::manifest:\\s+ignoring interface\\.defaultPrompt\\[[0-9]+\\]:\\s+prompt must be at most [0-9]+ characters\\b/i,
  /WARN\\s+codex_core_skills::loader:\\s+ignoring interface\\.icon_(?:small|large):\\s+icon path with '\\.\\.' must resolve under plugin assets\\//i,
];
const CLI_FAILURE_SIGNAL_PATTERNS = [
  /\\bERROR\\b/i,
  /\\bFATAL\\b/i,
  /\\b(?:failed|failure|error|exception)\\b/i,
  /stream disconnected/i,
  /tls handshake eof/i,
  /http\\/request failed/i,
  /error sending request/i,
  /transport channel closed/i,
  /failed to connect to websocket/i,
  /exited by signal/i,
];
const CLI_RATE_LIMIT_SIGNAL_PATTERNS = [
  /(?:you['’]?ve|you have)\\s+hit\\s+your\\s+usage\\s+limit/i,
  /\\busage[_\\s-]*limit[_\\s-]*(?:exceeded|reached)\\b/i,
  /\\brate\\s*limit\\b/i,
  /\\btoo\\s*many\\s*requests\\b/i,
  /\\bquota\\s*(?:exceeded|reached)\\b/i,
];

initializeCliMemoryRuntime()
  .then((contextBlock) => {
    memoryContextBlock = contextBlock;
    if (phase === 'coding') {
      startCodingWorkQueue();
    } else {
      startAttempt(buildPromptWithMemoryContext(prompt));
    }
  })
  .catch((error) => {
    appendTaskLogEntry(logPhase, 'info', 'Memory context unavailable: ' + (error instanceof Error ? error.message : String(error)));
    if (phase === 'coding') {
      startCodingWorkQueue();
    } else {
      startAttempt(prompt);
    }
  });

async function initializeCliMemoryRuntime() {
  if (!isCliMemoryEnabled()) {
    return '';
  }
  const memories = [
    ...loadCliLocalSessionMemories(3),
    ...await searchCliMemoryDatabase(taskDescription || taskTitle, 5),
  ];
  const deduped = dedupeCliMemories(memories).slice(0, 6);
  if (deduped.length === 0) {
    return '';
  }
  const lines = [
    '## Project Memory',
    '',
    'Use these prior outcomes, gotchas, decisions, architecture references, and design patterns when relevant. Confirm similar-task references against current source/docs, and do not repeat failed approaches.',
    '',
  ];
  let omitted = 0;
  let included = 0;
  for (const memory of deduped) {
    const line = formatCliMemoryPromptLine(memory);
    if (!line) {
      continue;
    }
    const next = lines.concat(line).join('\\n');
    if (next.length > CLI_MEMORY_CONTEXT_MAX_CHARS) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    included += 1;
  }
  if (included === 0) {
    return '';
  }
  if (omitted > 0) {
    lines.push('- ... ' + omitted + ' more memory item(s) omitted; search memory only if needed.');
  }
  return limitCliMemoryContext(lines.join('\\n'));
}

function formatCliMemoryPromptLine(memory) {
  const memoryContent = stripCliLowValueMemoryText(memory.content);
  if (!memoryContent) {
    return '';
  }
  const sourceRelatedFiles = Array.isArray(memory.relatedFiles)
    ? memory.relatedFiles.filter(Boolean)
    : [];
  const relatedFiles = sourceRelatedFiles
    .slice(0, CLI_MEMORY_RELATED_FILES_MAX)
    .map((file) => limitLogText(file, CLI_MEMORY_FILE_MAX_CHARS));
  const files = relatedFiles.length > 0
    ? ' Files: ' + relatedFiles.join(', ') + (sourceRelatedFiles.length > relatedFiles.length ? ', ...' : '') + '.'
    : '';
  return '- [' + formatCliMemoryPromptType(memory.type) + '] ' + limitLogText(memoryContent, CLI_MEMORY_ITEM_MAX_CHARS) + files;
}

function formatCliMemoryPromptType(type) {
  const value = String(type || 'memory');
  return /^(?:pattern|decision|module_insight|workflow_recipe)$/.test(value)
    ? 'architecture/reference:' + value
    : value;
}

function stripCliLowValueMemoryText(content) {
  return String(content || '')
    .split(/\\r?\\n/)
    .map(stripCliLowValueMemoryLine)
    .filter(Boolean)
    .join('\\n')
    .trim();
}

function stripCliLowValueMemoryLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) {
    return '';
  }
  if (isCliLowValueWholeMemoryLine(trimmed)) {
    return '';
  }
  const fragments = trimmed
    .split(CLI_LOW_VALUE_MEMORY_FRAGMENT_SPLIT_PATTERN)
    .map((fragment) => fragment.trim())
    .filter(Boolean);
  if (fragments.length <= 1) {
    return isCliLowValueMemoryLine(trimmed) ? '' : trimmed;
  }
  return fragments
    .filter((fragment) => !isCliLowValueMemoryLine(fragment))
    .join(' ')
    .trim();
}

function isCliLowValueMemoryLine(line) {
  return CLI_LOW_VALUE_MEMORY_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function isCliLowValueWholeMemoryLine(line) {
  return CLI_LOW_VALUE_WHOLE_MEMORY_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

function limitCliMemoryContext(value) {
  return limitLogText(value, CLI_MEMORY_CONTEXT_MAX_CHARS);
}

function buildPromptWithMemoryContext(basePrompt) {
  if (!memoryContextBlock) {
    return basePrompt;
  }
  return [basePrompt, '', '---', '', memoryContextBlock].join('\\n');
}

function formatPromptForCli(basePrompt) {
  return basePrompt;
}

function isCliMemoryEnabled() {
  return String(process.env.GRAPHITI_ENABLED || 'true').toLowerCase() !== 'false';
}

function getCliMemoryProjectId() {
  return projectId ||
    (taskMetadata && typeof taskMetadata.projectId === 'string' && taskMetadata.projectId.trim()) ||
    (taskMetadata && typeof taskMetadata.project_id === 'string' && taskMetadata.project_id.trim()) ||
    cwd;
}

function getCliMemorySessionId(workUnitId) {
  return 'cli:' + (specDir.split(/[\\\\/]/).pop() || taskTitle) + ':' + workUnitId + ':' + Date.now();
}

function loadCliLocalSessionMemories(limit) {
  const dir = join(specDir, 'memory', 'session_insights');
  if (!existsSync(dir)) {
    return [];
  }
  try {
    return readdirSync(dir)
      .filter((name) => /^session_.+\\.json$/i.test(name))
      .map((name) => {
        const filePath = join(dir, name);
        return { filePath, stat: statSync(filePath) };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, limit)
      .map(({ filePath }) => {
        const insight = readJson(filePath);
        if (!insight) return null;
        const content = compactCliLocalSessionMemoryContent(insight);
        if (!content) return null;
        return {
          id: insight.sessionId || filePath,
          type: 'work_unit_outcome',
          content,
          confidence: 0.7,
          relatedFiles: Array.isArray(insight.keyFiles) ? insight.keyFiles : [],
          createdAt: insight.timestamp || new Date().toISOString(),
        };
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function compactCliLocalSessionMemoryContent(insight) {
  const parts = buildCliLocalSessionMemoryParts(insight)
    .map((part) => stripCliLowValueMemoryText(
      foldRepeatedRunnerPromptLines(cleanLogText(part)),
    ))
    .filter(Boolean);
  return limitLogText(parts.join('\\n'), CLI_MEMORY_LOCAL_CONTENT_MAX_CHARS);
}

function buildCliLocalSessionMemoryParts(insight) {
  const parts = [];
  const successPattern = Array.isArray(insight.successPatterns) ? insight.successPatterns[0] : null;
  if (successPattern) {
    parts.push(
      successPattern.description,
      successPattern.approach,
      successPattern.whyItWorked,
    );
    if (Array.isArray(successPattern.keyDecisions)) {
      parts.push(...successPattern.keyDecisions.slice(0, 3));
    }
  }

  const failurePattern = Array.isArray(insight.failurePatterns) ? insight.failurePatterns[0] : null;
  if (failurePattern) {
    parts.push(
      failurePattern.rootCause,
      failurePattern.prevention,
      failurePattern.attemptedApproach,
    );
  }

  if (Array.isArray(insight.insights)) {
    parts.push(...insight.insights);
  }

  return parts.filter(Boolean);
}

async function searchCliMemoryDatabase(query, limit) {
  if (!libsqlSqlite3ModulePath) {
    return [];
  }
  let client = null;
  try {
    const mod = require(libsqlSqlite3ModulePath);
    client = mod.createClient({ url: 'file:' + resolveCliMemoryDatabasePath() });
    await ensureCliMemorySchema(client);
    const projectFilter = getCliMemoryProjectId();
    const ftsRows = query
      ? await client.execute({
          sql:
            'SELECT m.id, m.type, m.content, m.confidence, m.related_files, m.tags, m.created_at ' +
            'FROM memories_fts f JOIN memories m ON m.id = f.memory_id ' +
            'WHERE memories_fts MATCH ? AND m.project_id = ? AND m.deprecated = 0 ' +
            'ORDER BY bm25(memories_fts) LIMIT ?',
          args: [sanitizeCliFtsQuery(query), projectFilter, limit],
        }).catch(() => ({ rows: [] }))
      : { rows: [] };
    const rows = ftsRows.rows.length > 0
      ? ftsRows
      : await client.execute({
          sql:
            'SELECT id, type, content, confidence, related_files, tags, created_at ' +
            'FROM memories WHERE project_id = ? AND deprecated = 0 ' +
            'ORDER BY created_at DESC LIMIT ?',
          args: [projectFilter, limit],
        });
    return rows.rows.map(cliMemoryRowToContextMemory);
  } catch {
    return [];
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function recordCliWorkItemMemory(subtask, outcome, summary, explicitNotes) {
  if (!isCliMemoryEnabled()) {
    return null;
  }
  const now = new Date().toISOString();
  const files = compactCliMemoryStorageFiles(getWorkItemFiles(subtask || {}));
  const sessionId = getCliMemorySessionId(subtask.id || 'task');
  const compactSummary = limitCliMemoryStorageText(summary);
  const memoryNotes = compactCliExplicitMemoryNotes(explicitNotes);
  const content = buildCliWorkUnitOutcomeContent(subtask, outcome, summary, files, now);
  const insight = {
    sessionId,
    subtaskId: subtask.id || 'task',
    timestamp: now,
    outcome,
    insights: [
      compactSummary || content,
      ...memoryNotes.map((note) => note.content),
    ].filter(Boolean),
    keyFiles: files,
    source: 'cli-runner',
    workUnit: {
      id: subtask.id || 'task',
      title: subtask.title || taskTitle,
      description: limitCliMemoryStorageText(Array.isArray(subtask.details) && subtask.details.length > 0 ? subtask.details.join('\\n') : taskDescription),
      upstreamTaskIds: Array.isArray(subtask.upstreamTaskIds) ? subtask.upstreamTaskIds : [],
    },
  };
  writeCliSessionInsight(sessionId, insight);
  pendingMemoryWrites.push(storeCliMemoryDatabaseEntry({
    id: randomUUID(),
    type: 'work_unit_outcome',
    content,
    confidence: outcome === 'success' ? 0.82 : 0.72,
    tags: ['work_unit', outcome, 'cli-runner', phase].filter(Boolean),
    relatedFiles: files,
    relatedModules: [],
    createdAt: now,
    sessionId,
    scope: 'work_unit',
    source: 'agent_explicit',
    projectId: getCliMemoryProjectId(),
    workUnitRef: {
      methodology: 'autocode',
      hierarchy: [phase, subtask.id || 'task'],
      label: (subtask.id || 'task') + (subtask.title ? ': ' + subtask.title : ''),
    },
    citationText: compactSummary,
  }));
  for (const note of memoryNotes) {
    pendingMemoryWrites.push(storeCliMemoryDatabaseEntry({
      id: randomUUID(),
      type: note.type,
      content: note.content,
      confidence: 0.78,
      tags: ['cli-runner', 'explicit_memory', phase, note.type].filter(Boolean),
      relatedFiles: files,
      relatedModules: [],
      createdAt: now,
      sessionId,
      scope: files.length > 0 ? 'module' : 'session',
      source: 'agent_explicit',
      projectId: getCliMemoryProjectId(),
      workUnitRef: {
        methodology: 'autocode',
        hierarchy: [phase, subtask.id || 'task', 'memory_notes'],
        label: (subtask.id || 'task') + ' memory note',
      },
      citationText: note.content,
    }));
  }
  return sessionId;
}

function writeCliSessionInsight(sessionId, insight) {
  try {
    const dir = join(specDir, 'memory', 'session_insights');
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'session_' + safeFileSegment(sessionId) + '.json'), insight);
  } catch (error) {
    appendTaskLogEntry('coding', 'info', 'Failed to write session memory: ' + (error instanceof Error ? error.message : String(error)));
  }
}

async function storeCliMemoryDatabaseEntry(entry) {
  if (!libsqlSqlite3ModulePath) {
    return;
  }
  let client = null;
  try {
    const mod = require(libsqlSqlite3ModulePath);
    client = mod.createClient({ url: 'file:' + resolveCliMemoryDatabasePath() });
    await ensureCliMemorySchema(client);
    await client.batch([
      {
        sql:
          'INSERT OR REPLACE INTO memories (' +
          'id, type, content, confidence, tags, related_files, related_modules, created_at, last_accessed_at, access_count, ' +
          'session_id, scope, work_unit_ref, methodology, source, relations, provenance_session_ids, needs_review, pinned, citation_text, project_id, trust_level_scope, deprecated' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, 0)',
        args: [
          entry.id,
          entry.type,
          entry.content,
          entry.confidence,
          JSON.stringify(entry.tags || []),
          JSON.stringify(entry.relatedFiles || []),
          JSON.stringify(entry.relatedModules || []),
          entry.createdAt,
          entry.createdAt,
          entry.sessionId,
          entry.scope,
          JSON.stringify(entry.workUnitRef || null),
          'autocode',
          entry.source,
          '[]',
          '[]',
          entry.citationText || null,
          entry.projectId,
          'personal',
        ],
      },
      {
        sql: 'INSERT INTO memories_fts (memory_id, content, tags, related_files) VALUES (?, ?, ?, ?)',
        args: [
          entry.id,
          entry.content,
          (entry.tags || []).join(' '),
          (entry.relatedFiles || []).join(' '),
        ],
      },
    ]);
  } catch (error) {
    appendTaskLogEntry('coding', 'info', 'Memory DB write skipped: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    try {
      client?.close();
    } catch {
      // Ignore close failures.
    }
  }
}

async function flushCliMemoryWrites() {
  if (pendingMemoryWrites.length === 0) {
    return;
  }
  const writes = pendingMemoryWrites.splice(0, pendingMemoryWrites.length);
  await Promise.allSettled(writes);
}

async function ensureCliMemorySchema(client) {
  await client.execute(
    'CREATE TABLE IF NOT EXISTS memories (' +
    'id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.8, ' +
    'tags TEXT NOT NULL DEFAULT \\'[]\\', related_files TEXT NOT NULL DEFAULT \\'[]\\', related_modules TEXT NOT NULL DEFAULT \\'[]\\', ' +
    'created_at TEXT NOT NULL, last_accessed_at TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0, session_id TEXT, commit_sha TEXT, ' +
    'scope TEXT NOT NULL DEFAULT \\'global\\', work_unit_ref TEXT, methodology TEXT, source TEXT NOT NULL DEFAULT \\'agent_explicit\\', ' +
    'target_node_id TEXT, impacted_node_ids TEXT DEFAULT \\'[]\\', relations TEXT NOT NULL DEFAULT \\'[]\\', decay_half_life_days REAL, ' +
    'provenance_session_ids TEXT DEFAULT \\'[]\\', needs_review INTEGER NOT NULL DEFAULT 0, user_verified INTEGER NOT NULL DEFAULT 0, ' +
    'citation_text TEXT, pinned INTEGER NOT NULL DEFAULT 0, deprecated INTEGER NOT NULL DEFAULT 0, deprecated_at TEXT, stale_at TEXT, ' +
    'project_id TEXT NOT NULL, trust_level_scope TEXT DEFAULT \\'personal\\', chunk_type TEXT, chunk_start_line INTEGER, chunk_end_line INTEGER, ' +
    'context_prefix TEXT, embedding_model_id TEXT)'
  );
  await client.execute(
    'CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(memory_id UNINDEXED, content, tags, related_files, tokenize=\\'porter unicode61\\')'
  );
}

function buildCliWorkUnitOutcomeContent(subtask, outcome, summary, files, completedAt) {
  const title = subtask.title ? ' (' + subtask.title + ')' : '';
  const upstream = Array.isArray(subtask.upstreamTaskIds) && subtask.upstreamTaskIds.length > 0
    ? 'Upstream tasks: ' + subtask.upstreamTaskIds.join(', ')
    : '';
  return limitCliMemoryStorageText([
    'Work unit ' + (subtask.id || 'task') + title + ' finished with outcome: ' + outcome + '.',
    Array.isArray(subtask.details) && subtask.details.length > 0 ? 'Task: ' + limitCliMemoryStorageText(subtask.details.join('\\n')) : '',
    summary ? 'Summary: ' + limitCliMemoryStorageText(summary) : '',
    upstream,
    files.length > 0 ? 'Files: ' + files.join(', ') : '',
    'Completed at: ' + completedAt,
  ].filter(Boolean).join('\\n'), CLI_MEMORY_STORAGE_CONTENT_MAX_CHARS);
}

function limitCliMemoryStorageText(value, maxLength = CLI_MEMORY_STORAGE_FIELD_MAX_CHARS) {
  return limitLogText(value, maxLength);
}

function compactCliMemoryStorageFiles(files) {
  return [...new Set((Array.isArray(files) ? files : [])
    .map((file) => limitLogText(file, CLI_MEMORY_STORAGE_FILE_REF_MAX_CHARS))
    .filter(Boolean))]
    .slice(0, CLI_MEMORY_STORAGE_FILE_REF_LIMIT);
}

function resolveCliMemoryDatabasePath() {
  const database = normalizeCliDatabaseFilename(process.env.GRAPHITI_DATABASE || 'auto_claude_memory');
  const configuredPath = process.env.GRAPHITI_DB_PATH || join(getCliHomeDir(), '.autocode', 'memories');
  const expanded = expandCliHomePath(configuredPath);
  const basePath = resolve(expanded);
  mkdirSync(basePath, { recursive: true });
  return join(basePath, database);
}

function getCliHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || cwd;
}

function expandCliHomePath(value) {
  const text = String(value || '').trim();
  if (text === '~') return getCliHomeDir();
  if (text.startsWith('~/') || text.startsWith('~\\\\')) {
    return join(getCliHomeDir(), text.slice(2));
  }
  return text;
}

function normalizeCliDatabaseFilename(value) {
  const name = String(value || 'auto_claude_memory').trim() || 'auto_claude_memory';
  return name.toLowerCase().endsWith('.db') ? name : name + '.db';
}

function cliMemoryRowToContextMemory(row) {
  return {
    id: String(row.id || ''),
    type: String(row.type || 'work_unit_outcome'),
    content: String(row.content || ''),
    confidence: Number(row.confidence || 0.7),
    relatedFiles: parseJsonArray(row.related_files),
    createdAt: String(row.created_at || ''),
  };
}

function dedupeCliMemories(memories) {
  const seen = new Set();
  const result = [];
  for (const memory of memories) {
    if (!memory || !memory.content) continue;
    const contentKey = normalizeCliMemoryNoteKey(
      stripCliLowValueMemoryText(memory.content),
    );
    if (!contentKey) continue;
    const key = (memory.type || 'memory') + ':' + contentKey;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(memory);
  }
  return result;
}

function sanitizeCliFtsQuery(value) {
  const words = String(value || '')
    .replace(/["'\\x60*()[\\]{}:]/g, ' ')
    .split(/\\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
    .slice(0, 12);
  return words.length > 0 ? words.join(' OR ') : 'Autocode';
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeFileSegment(value) {
  return String(value || 'memory').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 160);
}

function compactCliExplicitMemoryNotes(explicitNotes) {
  const seen = new Set();
  const notes = [];
  for (const note of Array.isArray(explicitNotes) ? explicitNotes : []) {
    const content = limitCliMemoryStorageText(
      stripCliLowValueMemoryText(note && note.content),
    );
    const key = normalizeCliMemoryNoteKey(content);
    if (content.length < 10 || !key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    notes.push({
      ...note,
      type: normalizeCliMemoryNoteType(note && note.type),
      content,
    });
    if (notes.length >= 5) {
      break;
    }
  }
  return notes;
}

function extractCliMemoryNotes(text) {
  const normalized = String(text || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const match = /^#{1,6}\\s*Memory Notes\\s*$/im.exec(normalized);
  if (!match) {
    return [];
  }
  const section = normalized.slice(match.index + match[0].length);
  const nextHeading = /\\n#{1,6}\\s+\\S/.exec(section);
  const body = (nextHeading ? section.slice(0, nextHeading.index) : section).trim();
  const notes = [];
  for (const line of body.split('\\n')) {
    const bullet = /^\\s*(?:[-*]|\\d+[.)])\\s+(.*)$/.exec(line);
    if (!bullet) continue;
    let content = bullet[1].trim();
    let type = 'module_insight';
    const typed = /^\\[([a-z_]+)\\]\\s*(.*)$/.exec(content);
    if (typed) {
      type = normalizeCliMemoryNoteType(typed[1]);
      content = typed[2].trim();
    }
    notes.push({ type, content });
  }
  return compactCliExplicitMemoryNotes(notes);
}

function normalizeCliMemoryNoteType(value) {
  const type = String(value || '').trim().toLowerCase();
  if ([
    'gotcha',
    'decision',
    'pattern',
    'error_pattern',
    'module_insight',
    'dead_end',
    'causal_dependency',
    'requirement',
  ].includes(type)) {
    return type;
  }
  return 'module_insight';
}

function normalizeCliMemoryNoteKey(value) {
  return String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
}

function spawnCli(commandValue, argValues, options) {
  const plan = buildCliSpawnPlan(commandValue, Array.isArray(argValues) ? argValues : []);
  return spawn(plan.command, plan.args, {
    ...options,
    ...(plan.options || {}),
  });
}

function buildCliSpawnPlan(commandValue, argValues) {
  const commandText = String(commandValue || '');
  if (process.platform !== 'win32') {
    return { command: commandText, args: argValues, options: { shell: false } };
  }

  const resolvedCommand = resolveWindowsCliCommand(commandText) || commandText;
  if (isWindowsCommandScript(resolvedCommand)) {
    const cmdExe = process.env.ComSpec || join(process.env.SystemRoot || process.env.windir || 'C:\\\\Windows', 'System32', 'cmd.exe');
    return {
      command: cmdExe,
      args: ['/d', '/s', '/c', buildWindowsCmdLine(resolvedCommand, argValues)],
      options: {
        shell: false,
        windowsVerbatimArguments: true,
      },
    };
  }

  return { command: resolvedCommand, args: argValues, options: { shell: false } };
}

function resolveWindowsCliCommand(commandText) {
  const trimmed = String(commandText || '').trim();
  if (!trimmed) {
    return '';
  }

  if (trimmed.includes(String.fromCharCode(92)) || trimmed.includes('/')) {
    return findWindowsExecutableCandidate(isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed));
  }

  const pathDirs = String(process.env.PATH || process.env.Path || '')
    .split(';')
    .map((item) => item.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of [cwd, ...pathDirs]) {
    const candidate = findWindowsExecutableCandidate(join(dir, trimmed));
    if (candidate) {
      return candidate;
    }
  }
  return '';
}

function findWindowsExecutableCandidate(basePath) {
  const candidates = hasWindowsExecutableExtension(basePath)
    ? [basePath]
    : [...getWindowsPathExts().map((extension) => basePath + extension), basePath];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return '';
}

function getWindowsPathExts() {
  const raw = process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD';
  return raw.split(';')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.startsWith('.'));
}

function hasWindowsExecutableExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return getWindowsPathExts().some((extension) => lower.endsWith(extension));
}

function isWindowsCommandScript(commandPath) {
  const lower = String(commandPath || '').toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

function buildWindowsCmdLine(commandPath, argValues) {
  return '"' + [commandPath, ...argValues].map(quoteWindowsCmdArg).join(' ') + '"';
}

function quoteWindowsCmdArg(value) {
  const slash = String.fromCharCode(92);
  const quote = String.fromCharCode(34);
  const text = String(value ?? '');
  if (text.length === 0) {
    return quote + quote;
  }

  let escaped = '';
  let backslashes = 0;
  for (const char of text) {
    if (char === slash) {
      backslashes += 1;
      continue;
    }
    if (char === quote) {
      escaped += slash.repeat((backslashes * 2) + 1) + quote;
      backslashes = 0;
      continue;
    }
    if (backslashes > 0) {
      escaped += slash.repeat(backslashes);
      backslashes = 0;
    }
    escaped += char === '%' ? '%%' : char;
  }
  if (backslashes > 0) {
    escaped += slash.repeat(backslashes * 2);
  }
  return quote + escaped + quote;
}
function startAttempt(attemptPrompt, subtaskId) {
  const currentAttemptId = ++attemptId;
  currentAttemptStartedAt = Date.now();
  currentAttemptDurationRecorded = false;
  const state = defaultAttemptState;
  resetMainAttemptStateForRetry(state);
  state.attemptId = currentAttemptId;
  state.subtaskId = subtaskId;
  const invocation = buildAttemptInvocation(currentAttemptId);
  if (invocation.retryContinuationError) {
    appendTaskLogEntry(logPhase, 'error', invocation.retryContinuationError);
    finishRun(1, undefined, invocation.retryContinuationError, undefined)
      .catch((finalizeError) => finishRun(1, undefined, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
    return;
  }
  if (invocation.resumeSessionId) {
    appendTaskLogEntry(logPhase, 'info', formatDirectRetryContinuationLog(invocation));
  }
  const child = spawnCli(invocation.command, invocation.args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.child = child;
  state.lastOutputAt = Date.now();
  scheduleAttemptInactivityWatchdog(state);

  child.stdin.end(formatPromptForCli(attemptPrompt));
  child.stdout.on('data', (data) => {
    handleChildOutput('stdout', data, state);
  });
  child.stderr.on('data', (data) => {
    handleChildOutput('stderr', data, state);
  });
  child.on('error', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    finalize(currentAttemptId, 1, undefined, error instanceof Error ? error.message : String(error))
      .catch((finalizeError) => finishRun(1, undefined, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
  });
  child.on('close', (code, signal) => {
    if (state.finalizing && isDirectMainAttempt(state)) {
      return;
    }
    if (signal) {
      console.error(\`Autocode CLI exited by signal: \${signal}\`);
      finalize(currentAttemptId, 1, signal, \`Autocode CLI exited by signal: \${signal}\`)
        .catch((finalizeError) => finishRun(1, signal, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
      return;
    }
    finalize(currentAttemptId, code ?? 0, undefined)
      .catch((finalizeError) => finishRun(1, undefined, finalizeError instanceof Error ? finalizeError.message : String(finalizeError), undefined));
  });
}

function resetMainAttemptStateForRetry(state) {
  clearAttemptTimers(state);
  state.child = null;
  state.lastCliMessageText = '';
  state.pendingModelOutput = '';
  state.completionSummaryDetected = false;
  state.cliJsonLineBuffer = '';
  state.recentErrorLines = [];
  state.toolCallCount = 0;
  state.finalizing = false;
  if (state.modelOutputFlushTimer) {
    clearTimeout(state.modelOutputFlushTimer);
    state.modelOutputFlushTimer = null;
  }
}

function buildAttemptInvocation(currentAttemptId) {
  const directRetryInvocation = buildDirectRetryInvocation(currentAttemptId);
  if (directRetryInvocation) {
    return directRetryInvocation;
  }
  const retryContinuationError = getDirectCliRetryContinuationBlocker(currentAttemptId);
  if (retryContinuationError) {
    return { command, args, resumeSessionId: '', resumeKind: '', retryContinuationError };
  }
  return { command, args, resumeSessionId: '', resumeKind: '' };
}

function buildDirectRetryInvocation(currentAttemptId) {
  if (!isDirectCliRetryAttempt(currentAttemptId)) {
    return null;
  }

  for (const strategy of getDirectCliContinuationStrategies()) {
    const invocation = buildDirectCliContinuationInvocation(strategy);
    if (invocation) {
      return invocation;
    }
  }

  return null;
}

function isDirectCliRetryAttempt(currentAttemptId) {
  return phase === 'direct' && currentAttemptId > 1;
}

function getDirectCliContinuationStrategies() {
  if (!directCliContinuationStrategy || typeof directCliContinuationStrategy !== 'object') {
    return [];
  }
  const resumeSessionId = resolveDirectCliContinuationSessionId(directCliContinuationStrategy);
  return [{
    ...directCliContinuationStrategy,
    cli,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  }];
}

function resolveDirectCliContinuationSessionId(strategy) {
  if (strategy.sessionIdSource === 'json-event-session') {
    return activeCliJsonSessionId;
  }
  if (strategy.sessionIdSource === 'latest') {
    return 'latest';
  }
  return '';
}

function buildDirectCliContinuationInvocation(strategy) {
  if (!strategy || strategy.cli !== cli || !isCliCommandOneOf(command, strategy.commandNames)) {
    return null;
  }

  if (strategy.type === 'exec-resume-session') {
    const resumeArgs = buildDirectCliExecResumeArgs(strategy);
    return resumeArgs
      ? {
          command,
          args: resumeArgs,
          resumeSessionId: strategy.resumeSessionId,
          resumeKind: strategy.type,
          resumeDisplayName: strategy.displayName,
        }
      : null;
  }

  if (strategy.type === 'append-continuation-flag') {
    const continuationArgs = buildDirectCliFlagContinuationArgs(strategy);
    return continuationArgs
      ? {
          command,
          args: continuationArgs,
          resumeSessionId: strategy.resumeSessionId,
          resumeKind: strategy.type,
          resumeDisplayName: strategy.displayName,
          continuationFlag: strategy.continuationFlag,
        }
      : null;
  }

  if (strategy.type === 'argument-template') {
    const templateArgs = buildDirectCliTemplateContinuationArgs(strategy);
    return templateArgs
      ? {
          command,
          args: templateArgs,
          resumeSessionId: strategy.resumeSessionId,
          resumeKind: strategy.type,
          resumeDisplayName: strategy.displayName,
        }
      : null;
  }

  return null;
}

function buildDirectCliExecResumeArgs(strategy) {
  const execCommand = typeof strategy.execCommand === 'string' && strategy.execCommand.trim()
    ? strategy.execCommand.trim()
    : Array.isArray(args)
      ? args[0]
      : '';
  if (
    !strategy.resumeSessionId ||
    (strategy.requiresJsonMode && !isDirectCliJsonModeForStrategy(strategy)) ||
    !Array.isArray(args) ||
    !execCommand ||
    args[0] !== execCommand
  ) {
    return null;
  }

  const promptStdinArg = typeof strategy.promptStdinArg === 'string' && strategy.promptStdinArg.trim()
    ? strategy.promptStdinArg.trim()
    : '-';
  const passthrough = [];
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === promptStdinArg && index === args.length - 1) {
      continue;
    }
    passthrough.push(arg);
  }
  const requiredArgs = Array.isArray(strategy.requiredArgs)
    ? strategy.requiredArgs
    : strategy.requiresJsonMode
      ? ['--json']
      : [];
  for (const requiredArg of requiredArgs.slice().reverse()) {
    if (requiredArg && !passthrough.includes(requiredArg)) {
      passthrough.unshift(requiredArg);
    }
  }
  const resumeArgs = Array.isArray(strategy.resumeArgs) && strategy.resumeArgs.length > 0
    ? strategy.resumeArgs
    : [execCommand, 'resume'];
  return [...resumeArgs, ...passthrough, strategy.resumeSessionId, promptStdinArg];
}

function isDirectCliJsonModeForStrategy(strategy) {
  if (!cliJsonMode) {
    return false;
  }
  if (!strategy.jsonEventParser) {
    return true;
  }
  return activeCliJsonEventParser && activeCliJsonEventParser.type === strategy.jsonEventParser;
}

function buildDirectCliFlagContinuationArgs(strategy) {
  if (!Array.isArray(args) || !strategy.continuationFlag) {
    return null;
  }
  const existingFlags = Array.isArray(strategy.existingContinuationFlags)
    ? strategy.existingContinuationFlags
    : [strategy.continuationFlag];
  if (existingFlags.some((arg) => args.includes(arg))) {
    return args;
  }
  return [strategy.continuationFlag, ...args];
}

function buildDirectCliTemplateContinuationArgs(strategy) {
  if (!Array.isArray(args) || !Array.isArray(strategy.argsTemplate) || strategy.argsTemplate.length === 0) {
    return null;
  }
  if (strategy.requiresJsonMode && !isDirectCliJsonModeForStrategy(strategy)) {
    return null;
  }
  if (doesDirectCliArgsTemplateRequireSession(strategy.argsTemplate) && !strategy.resumeSessionId) {
    return null;
  }

  const promptStdinArg = typeof strategy.promptStdinArg === 'string' && strategy.promptStdinArg.trim()
    ? strategy.promptStdinArg.trim()
    : '-';
  const rendered = [];
  let usedTemplateItem = false;
  for (const item of strategy.argsTemplate) {
    const value = String(item || '').trim();
    if (!value) {
      continue;
    }
    usedTemplateItem = true;
    if (isDirectCliArgsTemplateOriginalArgsToken(value)) {
      rendered.push(...args);
      continue;
    }
    if (isDirectCliArgsTemplatePassthroughArgsToken(value)) {
      rendered.push(...getDirectCliPassthroughArgs(promptStdinArg));
      continue;
    }
    rendered.push(renderDirectCliArgsTemplateValue(value, strategy.resumeSessionId || '', promptStdinArg));
  }
  return usedTemplateItem ? rendered : null;
}

function doesDirectCliArgsTemplateRequireSession(template) {
  return template.some((value) => /\$\{(?:sessionId|session_id)\}|\{(?:sessionId|session_id)\}/.test(String(value || '')));
}

function isDirectCliArgsTemplateOriginalArgsToken(value) {
  return value === '{args}' || value === '\${args}' || value === '{originalArgs}' || value === '\${originalArgs}';
}

function isDirectCliArgsTemplatePassthroughArgsToken(value) {
  return value === '{passthroughArgs}' || value === '\${passthroughArgs}';
}

function getDirectCliPassthroughArgs(promptStdinArg) {
  const passthrough = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === promptStdinArg && index === args.length - 1) {
      continue;
    }
    passthrough.push(arg);
  }
  return passthrough;
}

function renderDirectCliArgsTemplateValue(value, sessionId, promptStdinArg) {
  const replacements = {
    sessionId,
    session_id: sessionId,
    modelId: directCliModelId,
    model: directCliModelId,
    promptStdinArg,
    prompt_stdin_arg: promptStdinArg,
    cli,
    command,
  };
  return value.replace(/\$\{([A-Za-z0-9_]+)\}|\{([A-Za-z0-9_]+)\}/g, (match, shellKey, braceKey) => {
    const key = shellKey || braceKey || '';
    return Object.prototype.hasOwnProperty.call(replacements, key)
      ? String(replacements[key] || '')
      : match;
  });
}

function formatDirectRetryContinuationLog(invocation) {
  const displayName = invocation.resumeDisplayName || 'Direct CLI';
  if (invocation.resumeKind === 'exec-resume-session') {
    return 'Resuming ' + displayName + ' Direct session for retry: ' + invocation.resumeSessionId;
  }
  if (invocation.resumeKind === 'append-continuation-flag') {
    return 'Continuing ' + displayName + ' Direct session for retry with ' + invocation.continuationFlag + '.';
  }
  if (invocation.resumeKind === 'argument-template') {
    return 'Continuing ' + displayName + ' Direct session for retry: ' + (invocation.resumeSessionId || 'configured template') + '.';
  }
  return 'Continuing Direct CLI session for retry.';
}

function getDirectCliRetryContinuationBlocker(currentAttemptId) {
  if (!isDirectCliRetryAttempt(currentAttemptId)) {
    return '';
  }
  const strategies = getDirectCliContinuationStrategies();
  if (strategies.length === 0) {
    return 'Direct CLI retry requires a configured continuation strategy to keep retry attempts in the same model session. Configure directCliContinuationStrategy on the selected CLI runtime route, or use a CLI catalog entry that declares continuationStrategy.';
  }
  for (const strategy of strategies) {
    if (buildDirectCliContinuationInvocation(strategy)) {
      return '';
    }
  }
  return 'Direct CLI retry requires a usable continuation strategy to keep retry attempts in the same model session, but the configured strategy could not build a continuation invocation for this command. Check commandNames, JSON mode/sessionIdSource, argsTemplate/resumeArgs, and the CLI runtime route configuration.';
}

function blockDirectCliRetryWithoutContinuation(currentAttemptId, failureReason) {
  const continuationBlocker = getDirectCliRetryContinuationBlocker(currentAttemptId);
  return continuationBlocker
    ? continuationBlocker + ' Last failure: ' + failureReason
    : '';
}

async function finalize(currentAttemptId, exitCode, signal, explicitError) {
  if (finalized || currentAttemptId !== attemptId) return;
  flushCliJsonOutput(defaultAttemptState);
  flushModelOutput(defaultAttemptState);

  const validationError = exitCode === 0 ? await validateExpectedArtifacts() : undefined;
  if (validationError && validationRetryCount < maxValidationRetries) {
    const retryContinuationBlocker = blockDirectCliRetryWithoutContinuation(currentAttemptId + 1, validationError);
    if (retryContinuationBlocker) {
      finishRun(1, undefined, retryContinuationBlocker, validationError);
      return;
    }
    validationRetryCount += 1;
    const retryMessage = localizeMessage(
      'validationRetry',
      \`Autocode CLI output failed validation: \${validationError} Retrying \${validationRetryCount}/\${maxValidationRetries}...\`,
      { validationError, retry: validationRetryCount, maxRetries: maxValidationRetries },
    );
    appendTaskLogEntry(logPhase, 'info', retryMessage);
    updateTaskLogs(logPhase, 'active', retryMessage);
    updatePlanRunningState();
    emitPhase(executionPhase, retryMessage, 0);
    defaultAttemptState.lastCliMessageText = '';
    defaultAttemptState.completionSummaryDetected = false;
    startAttempt(buildPromptWithMemoryContext(buildArtifactValidationRetryPrompt(validationError)));
    return;
  }

  finishRun(exitCode, signal, explicitError, validationError);
}

function recordDirectAttemptActiveDuration() {
  if (phase !== 'direct' || currentAttemptDurationRecorded) {
    return;
  }
  currentAttemptDurationRecorded = true;
  directActiveDurationMs += Math.max(0, Date.now() - currentAttemptStartedAt);
}
async function finishRun(exitCode, signal, explicitError, validationError) {
  if (finalized) return;
  let failed = exitCode !== 0 || Boolean(explicitError) || Boolean(validationError);
  const failureMessage = failed
    ? explicitError || validationError || summarizeCliFailureReason(defaultAttemptState, exitCode, signal)
    : undefined;
  const rateLimited = failed && isCliRateLimitFailure(defaultAttemptState, explicitError, validationError, failureMessage);
  const resultMessage = failed
    ? rateLimited
      ? summarizeCliRateLimitReason(defaultAttemptState, explicitError, validationError, failureMessage)
      : failureMessage
    : localizeMessage('completed', 'Autocode CLI run completed.');
  const now = new Date().toISOString();
  const result = {
    phase,
    command,
    args,
    exitCode,
    signal,
    status: rateLimited ? 'rate_limited' : failed ? 'error' : 'success',
    message: resultMessage,
    updatedAt: now,
  };

  const directChangedFiles = phase === 'direct'
    ? collectRunnerFilesChangedSinceBaseline(directChangedFileBaseline)
    : [];
  let directQuality = undefined;
  if (phase === 'direct') {
    recordDirectAttemptActiveDuration();
    directQuality = await evaluateDirectCliQuality(result, now, directChangedFiles, currentAttemptStartedAt, directActiveDurationMs);
    result.quality = directQuality;
    const retryableFailureReason = failed
      ? getDirectCliRetryableFailureReason(result, rateLimited, validationError)
      : '';
    if (retryableFailureReason && directRetryCount < maxDirectRetries) {
      const failureSignature = getDirectQualityFailureSignature(retryableFailureReason, directQuality);
      const repeatedFailure = Boolean(failureSignature && directFailureSignatures.includes(failureSignature));
      if (failureSignature) {
        directFailureSignatures.push(failureSignature);
      }
      const nextDirectAttempt = directRetryCount + 2;
      const retryContinuationBlocker = blockDirectCliRetryWithoutContinuation(nextDirectAttempt, retryableFailureReason);
      if (retryContinuationBlocker) {
        result.exitCode = 1;
        result.status = 'error';
        result.message = retryContinuationBlocker;
      } else {
        directRetryCount += 1;
        const maxDirectAttempts = maxDirectRetries + 1;
        const retryMessage = 'Direct CLI attempt failed before completion: ' + retryableFailureReason + ' Retrying attempt ' + nextDirectAttempt + '/' + maxDirectAttempts + '...';
        appendTaskLogEntry(logPhase, 'info', retryMessage);
        updateTaskLogs(logPhase, 'active', retryMessage);
        updatePlanRunningState();
        emitPhase(executionPhase, retryMessage, 0);
        startAttempt(buildPromptWithMemoryContext(buildDirectQualityRetryPrompt({
          failedAttempt: true,
          failureReason: retryableFailureReason,
          quality: directQuality,
          changedFiles: directChangedFiles,
          attempt: directRetryCount,
          maxRetries: maxDirectRetries,
          finalText: readDirectCompletionSummary(result, currentAttemptStartedAt),
          attemptTranscript: defaultAttemptState.lastCliMessageText || result.message,
          repeatedFailure,
        })));
        return;
      }
    }
    if (!failed) {
      const qualityFailureReason = await getDirectCliQualityGateFailureReason(directQuality);
      if (qualityFailureReason) {
        const failureSignature = getDirectQualityFailureSignature(qualityFailureReason, directQuality);
        const repeatedFailure = Boolean(failureSignature && directFailureSignatures.includes(failureSignature));
        if (failureSignature) {
          directFailureSignatures.push(failureSignature);
        }
        if (directRetryCount < maxDirectRetries) {
          const nextDirectAttempt = directRetryCount + 2;
          const retryContinuationBlocker = blockDirectCliRetryWithoutContinuation(nextDirectAttempt, qualityFailureReason);
          if (retryContinuationBlocker) {
            failed = true;
            result.exitCode = 1;
            result.status = 'error';
            result.message = retryContinuationBlocker;
          } else {
            directRetryCount += 1;
            const maxDirectAttempts = maxDirectRetries + 1;
            const retryMessage = 'Direct CLI output failed validation/quality gate: ' + qualityFailureReason + ' Retrying attempt ' + nextDirectAttempt + '/' + maxDirectAttempts + '...';
            appendTaskLogEntry(logPhase, 'info', retryMessage);
            updateTaskLogs(logPhase, 'active', retryMessage);
            updatePlanRunningState();
            emitPhase(executionPhase, retryMessage, 0);
            startAttempt(buildPromptWithMemoryContext(buildDirectQualityRetryPrompt({
              failureReason: qualityFailureReason,
              quality: directQuality,
              changedFiles: directChangedFiles,
              attempt: directRetryCount,
              maxRetries: maxDirectRetries,
              finalText: readDirectCompletionSummary(result, currentAttemptStartedAt),
              attemptTranscript: defaultAttemptState.lastCliMessageText,
              repeatedFailure,
            })));
            return;
          }
        }
        if (!failed) {
          failed = true;
          result.exitCode = 1;
          result.status = 'error';
          result.message = qualityFailureReason;
        }
      }
    }
  }

  finalized = true;
  result.attemptCount = phase === 'direct' ? directRetryCount + 1 : attemptId;

  if (phase === 'direct' || (!failed && phase === 'coding')) {
    const finalText = defaultAttemptState.lastCliMessageText || result.message;
    const memoryNotes = extractCliMemoryNotes(finalText);
    recordCliWorkItemMemory({
      id: phase === 'direct' ? 'direct-implementation' : 'task-execution',
      title: taskTitle,
      details: [taskDescription],
      filesToModify: [],
      filesToCreate: [],
      patternFiles: [],
      upstreamTaskIds: [],
    }, rateLimited ? 'rate_limited' : failed ? 'failure' : 'success', result.message, memoryNotes);
  }

  persistDirectSessionState(result, now, directQuality, directChangedFiles);
  writeJson(join(specDir, artifacts.runResult), result);
  updatePlanStatus(failed, result.message, now, directQuality, result);
  if (phase === 'direct' && !failed) {
    emitTaskEvent('DIRECT_COMPLETED', {
      outcome: 'completed',
      filesChanged: directChangedFiles.length,
      changedFiles: directChangedFiles,
      quality: directQuality || { runner: getDirectCliProviderName() },
    });
  } else if (phase === 'direct' && failed) {
    emitTaskEvent('CODING_FAILED', {
      subtaskId: getDirectCliCurrentSubtaskId(readCurrentPlanDirectExecution(), readCurrentPlanContent()),
      error: result.message || 'Direct CLI run failed.',
      attemptCount: directRetryCount + 1,
    });
  }
  updateTaskLogs(logPhase, failed ? 'failed' : 'completed', result.message);
  await flushCliMemoryWrites();
  emitPhase(failed ? 'failed' : phase === 'coding' || phase === 'direct' ? 'complete' : executionPhase, result.message, failed ? 0 : 100);
  process.exit(failed ? 1 : 0);
}
function createAttemptState(label, subtaskId) {
  return {
    label,
    subtaskId,
    attemptId: 0,
    child: null,
    lastOutputAt: Date.now(),
    pendingModelOutput: '',
    modelOutputFlushTimer: null,
    inactivityTimer: null,
    inactivityWarningLogged: false,
    completionGraceTimer: null,
    completionSummaryDetected: false,
    cliJsonLineBuffer: '',
    lastCliMessageText: '',
    recentErrorLines: [],
    toolCallCount: 0,
    finalizing: false,
  };
}

function isCodingWorkerAttempt(state) {
  return Boolean(state?.subtaskId && activeCodingAttempts.has(state.attemptId));
}

function isDirectMainAttempt(state) {
  return Boolean(phase === 'direct' && state === defaultAttemptState && state?.attemptId === attemptId && attemptId > 0);
}

function shouldAttachAttemptSubtaskId(state) {
  return Boolean(
    state?.subtaskId &&
    phase === 'coding' &&
    runtimeConcurrency.mode === 'concurrent' &&
    codingWorkerLimit > 1
  );
}

function buildAttemptLogExtra(state, extra) {
  return {
    ...(extra || {}),
    ...(shouldAttachAttemptSubtaskId(state) ? { subtask_id: state.subtaskId } : {}),
  };
}

function refreshAttemptActivity(state) {
  if (!state) {
    return;
  }
  state.lastOutputAt = Date.now();
  state.inactivityWarningLogged = false;
  if (state.completionGraceTimer && !state.completionSummaryDetected) {
    clearAttemptCompletionGrace(state);
  }
  scheduleAttemptInactivityWatchdog(state);
}

function scheduleAttemptInactivityWatchdog(state) {
  const policy = getAttemptInactivityPolicy(state);
  if (!policy || policy.timeoutMs <= 0) {
    return;
  }
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
  }
  const initialDelay = getNextAttemptInactivityDelay(state, policy);
  state.inactivityTimer = setTimeout(() => {
    if (!isAttemptInactivityPolicyStillActive(state, policy) || state.finalizing) {
      return;
    }
    const idleMs = Date.now() - (state.lastOutputAt || 0);
    if (
      policy.warningMs > 0 &&
      !state.inactivityWarningLogged &&
      idleMs >= policy.warningMs &&
      idleMs < policy.timeoutMs
    ) {
      state.inactivityWarningLogged = true;
      const message = policy.label + ' produced no output for ' + formatDuration(policy.warningMs) +
        '; still waiting before timeout at ' + formatDuration(policy.timeoutMs) + '.';
      appendTaskLogEntry(policy.logPhase, 'info', message, undefined, buildAttemptLogExtra(state));
      scheduleAttemptInactivityWatchdog(state);
      return;
    }
    if (idleMs < policy.timeoutMs) {
      scheduleAttemptInactivityWatchdog(state);
      return;
    }
    const message = policy.label + ' produced no output for ' + formatDuration(policy.timeoutMs) + '; marking it failed.';
    appendTaskLogEntry(policy.logPhase, 'error', message, undefined, buildAttemptLogExtra(state));
    if (policy.kind === 'direct-main') {
      state.finalizing = true;
    }
    terminateAttemptChild(state, 'inactivity timeout');
    if (policy.kind === 'coding-worker') {
      finalizeCodingAttempt(state.attemptId, 1, undefined, message);
      return;
    }
    finalize(state.attemptId, 1, undefined, message)
      .catch((finalizeError) => finishRun(
        1,
        undefined,
        finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
        undefined,
      ));
  }, initialDelay);
}

function getAttemptInactivityPolicy(state) {
  if (isCodingWorkerAttempt(state)) {
    return {
      kind: 'coding-worker',
      label: 'Coding worker ' + state.label + ' for ' + state.subtaskId,
      logPhase: 'coding',
      warningMs: CODING_WORKER_INACTIVITY_WARNING_MS,
      timeoutMs: CODING_WORKER_INACTIVITY_TIMEOUT_MS,
    };
  }
  if (isDirectMainAttempt(state)) {
    return {
      kind: 'direct-main',
      label: getDirectCliProviderDisplayLabel() + ' Direct attempt',
      logPhase,
      warningMs: DIRECT_ATTEMPT_INACTIVITY_WARNING_MS,
      timeoutMs: DIRECT_ATTEMPT_INACTIVITY_TIMEOUT_MS,
    };
  }
  return null;
}

function isAttemptInactivityPolicyStillActive(state, policy) {
  return policy.kind === 'coding-worker' ? isCodingWorkerAttempt(state) : isDirectMainAttempt(state);
}

function getNextAttemptInactivityDelay(state, policy) {
  const idleMs = Math.max(0, Date.now() - (state.lastOutputAt || Date.now()));
  const delays = [];
  if (
    policy.warningMs > 0 &&
    !state.inactivityWarningLogged &&
    idleMs < policy.warningMs
  ) {
    delays.push(policy.warningMs - idleMs);
  }
  if (idleMs < policy.timeoutMs) {
    delays.push(policy.timeoutMs - idleMs);
  }
  const delay = Math.min(...delays.filter((value) => Number.isFinite(value) && value > 0));
  return Number.isFinite(delay) ? Math.max(1, delay) : 1;
}

function scheduleAttemptCompletionGrace(state, options = {}) {
  const explicitCompletionEvent = options.explicitCompletionEvent === true;
  const canFinalizeCodingWorker = isCodingWorkerAttempt(state) && Boolean(state.lastCliMessageText);
  const canFinalizeDirectMain = isDirectMainAttempt(state) && (explicitCompletionEvent || Boolean(state.lastCliMessageText));
  if (
    (!canFinalizeCodingWorker && !canFinalizeDirectMain) ||
    state.completionGraceTimer ||
    state.finalizing
  ) {
    return;
  }
  const completionGraceMs = canFinalizeDirectMain
    ? DIRECT_ATTEMPT_COMPLETION_GRACE_MS
    : CODING_WORKER_COMPLETION_GRACE_MS;
  state.completionGraceTimer = setTimeout(() => {
    if (state.finalizing) {
      return;
    }
    if (isCodingWorkerAttempt(state)) {
      const message = 'Coding worker ' + state.label + ' for ' + state.subtaskId +
        ' finished model output but the CLI process did not exit; finalizing the work item.';
      appendTaskLogEntry('coding', 'info', message, undefined, buildAttemptLogExtra(state));
      terminateAttemptChild(state, 'model completed');
      finalizeCodingAttempt(state.attemptId, 0, undefined);
      return;
    }
    if (isDirectMainAttempt(state)) {
      state.finalizing = true;
      const message = getActiveCliJsonEventParserDisplayName() +
        ' Direct CLI emitted completion event but the process did not exit; finalizing the Direct attempt.';
      appendTaskLogEntry(logPhase, 'info', message, undefined, buildAttemptLogExtra(state));
      terminateAttemptChild(state, 'model completed');
      finalize(state.attemptId, 0, undefined)
        .catch((finalizeError) => finishRun(
          1,
          undefined,
          finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
          undefined,
        ));
    }
  }, completionGraceMs);
}

function maybeScheduleAttemptCompletionFromModelText(state, text) {
  if (!isCodingWorkerAttempt(state) || state.finalizing) {
    return;
  }
  if (!hasWorkItemCompletionSummaryText(text)) {
    return;
  }
  state.completionSummaryDetected = true;
  scheduleAttemptCompletionGrace(state);
}

function hasWorkItemCompletionSummaryText(value) {
  const text = String(value || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  if (!text.trim()) {
    return false;
  }
  return hasCompletionSummaryHeader(text) && hasCompletionSummaryVerification(text);
}

function hasCompletionSummaryHeader(text) {
  return /(?:^|\\n)\\s*\\|\\s*(?:变更|鍙樻洿|Change(?:s)?|What changed)\\s*\\|\\s*(?:验证|楠岃瘉|Verification|Validation|Tests?)\\s*\\|\\s*(?:评审备注|璇勫澶囨敞|Review notes?|Review)\\s*\\|/i.test(text) ||
    /(?:变更|鍙樻洿|Change(?:s)?|What changed)[\\s|]+(?:验证|楠岃瘉|Verification|Validation|Tests?)[\\s|]+(?:评审备注|璇勫澶囨敞|Review notes?|Review)/i.test(text);
}

function hasCompletionSummaryVerification(text) {
  return /(?:通过|閫氳繃|passed|success|succeeded|npm\\s+run|pnpm\\s+|yarn\\s+|pytest|vitest|playwright|test:e2e|build)/i.test(text);
}

function clearAttemptCompletionGrace(state) {
  if (!state?.completionGraceTimer) {
    return;
  }
  clearTimeout(state.completionGraceTimer);
  state.completionGraceTimer = null;
}

function clearAttemptTimers(state) {
  if (!state) {
    return;
  }
  if (state.modelOutputFlushTimer) {
    clearTimeout(state.modelOutputFlushTimer);
    state.modelOutputFlushTimer = null;
  }
  if (state.inactivityTimer) {
    clearTimeout(state.inactivityTimer);
    state.inactivityTimer = null;
  }
  clearAttemptCompletionGrace(state);
}

function terminateAttemptChild(state, reason) {
  const child = state?.child;
  if (!child || child.killed) {
    return;
  }
  try {
    if (process.platform === 'win32' && child.pid) {
      const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      if (result.error) {
        try {
          child.kill();
        } catch {
          // Ignore best-effort cleanup failures.
        }
      }
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    // The process may already have exited.
  }
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds >= 60) {
    return Math.round(seconds / 60) + 'm';
  }
  return seconds + 's';
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function readNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function startCodingWorkQueue() {
  resetInProgressCodingSubtasks();
  const progress = getCodingProgress();
  if (progress.total === 0) {
    finishRun(0, undefined, undefined, undefined);
    return;
  }
  const retryableCount = countRetryableCodingWorkItems();
  if (retryableCount === 0) {
    finishCodingWorkQueue();
    return;
  }

  const workerCount = Math.min(codingWorkerLimit, Math.max(1, retryableCount));
  appendTaskLogEntry('coding', 'info', 'Starting ' + workerCount + ' coding worker(s).');
  fillCodingWorkers();
}

function fillCodingWorkers() {
  if (finalized) return;

  while (activeCodingAttempts.size < codingWorkerLimit) {
    const subtask = findNextRunnableSubtask();
    if (!subtask) {
      break;
    }
    startCodingWorkerAttempt(subtask);
  }

  if (activeCodingAttempts.size === 0) {
    finishCodingWorkQueue();
  }
}

function startCodingWorkerAttempt(subtask) {
  const workerId = ++nextCodingWorkerId;
  const currentAttemptId = ++attemptId;
  const state = createAttemptState('worker-' + workerId, subtask.id);
  state.attemptId = currentAttemptId;
  activeCodingSubtaskIds.add(subtask.id);
  activeCodingAttempts.set(currentAttemptId, { state, subtask, workerId });
  markPlanSubtaskStatus(subtask.id, 'in_progress');
  restoreKnownCodingStatuses(subtask.id);

  const progress = getCodingProgress();
  const workLabel = subtask.workPackage ? 'work package' : 'subtask';
  const message = 'Worker ' + workerId + ' coding ' + workLabel + ' ' + subtask.id + ': ' + subtask.title;
  updateTaskLogs('coding', 'active', message, false);
  appendTaskLogEntry('coding', 'info', message, undefined, buildAttemptLogExtra(state));
  emitPhase('coding', message, progress.percent);

  const child = spawnCli(command, args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  state.child = child;
  state.lastOutputAt = Date.now();
  scheduleAttemptInactivityWatchdog(state);

  child.stdin.end(buildFocusedSubtaskPrompt(subtask));
  child.stdout.on('data', (data) => {
    handleChildOutput('stdout', data, state);
  });
  child.stderr.on('data', (data) => {
    handleChildOutput('stderr', data, state);
  });
  child.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    finalizeCodingAttempt(currentAttemptId, 1, undefined, message);
  });
  child.on('close', (code, signal) => {
    if (signal) {
      const message = 'Autocode CLI exited by signal: ' + signal;
      console.error(message);
      finalizeCodingAttempt(currentAttemptId, 1, signal, message);
      return;
    }
    finalizeCodingAttempt(currentAttemptId, code ?? 0, undefined);
  });
}

function finalizeCodingAttempt(currentAttemptId, exitCode, signal, explicitError) {
  if (finalized) return;
  const attempt = activeCodingAttempts.get(currentAttemptId);
  if (!attempt) return;

  attempt.state.finalizing = true;
  clearAttemptTimers(attempt.state);
  activeCodingAttempts.delete(currentAttemptId);
  activeCodingSubtaskIds.delete(attempt.subtask.id);
  flushCliJsonOutput(attempt.state);
  flushModelOutput(attempt.state);

  if (exitCode !== 0 || explicitError) {
    const reason = explicitError || summarizeCliFailureReason(
      attempt.state,
      exitCode,
      signal,
      'CLI work item run failed.',
    );
    const memoryNotes = extractCliMemoryNotes(attempt.state.lastCliMessageText);
    failedCodingSubtaskIds.add(attempt.subtask.id);
    codingFailures.push(attempt.subtask.id + ': ' + reason);
    appendTaskLogEntry(
      'coding',
      'error',
      'Work item ' + attempt.subtask.id + ' failed: ' + reason,
      undefined,
      buildAttemptLogExtra(attempt.state),
    );
    markPlanSubtaskStatus(attempt.subtask.id, 'failed', reason);
    recordCliWorkItemMemory(attempt.subtask, 'failure', reason, memoryNotes);
  } else {
    const memoryNotes = extractCliMemoryNotes(attempt.state.lastCliMessageText);
    completedCodingSubtaskIds.add(attempt.subtask.id);
    appendTaskLogEntry(
      'coding',
      'success',
      'Work item ' + attempt.subtask.id + ' completed.',
      undefined,
      buildAttemptLogExtra(attempt.state),
    );
    markPlanSubtaskStatus(attempt.subtask.id, 'completed', 'Completed by Autocode CLI runner.');
    recordCliWorkItemMemory(attempt.subtask, 'success', 'Completed by Autocode CLI runner.', memoryNotes);
  }

  restoreKnownCodingStatuses(attempt.subtask.id);
  fillCodingWorkers();
}

function finishCodingWorkQueue() {
  const progress = getCodingProgress();
  const planItems = readPlanItems();
  const incompleteItems = getIncompleteCodingWorkItems(planItems);
  const retryableCount = incompleteItems.filter((item) => isRetryableCodingStatus(item.status)).length;
  const dependencyBlockedItems = getDependencyBlockedPlanItems(planItems);
  if (codingFailures.length > 0 || failedCodingSubtaskIds.size > 0) {
    finishRun(1, undefined, codingFailures.join('; ') || 'One or more coding work items failed.', undefined);
    return;
  }
  if (dependencyBlockedItems.length > 0) {
    for (const item of dependencyBlockedItems) {
      markPlanSubtaskStatus(item.id, 'blocked', formatRunnerDependencyBlocker(item));
    }
    finishRun(
      1,
      undefined,
      'Coding incomplete because dependencies are unresolved: ' + dependencyBlockedItems
        .map((item) => formatRunnerDependencyBlocker(item))
        .join('; '),
      undefined,
    );
    return;
  }
  if (retryableCount > 0 || progress.completed < progress.total) {
    const incompleteSummary = summarizeRunnerPlanItems(incompleteItems);
    finishRun(
      1,
      undefined,
      'Coding incomplete: ' + progress.completed + '/' + progress.total + ' work items completed.' +
        (incompleteSummary ? ' Incomplete work items: ' + incompleteSummary + '.' : ''),
      undefined,
    );
    return;
  }
  finishRun(0, undefined, undefined, undefined);
}

function restoreKnownCodingStatuses(currentSubtaskId) {
  for (const subtaskId of completedCodingSubtaskIds) {
    markPlanSubtaskStatus(subtaskId, 'completed', 'Completed by Autocode CLI runner.');
  }
  for (const subtaskId of failedCodingSubtaskIds) {
    markPlanSubtaskStatus(subtaskId, 'failed', 'CLI work item run failed.');
  }
  for (const subtaskId of activeCodingSubtaskIds) {
    if (subtaskId !== currentSubtaskId && !completedCodingSubtaskIds.has(subtaskId) && !failedCodingSubtaskIds.has(subtaskId)) {
      markPlanSubtaskStatus(subtaskId, 'in_progress');
    }
  }
}

function buildFocusedSubtaskPrompt(subtask) {
  const workLabel = subtask.workPackage ? 'Work Package' : 'Subtask';
  const workflowRules = subtask.workPackage
    ? [
        '- Implement every Autocode source task listed in this work package.',
        '- Do not implement later pending work packages in this invocation.',
        '- Keep other work package checkboxes unchanged.',
        '- Do not edit implementation_plan.md status checkboxes; this runner updates work package ' + subtask.id + ' after the CLI exits.',
        '- Return a concise completion summary for this work package.',
        '- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread the surrounding lines once before retrying.',
        '- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.',
        '- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.',
        '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
        '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless this work package explicitly changes state-machine code.',
      ]
    : [
        '- Implement only this current subtask.',
        '- Do not implement later pending subtasks in this invocation.',
        '- Keep other subtask checkboxes unchanged.',
        '- Do not edit implementation_plan.md status checkboxes; this runner updates subtask ' + subtask.id + ' after the CLI exits.',
        '- Return a concise completion summary for this subtask.',
        '- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread the surrounding lines once before retrying.',
        '- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.',
        '- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.',
        '- On Node 24+, do not mix require(...) with top-level await in node -e, stdin, or eval scripts; use an async IIFE or ESM import with node --input-type=module.',
        '- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless this subtask explicitly changes state-machine code.',
      ];
  const fields = [
    '# Current Work Item',
    '',
    workLabel + ' ID: ' + subtask.id,
    'Phase: ' + (subtask.phaseName || 'Implementation'),
    'Title: ' + subtask.title,
    subtask.dependsOn && subtask.dependsOn.length > 0 ? 'Depends on completed work items: ' + subtask.dependsOn.join(', ') : '',
    subtask.upstreamTaskIds && subtask.upstreamTaskIds.length > 0 ? 'Source task IDs: ' + subtask.upstreamTaskIds.join(', ') : '',
    subtask.upstreamSource ? 'Upstream source: ' + subtask.upstreamSource : '',
    '',
    'Description:',
    subtask.details.length > 0 ? subtask.details.join('\\n') : subtask.title,
    '',
    '## Required Workflow',
    ...workflowRules,
    '- If blocked, leave this work item incomplete and explain the blocker.',
  ].filter(Boolean);
  return [
    buildPromptWithMemoryContext(prompt),
    '',
    '---',
    '',
    ...fields,
  ].join('\\n');
}

function findNextRunnableSubtask() {
  const planItems = readPlanItems();
  const candidates = planItems
    .filter((item) =>
      item.isSubtask &&
      isRetryableCodingStatus(item.status) &&
      !activeCodingSubtaskIds.has(item.id) &&
      !failedCodingSubtaskIds.has(item.id)
    );
  const analysis = analyzeRunnerWorkDependencies(candidates, getPlanItemStatusMap(planItems));
  return analysis.runnable.find((item) => !conflictsWithActiveCodingWork(item)) || null;
}

function countRetryableCodingWorkItems() {
  return readPlanItems().filter((item) => item.isSubtask && isRetryableCodingStatus(item.status)).length;
}

function isRetryableCodingStatus(status) {
  return status === 'pending' || status === 'failed' || status === 'blocked';
}

function getIncompleteCodingWorkItems(items) {
  return items.filter((item) => item.isSubtask && item.status !== 'completed');
}

function summarizeRunnerPlanItems(items) {
  const visible = items.slice(0, 12).map((item) => item.id + ' (' + item.status + ')');
  const remaining = items.length - visible.length;
  if (remaining > 0) {
    visible.push('and ' + remaining + ' more');
  }
  return visible.join(', ');
}

function conflictsWithActiveCodingWork(candidate) {
  const candidateFiles = getWorkItemFiles(candidate);

  const activeItems = readPlanItems()
    .filter((item) => item.isSubtask && activeCodingSubtaskIds.has(item.id));
  for (const active of activeItems) {
    const activeFiles = getWorkItemFiles(active);
    if (candidateFiles.length === 0 || activeFiles.length === 0) {
      continue;
    }
    if (candidateFiles.some((file) => activeFiles.some((activeFile) => workItemPathsOverlap(file, activeFile)))) {
      return true;
    }
  }
  return false;
}

function getPlanItemStatusMap(items) {
  const statusById = new Map();
  for (const item of items || readPlanItems()) {
    if (item.isSubtask) {
      statusById.set(item.id, item.status);
    }
  }
  return statusById;
}

function getDependencyBlockedPlanItems(items) {
  return analyzeRunnerWorkDependencies(
    items.filter((item) => item.isSubtask && isRetryableCodingStatus(item.status)),
    getPlanItemStatusMap(items),
  ).blocked;
}

function formatRunnerDependencyBlocker(item) {
  const cycleIssue = (item.dependencyIssues || []).find((issue) => issue.type === 'cycle');
  if (cycleIssue && cycleIssue.cycle) {
    return item.id + ' blocked by dependency cycle ' + cycleIssue.cycle.join(' -> ');
  }
  const issueMessages = (item.dependencyIssues || [])
    .filter((issue) => issue.type === 'missing' || issue.type === 'self' || issue.type === 'duplicate')
    .map((issue) => issue.message);
  if (issueMessages.length > 0) {
    return item.id + ' blocked: ' + issueMessages.join('; ');
  }
  return item.id + ' waits for ' + (item.unresolvedDependencies || []).join(', ');
}

function analyzeRunnerWorkDependencies(items, statusById) {
  const issues = collectRunnerDependencyIssues(items, statusById);
  const issuesByItemId = new Map();
  for (const issue of issues) {
    const existing = issuesByItemId.get(issue.itemId) || [];
    existing.push(issue);
    issuesByItemId.set(issue.itemId, existing);
  }

  const runnable = [];
  const blocked = [];
  for (const item of items) {
    const unresolvedDependencies = getUnresolvedRunnerWorkDependencies(item, statusById);
    const itemIssues = issuesByItemId.get(item.id) || [];
    if (unresolvedDependencies.length === 0 && itemIssues.length === 0) {
      runnable.push(item);
    } else {
      blocked.push({
        ...item,
        unresolvedDependencies,
        dependencyIssues: itemIssues,
      });
    }
  }
  return { runnable, blocked, issues };
}

function getUnresolvedRunnerWorkDependencies(item, statusById) {
  return normalizeRunnerWorkDependencyIds(item.dependsOn)
    .filter((dependencyId) => dependencyId === item.id || statusById.get(dependencyId) !== 'completed');
}

function collectRunnerDependencyIssues(items, statusById) {
  const issues = [];
  const counts = new Map();
  for (const item of items) {
    if (!item.id) continue;
    counts.set(item.id, (counts.get(item.id) || 0) + 1);
  }
  const duplicateIds = new Set(
    Array.from(counts.entries())
      .filter((entry) => entry[1] > 1)
      .map((entry) => entry[0]),
  );
  for (const itemId of duplicateIds) {
    issues.push({
      type: 'duplicate',
      itemId,
      message: 'Duplicate work item id ' + itemId,
    });
  }
  for (const item of items) {
    for (const dependencyId of normalizeRunnerWorkDependencyIds(item.dependsOn)) {
      if (dependencyId === item.id) {
        issues.push({
          type: 'self',
          itemId: item.id,
          dependencyId,
          message: item.id + ' cannot depend on itself',
        });
      } else if (!statusById.has(dependencyId)) {
        issues.push({
          type: 'missing',
          itemId: item.id,
          dependencyId,
          message: item.id + ' depends on missing work item ' + dependencyId,
        });
      }
    }
  }
  return issues.concat(collectRunnerCycleIssues(items));
}

function collectRunnerCycleIssues(items) {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const visited = new Set();
  const visiting = new Set();
  const stack = [];
  const seenCycleKeys = new Set();
  const issues = [];

  const visit = (itemId) => {
    if (visiting.has(itemId)) {
      const cycleStart = stack.indexOf(itemId);
      if (cycleStart >= 0) {
        const cycle = stack.slice(cycleStart).concat(itemId);
        const key = canonicalRunnerCycleKey(cycle);
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          for (const cycleItemId of cycle.slice(0, -1)) {
            issues.push({
              type: 'cycle',
              itemId: cycleItemId,
              cycle,
              message: 'Dependency cycle detected: ' + cycle.join(' -> '),
            });
          }
        }
      }
      return;
    }
    if (visited.has(itemId)) return;
    const item = itemById.get(itemId);
    if (!item) return;

    visiting.add(itemId);
    stack.push(itemId);
    for (const dependencyId of normalizeRunnerWorkDependencyIds(item.dependsOn)) {
      if (dependencyId !== itemId && itemById.has(dependencyId)) {
        visit(dependencyId);
      }
    }
    stack.pop();
    visiting.delete(itemId);
    visited.add(itemId);
  };

  for (const item of items) {
    visit(item.id);
  }
  return issues;
}

function canonicalRunnerCycleKey(cycle) {
  const body = cycle.slice(0, -1);
  const rotations = body.map((_, index) => body.slice(index).concat(body.slice(0, index)).join('>'));
  return rotations.sort()[0] || body.join('>');
}

function normalizeRunnerWorkDependencyIds(value) {
  if (Array.isArray(value)) return normalizeRunnerStringArray(value);
  if (typeof value === 'string') {
    return [...new Set(value.split(',').map((item) => item.trim()).filter((item) => item && !isNoneDependencyToken(item)))];
  }
  return [];
}

function normalizeRunnerStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map((item) => String(item || '').trim()).filter((item) => item && !isNoneDependencyToken(item)))];
}

function isNoneDependencyToken(value) {
  return /^(none|no dependencies?|n\\/a|na|nil|null|无|无依赖|没有|没有依赖)$/i.test(String(value || '').trim());
}

function getWorkItemFiles(item) {
  return [...new Set([
    ...(item.filesToModify || []),
    ...(item.filesToCreate || []),
    ...(item.patternFiles || []),
  ].map(normalizeWorkItemFileIntent).filter(Boolean))];
}

function normalizeWorkItemFileIntent(file) {
  const normalized = String(file || '').trim().replace(/\\\\/g, '/').replace(/\\/+/g, '/').toLowerCase();
  if (!normalized || normalized === '.') {
    return '';
  }

  const wildcardIndex = normalized.search(/[*?[{]/);
  const stablePrefix = wildcardIndex >= 0 ? normalized.slice(0, wildcardIndex) : normalized;
  const pathLike = stablePrefix.replace(/\\/+$/g, '');
  if (!pathLike || pathLike === '.') {
    return '';
  }

  const parts = [];
  for (const part of pathLike.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function workItemPathsOverlap(leftPath, rightPath) {
  return leftPath === rightPath ||
    leftPath.startsWith(rightPath + '/') ||
    rightPath.startsWith(leftPath + '/');
}

function resetInProgressCodingSubtasks() {
  for (const item of readPlanItems()) {
    if (item.isSubtask && item.status === 'in_progress') {
      markPlanSubtaskStatus(item.id, 'pending');
    }
  }
}

function getCodingProgress() {
  const subtasks = readPlanItems().filter((item) => item.isSubtask);
  const total = subtasks.length;
  const completed = subtasks.filter((item) => item.status === 'completed').length;
  return {
    total,
    completed,
    percent: total > 0 ? Math.round((completed / total) * 100) : 100,
  };
}

function readPlanItems() {
  let content = '';
  try {
    content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
  } catch {
    return [];
  }
  const planMetadata = parsePlanMachineMetadata(content);
  const subtaskMetadata = planMetadata && planMetadata.subtaskMetadata && typeof planMetadata.subtaskMetadata === 'object'
    ? planMetadata.subtaskMetadata
    : {};
  const lines = content.replace(/\\r\\n/g, '\\n').split('\\n');
  const items = [];
  let currentPhaseName = '';
  let current = null;
  for (const line of lines) {
    const match = /^(\\s*)-\\s+\\[([ xX/!\\-])\\]\\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\\.)?\\s+(.+?)\\s*$/.exec(line);
    if (match) {
      const metadata = subtaskMetadata[match[3]] && typeof subtaskMetadata[match[3]] === 'object'
        ? subtaskMetadata[match[3]]
        : {};
      const hasMetadataField = (field) => Object.prototype.hasOwnProperty.call(metadata, field);
      current = {
        indent: match[1].length,
        marker: match[2],
        id: match[3],
        title: match[4].trim(),
        status: markerToStatus(match[2]),
        details: [],
        filesToCreate: normalizeRunnerStringArray(metadata.files_to_create),
        filesToModify: [
          ...normalizeRunnerStringArray(metadata.files),
          ...normalizeRunnerStringArray(metadata.files_to_modify),
        ],
        patternFiles: normalizeRunnerStringArray(metadata.pattern_files),
        dependsOn: normalizeRunnerWorkDependencyIds(metadata.depends_on),
        requirements: normalizeRunnerStringArray(metadata.requirements),
        evidence: typeof metadata.evidence === 'string' ? metadata.evidence.trim() : '',
        hasFileMetadata: hasMetadataField('files') ||
          hasMetadataField('files_to_create') ||
          hasMetadataField('files_to_modify') ||
          hasMetadataField('pattern_files'),
        hasDependencyMetadata: hasMetadataField('depends_on'),
        hasEvidenceMetadata: hasMetadataField('evidence') &&
          isMeaningfulRunnerEvidence(metadata.evidence),
        hasVerificationMetadata: hasMetadataField('verification'),
        phaseName: currentPhaseName,
        isSubtask: match[1].length > 0 || /[.-]/.test(match[3]),
        workPackage: metadata.work_package === true,
        upstreamTaskIds: Array.isArray(metadata.upstream_task_ids)
          ? metadata.upstream_task_ids.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
          : [],
        upstreamSource: typeof metadata.upstream_source === 'string' ? metadata.upstream_source : '',
      };
      if (!current.isSubtask) {
        currentPhaseName = current.title;
        current.phaseName = current.title;
      }
      items.push(current);
      continue;
    }
    if (current && /^\\s+-\\s+/.test(line)) {
      const detail = line.replace(/^\\s+-\\s+/, '').trim();
      if (detail) {
        current.details.push(detail);
        applyPlanItemFileHint(current, detail);
      }
    }
  }
  return items;
}

function applyPlanItemFileHint(item, detail) {
  const clean = detail.replace(/^_+|_+$/g, '').trim();
  const match = /^([^:]+):\\s*(.*?)\\s*$/.exec(clean);
  if (!match) {
    return;
  }
  const key = match[1].trim().toLowerCase();
  const values = splitPlanList(match[2]);
  if (key === 'files to create') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.filesToCreate.push(...values);
    return;
  }
  if (key === 'files' || key === 'files to modify') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.filesToModify.push(...values);
    return;
  }
  if (key === 'pattern files' || key === 'patterns from') {
    item.hasFileMetadata = true;
    if (values.length === 0) return;
    item.patternFiles.push(...values);
    return;
  }
  if (key === 'depends on') {
    item.hasDependencyMetadata = true;
    if (values.length === 0) return;
    item.dependsOn.push(...values);
    return;
  }
  if (key === 'evidence' || key === 'source evidence' || key === 'evidence sources') {
    item.hasEvidenceMetadata = isMeaningfulRunnerEvidence(match[2]);
    item.evidence = String(match[2] || '').trim();
    return;
  }
  if (key === 'verification') {
    item.hasVerificationMetadata = true;
  }
}

function isMeaningfulRunnerEvidence(value) {
  const text = String(value || '').trim().toLowerCase();
  return text.length >= 6 && !EMPTY_EVIDENCE_TOKENS.has(text);
}

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

function splitPlanList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !isNoneDependencyToken(item));
}

function parsePlanMachineMetadata(content) {
  const match = /^<!--\\s*autocode-plan-meta:\\s*(\\{.*\\})\\s*-->\\s*$/m.exec(content);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function markerToStatus(marker) {
  if (marker === 'x' || marker === 'X') return 'completed';
  if (marker === '/') return 'in_progress';
  if (marker === '!') return 'failed';
  if (marker === '-') return 'blocked';
  return 'pending';
}

function statusToMarker(status) {
  if (status === 'completed') return 'x';
  if (status === 'in_progress') return '/';
  if (status === 'failed') return '!';
  if (status === 'blocked') return '-';
  return ' ';
}

function markPlanSubtaskStatus(subtaskId, status, note, durationMs) {
  const planPath = join(specDir, artifacts.implementationPlan);
  return withFileWriteLock(planPath, 'runner:plan-subtask:' + subtaskId, () => {
    let content = '';
    try {
      content = readFileSync(planPath, 'utf8');
    } catch {
      return false;
    }

    const marker = statusToMarker(status);
    const now = new Date().toISOString();
    const lines = content.replace(/\\r\\n/g, '\\n').split('\\n');
    let updated = false;
    let matchedSubtask = false;
    let completionValue = null;
    let noteValue = status !== 'completed' && note ? compactPlanField(note) : null;
    let startedValue = null;
    let completedValue = null;
    for (let index = 0; index < lines.length; index += 1) {
      const pattern = /^(\\s*-\\s+\\[)([ xX/!\\-])(\\]\\s+)([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(\\.?)(\\s+.+?)\\s*$/;
      const match = pattern.exec(lines[index]);
      if (!match || match[4] !== subtaskId) {
        continue;
      }
      matchedSubtask = true;

      if (match[2] !== marker) {
        lines[index] = match[1] + marker + match[3] + match[4] + match[5] + match[6];
        updated = true;
      }
      const detailIndent = (match[1].match(/^\\s*/) || [''])[0] + '  ';
      let insertAt = index + 1;
      let hasCompletion = false;
      let hasStarted = false;
      let hasCompleted = false;
      let hasUpdated = false;
      while (insertAt < lines.length) {
        if (/^\\s*-\\s+\\[[ xX/!\\-]\\]\\s+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*/.test(lines[insertAt])) {
          break;
        }
        if (/^\\s*-\\s+_Completion:/i.test(lines[insertAt])) {
          hasCompletion = true;
          completionValue = extractPlanInlineFieldValue(lines[insertAt], 'Completion');
          if (status !== 'completed') {
            lines.splice(insertAt, 1);
            updated = true;
            completionValue = null;
            continue;
          }
        }
        if (/^\\s*-\\s+_Started:/i.test(lines[insertAt])) {
          hasStarted = true;
          startedValue = extractPlanInlineFieldValue(lines[insertAt], 'Started');
          if (status === 'pending') {
            lines.splice(insertAt, 1);
            updated = true;
            startedValue = null;
            continue;
          }
        }
        if (/^\\s*-\\s+_Completed:/i.test(lines[insertAt])) {
          hasCompleted = true;
          completedValue = extractPlanInlineFieldValue(lines[insertAt], 'Completed');
          if (status !== 'completed') {
            lines.splice(insertAt, 1);
            updated = true;
            completedValue = null;
            continue;
          }
        }
        if (/^\\s*-\\s+_Updated:/i.test(lines[insertAt])) hasUpdated = true;
        insertAt += 1;
      }
      if (status === 'completed' && note && !hasCompletion) {
        completionValue = compactPlanField(note);
        lines.splice(insertAt, 0, detailIndent + '- _Completion: ' + completionValue + '_');
        insertAt += 1;
        updated = true;
      }
      if (status !== 'pending' && !hasStarted) {
        startedValue = now;
        lines.splice(insertAt, 0, detailIndent + '- _Started: ' + now + '_');
        insertAt += 1;
        updated = true;
      }
      if (status === 'completed' && !hasCompleted) {
        completedValue = now;
        lines.splice(insertAt, 0, detailIndent + '- _Completed: ' + now + '_');
        insertAt += 1;
        updated = true;
      }
      if (updated && !hasUpdated) {
        lines.splice(insertAt, 0, detailIndent + '- _Updated: ' + now + '_');
      }
      break;
    }

    if (!matchedSubtask) {
      return false;
    }

    content = lines.join('\\n');
    const contentWithSubtaskMetadata = upsertPlanSubtaskMachineMetadata(content, subtaskId, buildSubtaskStatusMetadataUpdates(status, {
      completionValue,
      noteValue,
      startedValue,
      completedValue,
      durationMs,
    }));
    if (contentWithSubtaskMetadata !== content) {
      content = contentWithSubtaskMetadata;
      updated = true;
    }

    if (!updated) {
      return false;
    }
    content = upsertPlanMetadata(content, 'Updated', now);
    writeFileSync(planPath, content.endsWith('\\n') ? content : content + '\\n', 'utf8');
    return true;
  });
}

function extractPlanInlineFieldValue(line, fieldName) {
  const match = new RegExp('^\\\\s*-\\\\s+_' + fieldName + ':\\\\s*(.*?)_\\\\s*$', 'i').exec(line);
  return match ? match[1].trim() : '';
}

function buildSubtaskStatusMetadataUpdates(status, values) {
  if (status === 'pending') {
    return {
      completion_summary: null,
      notes: null,
      completed_at: null,
      started_at: null,
      duration_ms: null,
    };
  }

  const updates = {
    started_at: values.startedValue || null,
  };
  const durationMs = Number.isFinite(values.durationMs)
    ? Math.max(0, Math.floor(values.durationMs))
    : undefined;

  if (status === 'in_progress') {
    updates.completed_at = null;
    updates.duration_ms = null;
  } else if (status === 'completed') {
    updates.completed_at = values.completedValue || null;
    if (durationMs !== undefined) {
      updates.duration_ms = durationMs;
    }
  } else if (status === 'failed' || status === 'blocked') {
    updates.completed_at = null;
    if (durationMs !== undefined) {
      updates.duration_ms = durationMs;
    }
  }

  if (status === 'completed' && values.completionValue) {
    updates.completion_summary = values.completionValue;
    updates.notes = values.completionValue;
  } else if (status !== 'completed') {
    updates.completion_summary = null;
    updates.notes = values.noteValue || null;
  }

  return updates;
}

function upsertPlanSubtaskMachineMetadata(content, subtaskId, updates) {
  const existingMetadata = parsePlanMachineMetadata(content);
  const existingSubtaskMetadata = existingMetadata &&
    existingMetadata.subtaskMetadata &&
    typeof existingMetadata.subtaskMetadata === 'object' &&
    !Array.isArray(existingMetadata.subtaskMetadata)
    ? existingMetadata.subtaskMetadata
    : {};
  const subtaskMetadata = { ...existingSubtaskMetadata };
  const existingFields = subtaskMetadata[subtaskId] &&
    typeof subtaskMetadata[subtaskId] === 'object' &&
    !Array.isArray(subtaskMetadata[subtaskId])
    ? subtaskMetadata[subtaskId]
    : {};
  const nextFields = { ...existingFields };

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') {
      delete nextFields[key];
    } else {
      nextFields[key] = value;
    }
  }

  if (Object.keys(nextFields).length === 0) {
    delete subtaskMetadata[subtaskId];
  } else {
    subtaskMetadata[subtaskId] = nextFields;
  }

  return upsertPlanMachineMetadata(content, {
    subtaskMetadata: Object.keys(subtaskMetadata).length > 0 ? subtaskMetadata : null,
  });
}

function compactPlanField(value) {
  return cleanLogText(value).replace(/\\s+/g, ' ').replace(/_/g, '\\\\_').trim().slice(0, 500);
}

function inferFileWriteLockScope() {
  const specsDir = dirname(specDir);
  if (basename(specsDir).toLowerCase() === 'specs') {
    const dataDir = dirname(specsDir);
    return {
      projectRoot: dirname(dataDir),
      dataDirName: basename(dataDir),
    };
  }
  return {
    projectRoot: cwd,
    dataDirName: '.autocode',
  };
}

function withFileWriteLock(filePath, ownerId, callback) {
  const lock = acquireFileWriteLock(filePath, ownerId);
  try {
    return callback();
  } finally {
    releaseFileWriteLock(lock);
  }
}

function acquireFileWriteLock(filePath, ownerId) {
  const normalizedFilePath = normalizeLockPath(filePath);
  const lockRoot = join(fileWriteLockScope.projectRoot, fileWriteLockScope.dataDirName, '.locks', 'runtime-file-writes');
  const lockDir = join(lockRoot, createHash('sha256').update(normalizedFilePath).digest('hex').slice(0, 32) + '.lock');
  const metadataPath = join(lockDir, 'metadata.json');
  const token = randomUUID();
  const deadline = Date.now() + 120000;
  mkdirSync(lockRoot, { recursive: true });

  while (true) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(metadataPath, JSON.stringify({
          filePath: normalizedFilePath,
          ownerId: ownerId || 'autocode-runner',
          token,
          acquiredAt: new Date().toISOString(),
          processId: process.pid,
        }, null, 2), 'utf8');
      } catch (metadataError) {
        rmSync(lockDir, { recursive: true, force: true });
        throw metadataError;
      }
      activeFileWriteLockDirs.add(lockDir);
      return { lockDir, metadataPath, token };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') {
        throw error;
      }
      if (isFileWriteLockHeldByThisProcess(lockDir)) {
        throw new Error('Write lock on ' + normalizedFilePath + ' is already held by this process. Avoid nested writes to the same file.');
      }
      if (isFileWriteLockStale(lockDir)) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for write lock on ' + normalizedFilePath + '.');
      }
      waitForFileWriteLock(100);
    }
  }
}

function releaseFileWriteLock(lock) {
  try {
    const metadata = readFileWriteLockMetadata(lock.lockDir);
    if (metadata && metadata.token && metadata.token !== lock.token) {
      return;
    }
    rmSync(lock.lockDir, { recursive: true, force: true });
  } finally {
    activeFileWriteLockDirs.delete(lock.lockDir);
  }
}

function readFileWriteLockMetadata(lockDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(lockDir, 'metadata.json'), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isFileWriteLockHeldByThisProcess(lockDir) {
  if (activeFileWriteLockDirs.has(lockDir)) {
    return true;
  }
  const metadata = readFileWriteLockMetadata(lockDir);
  return metadata && metadata.processId === process.pid;
}

function isFileWriteLockStale(lockDir) {
  try {
    return Date.now() - statSync(lockDir).mtimeMs > 600000;
  } catch {
    return false;
  }
}

function normalizeLockPath(filePath) {
  return resolve(filePath).replace(/\\\\/g, '/').replace(/\\/+$|^\\s+|\\s+$/g, '').toLowerCase();
}

function waitForFileWriteLock(delayMs) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, delayMs);
}

function handleChildOutput(stream, data, state = defaultAttemptState) {
  const text = decodeCliOutputChunk(data);
  if (!text) return;
  refreshAttemptActivity(state);
  captureCliFailureSignals(text, state);
  if (cliJsonMode && stream === 'stdout') {
    processCliJsonOutput(text, state);
    return;
  }
  if (stream === 'stderr') {
    process.stderr.write(text);
  } else {
    process.stdout.write(text);
  }
  queueModelOutput(text, state);
}

function captureCliFailureSignals(text, state = defaultAttemptState) {
  if (!state || !Array.isArray(state.recentErrorLines)) {
    return;
  }
  const lines = String(text ?? '')
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .split('\\n')
    .map((line) => normalizeCliFailureSignalLine(line))
    .filter(Boolean)
    .filter((line) => isCliFailureSignalLine(line));
  for (const line of lines) {
    rememberCliFailureSignalLine(state, line);
  }
}

function normalizeCliFailureSignalLine(line) {
  return cleanLogText(line)
    .replace(/^\\d{4}-\\d{2}-\\d{2}T[^\\s]+\\s+/, '')
    .replace(/^\\s*(?:ERROR|WARN|INFO|DEBUG)\\s+/i, '')
    .replace(/\\s+/g, ' ')
    .trim();
}

function isCliFailureSignalLine(line) {
  if (!line || isNoisyCliDiagnosticLine(line)) {
    return false;
  }
  return isCliRateLimitSignalLine(line) || CLI_FAILURE_SIGNAL_PATTERNS.some((pattern) => pattern.test(line));
}

function isCliRateLimitSignalLine(line) {
  if (!line) {
    return false;
  }
  return CLI_RATE_LIMIT_SIGNAL_PATTERNS.some((pattern) => pattern.test(line));
}

function rememberCliFailureSignalLine(state, line) {
  const clipped = limitLogText(line, 500);
  if (!clipped) {
    return;
  }
  const current = state.recentErrorLines;
  if (current[current.length - 1] !== clipped) {
    current.push(clipped);
  }
  while (current.length > 12) {
    current.shift();
  }
}

function summarizeCliFailureReason(state, exitCode, signal, fallback) {
  const recent = Array.isArray(state?.recentErrorLines)
    ? dedupeRecentCliFailureLines(state.recentErrorLines).slice(-5)
    : [];
  const recentRateLimitLine = recent.find((line) => isCliRateLimitSignalLine(line));
  if (recentRateLimitLine) {
    return 'Autocode CLI rate limited: ' + recentRateLimitLine;
  }
  if (recent.length > 0) {
    return 'Autocode CLI failed: ' + recent.join(' | ');
  }
  if (signal) {
    return 'Autocode CLI exited by signal: ' + signal;
  }
  if (exitCode !== 0 && exitCode !== null && exitCode !== undefined) {
    return 'Autocode CLI failed with exit code ' + exitCode + '.';
  }
  return fallback || 'Autocode CLI failed.';
}

function isCliRateLimitFailure(state, ...messages) {
  const directSignals = messages
    .filter(Boolean)
    .some((message) => isCliRateLimitSignalLine(String(message)));
  if (directSignals) {
    return true;
  }
  return Array.isArray(state?.recentErrorLines)
    && state.recentErrorLines.some((line) => isCliRateLimitSignalLine(line));
}

function summarizeCliRateLimitReason(state, ...messages) {
  const messageSignals = messages
    .filter(Boolean)
    .map((message) => normalizeCliFailureSignalLine(String(message)))
    .filter(Boolean);
  const recentSignals = Array.isArray(state?.recentErrorLines)
    ? dedupeRecentCliFailureLines(state.recentErrorLines)
    : [];
  const signal = [...messageSignals, ...recentSignals].find((line) => isCliRateLimitSignalLine(line));
  return 'Autocode CLI rate limited: ' + (signal || 'the provider reported a usage limit.');
}

function getDirectCliRetryableFailureReason(result, rateLimited, validationError) {
  if (
    phase !== 'direct' ||
    !result ||
    result.status !== 'error' ||
    rateLimited ||
    validationError
  ) {
    return '';
  }
  const message = String(result.message || '').trim();
  if (!message || isDirectCliNonRetryableFailure(message)) {
    return '';
  }
  return isDirectCliRetryableFailure(message) ? message : '';
}

function isDirectCliNonRetryableFailure(message) {
  const text = String(message || '').toLowerCase();
  return /\b(?:auth|authentication|unauthorized|invalid token|token expired|login required|please login)\b/i.test(text) ||
    /\b(?:command not found|not recognized as an internal or external command|enoent|no such file or directory|cannot find module|permission denied)\b/i.test(text) ||
    /\b(?:model not found|invalid model|unknown model|endpoint not supported)\b/i.test(text);
}

function isDirectCliRetryableFailure(message) {
  const text = String(message || '');
  const lowerText = text.toLowerCase();
  return /Direct attempt produced no output/i.test(text) ||
    /\binactivity timeout\b/i.test(text) ||
    /stream disconnected/i.test(text) ||
    /tls handshake eof/i.test(text) ||
    lowerText.includes('http/request failed') ||
    /error sending request/i.test(text) ||
    /transport channel closed/i.test(text) ||
    /failed to connect to websocket/i.test(text) ||
    /temporar(?:y|ily) unavailable/i.test(text) ||
    /\bnetwork\b/i.test(text) ||
    /\btimeout\b|\btimed out\b/i.test(text) ||
    /Autocode CLI failed with exit code/i.test(text) ||
    /Autocode CLI failed:/i.test(text);
}
function dedupeRecentCliFailureLines(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines) {
    const key = normalizeCliFailureSignalLine(line).toLowerCase();
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(line);
  }
  return result;
}

function decodeCliOutputChunk(data) {
  const utf8Text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const repairedUtf8Text = repairChineseMojibakeText(utf8Text);
  if (!Buffer.isBuffer(data)) {
    return repairedUtf8Text;
  }

  const legacyText = decodeLegacyCliOutput(data);
  if (!legacyText) {
    return repairedUtf8Text;
  }

  const repairedLegacyText = repairChineseMojibakeText(legacyText);
  return shouldPreferEncodingCandidate(repairedUtf8Text, repairedLegacyText)
    ? repairedLegacyText
    : repairedUtf8Text;
}

function decodeLegacyCliOutput(data) {
  if (!data.toString('utf8').includes('\\uFFFD')) {
    return '';
  }

  try {
    gb18030Decoder = gb18030Decoder || new TextDecoder('gb18030');
    return gb18030Decoder.decode(data);
  } catch {
    return '';
  }
}

function repairChineseMojibakeText(text) {
  const separatorRepairedText = repairDenseInjectedFullStopText(text);
  const directPhraseRepairedText = repairKnownChineseMojibakePhrases(separatorRepairedText);
  if (directPhraseRepairedText !== separatorRepairedText) {
    return directPhraseRepairedText;
  }
  if (
    !separatorRepairedText ||
    !iconvLite ||
    scoreMojibakePatternDamage(separatorRepairedText) < 2 ||
    scoreEncodingDamage(separatorRepairedText) < 2
  ) {
    return separatorRepairedText;
  }

  let candidate = separatorRepairedText;
  try {
    candidate = normalizeLossyMojibakePunctuation(
      iconvLite.decode(iconvLite.encode(separatorRepairedText, 'gbk'), 'utf8')
    );
  } catch {
    return separatorRepairedText;
  }

  return shouldPreferEncodingCandidate(separatorRepairedText, candidate) ? candidate : separatorRepairedText;
}

function repairKnownChineseMojibakePhrases(text) {
  return String(text ?? '')
    .replace(/\u8930\u64b3\u58a0\u701b\u612a\u6362\u9354\u2605\u7d30/g, '\u5f53\u524d\u5b50\u4efb\u52a1\uff1a');
}

function shouldPreferEncodingCandidate(original, candidate) {
  if (!candidate || candidate === original) {
    return false;
  }
  if (addsDenseInjectedFullStops(original, candidate)) {
    return false;
  }
  const originalScore = scoreEncodingDamage(original);
  const candidateScore = scoreEncodingDamage(candidate);
  return originalScore >= 2 && candidateScore + 1 < originalScore;
}

function scoreEncodingDamage(text) {
  let score = 0;
  for (const char of text) {
    if (char.charCodeAt(0) === 0xfffd) {
      score += 12;
    }
  }
  return score + scoreMojibakePatternDamage(text);
}

function scoreMojibakePatternDamage(text) {
  const patterns = [
    '锟斤拷',
    '锛',
    '锚',
    '涓€',
    '涓�',
    '涓',
    '瀛愪',
    '换鍔',
    '浠诲姟',
    '褰撳墠',
    '鏂',
    '绋',
    '鐢',
    '寮€濮',
    '鐨',
    '缃戦',
    '椤电',
    '瀹炵幇',
    '淇勭綏',
    '娓告垙',
    '鏂瑰潡',
    '瑰潡',
    '告垙',
    '犲',
    '佸',
    '傚',
    '熷',
    '堕',
    '姝',
    '垚',
    '鈥檒',
    '鈥檓',
    '鈥檙',
    '鈥檚',
    '鈥檛',
    '鈥檝',
    '\u7487\u5b58\u69d1',
    '\u6924\u572d\u6d30',
    '\u9422\u71b8\u579a',
    '\u6d93\ue15f\u6783',
    '\u9350\u546d\ue190',
    '\u9422\u3126\u57db',
    '\u6d60\uff47\u721c',
    '\u95b0\u5d87\u7586',
    '\u5bee\u20ac\u6fee',
    '\u7039\u5c7e\u579a',
    '\u59dd\uff45\u6e6a',
    '\u9352\u6d99\u5270',
    '\u6d60\u8bf2\u59df',
    '\u74ba\ue21c\u568e',
    '\u690b\u5ea8\u6ad3',
    '\u8930\u64b3\u58a0',
    '\u93c2\u56e6\u6b22',
    '\u9352\u55d8\u703d',
    '\u7039\u70b5\u5e47',
    '\u6960\u5c83\u7609',
    '\u93cb\u8235\u702f',
    '\u5a34\u4f7a\u25bc',
    '\u9429\ue1bd\u7223',
    '\u6d5c\u0443\u6427',
    '\u6d93\u660f\ue6e6',
    '\u9356\u546d\u60c8',
    '\u6748\u64b3\u56ad',
    '\u6dc7\ue1bd\u657c',
    '\u6dc7\ue1bc\ue632',
    '\u6fb6\u52ed\u608a',
    '\u9354\u72ba\u6d47',
    '\u6fb6\u8fab\u89e6',
    '\u7487\ue161\u2588',
    '\u7ee0\u20ac\u6d63',
    '\u9354\u71bb\u5158',
    '\u93c1\u7248\u5d41',
    '\u9429\ue1bc\u7d8d',
    '\u7eef\u8364\u7cba',
    '\u93c8\u5d85\u59df',
    '\u5bb8\u30e4\u7d94',
  ];
  let score = 0;
  for (const pattern of patterns) {
    let index = text.indexOf(pattern);
    while (index >= 0) {
      score += pattern.length;
      index = text.indexOf(pattern, index + pattern.length);
    }
  }
  return score;
}

function repairDenseInjectedFullStopText(text) {
  if (!hasDenseInjectedFullStopDamage(text)) {
    return text;
  }

  return text.replace(/。(?=[^。])/g, '');
}

function addsDenseInjectedFullStops(original, candidate) {
  const originalCount = countInjectedFullStopSeparators(original);
  const candidateCount = countInjectedFullStopSeparators(candidate);
  return candidateCount - originalCount >= 20 && hasDenseInjectedFullStopDamage(candidate);
}

function hasDenseInjectedFullStopDamage(text) {
  const count = countInjectedFullStopSeparators(text);
  return count >= 20 && count * 4 >= text.length;
}

function countInjectedFullStopSeparators(text) {
  let count = 0;
  for (let index = 0; index < text.length - 1; index += 1) {
    const next = text[index + 1] || '';
    if (text[index] === '。' && next !== '。' && next.trim() !== '') {
      count += 1;
    }
  }
  return count;
}

function normalizeLossyMojibakePunctuation(text) {
  return text.replace(/\uFFFD[?]/g, '。');
}

function loadIconvLite() {
  const candidates = [iconvLiteModulePath, 'iconv-lite'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next lookup path.
    }
  }
  return null;
}

function queueModelOutput(text, state = defaultAttemptState) {
  const cleaned = stripNoisyCliDiagnosticLines(cleanLogText(text));
  if (!cleaned.trim()) {
    return;
  }

  if (!cliJsonMode) {
    state.lastCliMessageText = appendPlainCliMessageText(
      state.lastCliMessageText,
      cleaned,
    );
    maybeScheduleAttemptCompletionFromModelText(state, state.lastCliMessageText);
  }
  state.pendingModelOutput += cleaned;
  if (state.pendingModelOutput.length >= MODEL_OUTPUT_MAX_CHARS || cleaned.includes('\\n')) {
    flushModelOutput(state);
    return;
  }

  if (!state.modelOutputFlushTimer) {
    state.modelOutputFlushTimer = setTimeout(() => flushModelOutput(state), MODEL_OUTPUT_FLUSH_MS);
  }
}

function flushModelOutput(state = defaultAttemptState) {
  if (state.modelOutputFlushTimer) {
    clearTimeout(state.modelOutputFlushTimer);
    state.modelOutputFlushTimer = null;
  }

  const text = stripNoisyCliDiagnosticLines(state.pendingModelOutput).trim();
  state.pendingModelOutput = '';
  if (!text) {
    return;
  }

  const content = text.length > MODEL_OUTPUT_MAX_CHARS
    ? text.slice(0, MODEL_OUTPUT_MAX_CHARS - 3) + '...'
    : text;
  const detail = text.length > MODEL_OUTPUT_MAX_CHARS ? text : undefined;
  appendTaskLogEntry(logPhase, 'text', content, detail, buildAttemptLogExtra(state));
}

function appendPlainCliMessageText(previous, next) {
  const combined = [previous, next].filter(Boolean).join('\\n');
  return combined.length > MODEL_OUTPUT_MAX_CHARS
    ? combined.slice(-MODEL_OUTPUT_MAX_CHARS)
    : combined;
}

function processCliJsonOutput(text, state = defaultAttemptState) {
  state.cliJsonLineBuffer += text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const lines = state.cliJsonLineBuffer.split('\\n');
  state.cliJsonLineBuffer = lines.pop() || '';

  for (const line of lines) {
    processCliJsonLine(line, state);
  }
}

function flushCliJsonOutput(state = defaultAttemptState) {
  if (!state.cliJsonLineBuffer.trim()) {
    state.cliJsonLineBuffer = '';
    return;
  }
  processCliJsonLine(state.cliJsonLineBuffer, state);
  state.cliJsonLineBuffer = '';
}

function processCliJsonLine(line, state = defaultAttemptState) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return;
  }
  const normalizedJsonLine = normalizeCliJsonDiagnosticLine(trimmed);

  let event;
  try {
    event = JSON.parse(normalizedJsonLine);
  } catch {
    if (isLikelyInternalCliJsonDiagnosticLog(normalizedJsonLine)) {
      appendCollapsedInternalCliJsonDiagnosticLog(normalizedJsonLine, state);
      return;
    }
    process.stdout.write(trimmed + '\\n');
    queueModelOutput(trimmed + '\\n', state);
    return;
  }

  if (!handleCliJsonEvent(event, state)) {
    if (process.env.AUTOCODE_DEBUG_CLI_JSON === '1') {
      appendTaskLogEntry(
        logPhase,
        'info',
        'Unhandled ' + getActiveCliJsonEventParserDisplayName() + ' JSON event: ' + limitLogText(trimmed, 800),
        trimmed,
        buildAttemptLogExtra(state),
      );
    }
  }
}

function rememberCliJsonSessionId(sessionId) {
  const normalized = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (phase === 'direct' && cliJsonMode && normalized) {
    activeCliJsonSessionId = normalized;
  }
}

function getActiveCliJsonEventParserDisplayName() {
  return activeCliJsonEventParser?.displayName || 'CLI';
}

function handleCliJsonEvent(event, state = defaultAttemptState) {
  if (!activeCliJsonEventParser) {
    return false;
  }
  return handleGenericCliJsonEvent(event, state);
}

function handleGenericCliJsonEvent(event, state = defaultAttemptState) {
  const envelope = asRecord(event);
  if (!envelope) {
    return false;
  }

  const payload = getGenericCliJsonPayload(envelope);
  const eventTypeFields = getActiveCliJsonParserList('eventTypeFields', DEFAULT_CLI_JSON_EVENT_TYPE_FIELDS);
  const sessionIdFields = getActiveCliJsonParserList('sessionIdFields', DEFAULT_CLI_JSON_SESSION_ID_FIELDS);
  const messageFields = getActiveCliJsonParserList('messageFields', DEFAULT_CLI_JSON_MESSAGE_FIELDS);
  const payloadType = getFirstStringFromFields(payload, eventTypeFields) || getFirstStringFromFields(envelope, eventTypeFields);
  const sessionId = getFirstStringFromFields(payload, sessionIdFields) || getFirstStringFromFields(envelope, sessionIdFields);
  let handled = false;

  if (sessionId) {
    rememberCliJsonSessionId(sessionId);
    handled = true;
  }

  const usage = extractCliJsonTokenUsage(envelope, payload, sessionId);
  let usageHandled = false;
  const handleUsage = () => {
    if (!usage || usageHandled) {
      return false;
    }
    updatePlanTokenUsage(usage);
    usageHandled = true;
    return true;
  };

  if (handleGenericCliJsonToolEvent(payload, payloadType, state, handleUsage)) {
    return true;
  }

  if (isIgnoredGenericCliJsonEvent(payloadType)) {
    handleUsage();
    return true;
  }

  const messageValue = getFirstValueFromFields(payload, messageFields) ?? getFirstValueFromFields(envelope, messageFields);
  const message = stringifyCliJsonText(messageValue);
  if (message.trim()) {
    handleUsage();
    appendCliJsonMessageLog(message, state);
    handled = true;
  }

  if (isGenericCliJsonCompletionEvent(payloadType)) {
    handleUsage();
    scheduleAttemptCompletionGrace(state, { explicitCompletionEvent: true });
    handled = true;
  }

  return handleUsage() || handled;
}

function handleGenericCliJsonToolEvent(payload, payloadType, state, handleUsage) {
  const normalizedType = normalizeCliJsonEventType(payloadType);
  if (!normalizedType) {
    return false;
  }

  if (matchesCliJsonEventType(normalizedType, getActiveCliJsonParserList('toolStartEventTypes', DEFAULT_CLI_JSON_TOOL_START_EVENT_TYPES))) {
    handleUsage();
    state.toolCallCount = (state.toolCallCount || 0) + 1;
    const toolName = getFirstStringFromFields(payload, getActiveCliJsonParserList('toolNameFields', DEFAULT_CLI_JSON_TOOL_NAME_FIELDS)) || 'tool';
    const toolInput = stringifyCliJsonText(getFirstValueFromFields(payload, getActiveCliJsonParserList('toolInputFields', DEFAULT_CLI_JSON_TOOL_INPUT_FIELDS)));
    appendTaskLogEntry(
      logPhase,
      'tool_start',
      'Tool started: ' + toolName,
      toolInput,
      buildAttemptLogExtra(state, {
        tool_name: toolName,
        tool_input: toolInput ? limitLogText(toolInput, 1000) : undefined,
        tool_call_id: getFirstStringFromFields(payload, getActiveCliJsonParserList('toolCallIdFields', DEFAULT_CLI_JSON_TOOL_CALL_ID_FIELDS)),
      }),
    );
    return true;
  }

  if (matchesCliJsonEventType(normalizedType, getActiveCliJsonParserList('toolEndEventTypes', DEFAULT_CLI_JSON_TOOL_END_EVENT_TYPES))) {
    handleUsage();
    const toolNameFields = getActiveCliJsonParserList('toolNameFields', DEFAULT_CLI_JSON_TOOL_NAME_FIELDS);
    const toolInputFields = getActiveCliJsonParserList('toolInputFields', DEFAULT_CLI_JSON_TOOL_INPUT_FIELDS);
    const toolOutputFields = getActiveCliJsonParserList('toolOutputFields', DEFAULT_CLI_JSON_TOOL_OUTPUT_FIELDS);
    const toolInput = stringifyCliJsonText(getFirstValueFromFields(payload, toolInputFields));
    const output = stringifyCliJsonText(getFirstValueFromFields(payload, toolOutputFields));
    const exitCode = getFirstNumberFromFields(payload, getActiveCliJsonParserList('toolExitCodeFields', DEFAULT_CLI_JSON_TOOL_EXIT_CODE_FIELDS));
    const status = getFirstStringFromFields(payload, getActiveCliJsonParserList('toolStatusFields', DEFAULT_CLI_JSON_TOOL_STATUS_FIELDS));
    const success = resolveGenericCliJsonToolSuccess(
      getFirstValueFromFields(payload, getActiveCliJsonParserList('toolSuccessFields', DEFAULT_CLI_JSON_TOOL_SUCCESS_FIELDS)),
      exitCode,
      status,
    );
    const toolName = getFirstStringFromFields(payload, toolNameFields) || (toolInput ? 'Command' : undefined);
    const summary = toolInput
      ? formatCliCommandExecutionSummary(toolInput, success, exitCode)
      : output.trim()
        ? 'Tool output' + (toolName ? ': ' + toolName : '') + '\\n' + limitLogText(output, 1200)
        : 'Tool output' + (toolName ? ': ' + toolName : '');
    const detail = toolInput
      ? formatCliCommandExecutionDetail(toolInput, output, exitCode, status)
      : output.length > 1200 ? output : undefined;
    appendTaskLogEntry(
      logPhase,
      'tool_end',
      summary,
      detail,
      buildAttemptLogExtra(state, {
        tool_name: toolName,
        tool_input: toolInput ? limitLogText(toolInput, 1000) : undefined,
        tool_success: success,
        tool_call_id: getFirstStringFromFields(payload, getActiveCliJsonParserList('toolCallIdFields', DEFAULT_CLI_JSON_TOOL_CALL_ID_FIELDS)),
      }),
    );
    return true;
  }

  return false;
}

function isIgnoredGenericCliJsonEvent(payloadType) {
  const normalizedType = normalizeCliJsonEventType(payloadType);
  if (!normalizedType) {
    return false;
  }
  if (matchesCliJsonEventType(normalizedType, getActiveCliJsonParserList('ignoredEventTypes', DEFAULT_CLI_JSON_IGNORED_EVENT_TYPES))) {
    return true;
  }
  return getActiveCliJsonParserList('ignoredEventTypeIncludes', DEFAULT_CLI_JSON_IGNORED_EVENT_TYPE_INCLUDES)
    .some((item) => {
      const normalized = normalizeCliJsonEventType(item);
      return Boolean(normalized && normalizedType.includes(normalized));
    });
}

function matchesCliJsonEventType(normalizedType, eventTypes) {
  return eventTypes.some((item) => normalizeCliJsonEventType(item) === normalizedType);
}

function normalizeCliJsonEventType(value) {
  const type = valueToNonEmptyString(value);
  return type ? type.toLowerCase() : '';
}

function resolveGenericCliJsonToolSuccess(value, exitCode, status) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    if (/^(true|success|succeeded|ok|completed|passed)$/i.test(value.trim())) {
      return true;
    }
    if (/^(false|fail|failed|error|errored|cancelled|canceled)$/i.test(value.trim())) {
      return false;
    }
  }
  if (typeof exitCode === 'number') {
    return exitCode === 0;
  }
  if (typeof status === 'string' && status.trim()) {
    return !/fail|error|cancel/i.test(status);
  }
  return undefined;
}

function getGenericCliJsonPayload(envelope) {
  const fields = getActiveCliJsonParserList('payloadFields', DEFAULT_CLI_JSON_PAYLOAD_FIELDS);
  for (const field of fields) {
    const record = asRecord(getValueByPath(envelope, field));
    if (record) {
      return record;
    }
  }
  return envelope;
}

function isGenericCliJsonCompletionEvent(payloadType) {
  const type = valueToNonEmptyString(payloadType);
  if (!type) {
    return false;
  }
  const completionTypes = getActiveCliJsonParserList('completionEventTypes', DEFAULT_CLI_JSON_COMPLETION_EVENT_TYPES);
  const normalizedType = type.toLowerCase();
  return completionTypes.some((item) => String(item || '').toLowerCase() === normalizedType);
}

function getActiveCliJsonParserList(key, fallback) {
  const value = activeCliJsonEventParser && activeCliJsonEventParser[key];
  if (!Array.isArray(value)) {
    return fallback;
  }
  const items = value.map((item) => String(item || '').trim()).filter(Boolean);
  return items.length > 0 ? items : fallback;
}

function getFirstStringFromFields(record, fields) {
  const value = getFirstValueFromFields(record, fields);
  return valueToNonEmptyString(value);
}

function getFirstNumberFromFields(record, fields) {
  const value = getFirstValueFromFields(record, fields);
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : undefined;
}

function getFirstValueFromFields(record, fields) {
  const source = asRecord(record);
  if (!source) {
    return undefined;
  }
  for (const field of fields) {
    const value = getValueByPath(source, field);
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return undefined;
}

function getValueByPath(record, path) {
  const source = asRecord(record);
  if (!source) {
    return undefined;
  }
  const segments = String(path || '').split('.').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) {
    return undefined;
  }
  let current = source;
  for (const segment of segments) {
    const currentRecord = asRecord(current);
    if (!currentRecord || !(segment in currentRecord)) {
      return undefined;
    }
    current = currentRecord[segment];
  }
  return current;
}

function valueToNonEmptyString(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function formatCliCommandExecutionSummary(commandText, success, exitCode) {
  const statusText = success === false
    ? localizeMessage('commandFailed', 'Command failed', {})
    : localizeMessage('commandCompleted', 'Command completed', {});
  const suffix = exitCode === undefined ? '' : ' (exit ' + exitCode + ')';
  return commandText
    ? statusText + suffix + ': ' + limitLogText(commandText, 240)
    : statusText + suffix;
}

function formatCliCommandExecutionDetail(commandText, output, exitCode, status) {
  const lines = [];
  if (commandText) {
    lines.push('Command:', commandText, '');
  }
  if (exitCode !== undefined || status) {
    lines.push('Result:', [
      status ? 'status=' + status : '',
      exitCode !== undefined ? 'exit_code=' + exitCode : '',
    ].filter(Boolean).join(', '), '');
  }
  if (output.trim()) {
    lines.push('Output:', output.trim());
  }
  return lines.join('\\n').trim();
}

function isLikelyInternalCliJsonDiagnosticLog(value) {
  const text = normalizeCliJsonDiagnosticLine(value);
  if (!text.startsWith('{')) {
    return false;
  }
  try {
    const parsed = JSON.parse(text);
    return Boolean(parsed &&
      typeof parsed === 'object' &&
      typeof parsed.type === 'string' &&
      parsed.type.startsWith('item.') &&
      ('item' in parsed || 'command_execution' in parsed || 'aggregated_output' in parsed));
  } catch {
    return false;
  }
}

function normalizeCliJsonDiagnosticLine(value) {
  const text = String(value ?? '').trim();
  let index = 0;
  while (index < text.length && (text[index] === '。' || text[index].trim() === '')) {
    index += 1;
  }
  return text[index] === '{' ? text.slice(index) : text;
}

function appendCollapsedInternalCliJsonDiagnosticLog(value, state = defaultAttemptState) {
  appendTaskLogEntry(
    logPhase,
    'text',
    localizeMessage('internalCliJsonCollapsed', 'Internal CLI event log collapsed.', {}),
    String(value ?? ''),
    buildAttemptLogExtra(state),
  );
}

function appendCliJsonMessageLog(message, state = defaultAttemptState) {
  const cleanMessage = cleanLogText(message).trim();
  if (!cleanMessage || cleanMessage === state.lastCliMessageText) {
    return;
  }
  state.lastCliMessageText = cleanMessage;
  maybeScheduleAttemptCompletionFromModelText(state, cleanMessage);
  const content = limitLogText(cleanMessage, MODEL_OUTPUT_MAX_CHARS);
  process.stdout.write(content + '\\n');
  appendTaskLogEntry(
    logPhase,
    'text',
    content,
    cleanMessage.length > MODEL_OUTPUT_MAX_CHARS ? cleanMessage : undefined,
    buildAttemptLogExtra(state),
  );
}

function normalizeCliJsonTokenUsage(raw, sessionId) {
  const source = asRecord(raw);
  if (!source) {
    return null;
  }
  const totalUsage = asRecord(source.total_token_usage) ||
    asRecord(source.totalTokenUsage) ||
    asRecord(source.total_usage) ||
    asRecord(source.totalUsage) ||
    asRecord(source.last_token_usage) ||
    asRecord(source.lastTokenUsage) ||
    source;
  const promptTokens = readNumber(totalUsage.input_tokens ?? totalUsage.inputTokens ?? totalUsage.prompt_tokens ?? totalUsage.promptTokens);
  const completionTokens = readNumber(totalUsage.output_tokens ?? totalUsage.outputTokens ?? totalUsage.completion_tokens ?? totalUsage.completionTokens);
  const totalTokens = readNumber(totalUsage.total_tokens ?? totalUsage.totalTokens) ||
    (promptTokens || completionTokens ? promptTokens + completionTokens : 0);
  if (!promptTokens && !completionTokens && !totalTokens) {
    return null;
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    stepsExecuted: readOptionalNumber(
      totalUsage.stepsExecuted ??
      totalUsage.steps_executed ??
      totalUsage.modelSteps ??
      totalUsage.model_steps ??
      totalUsage.turnCount ??
      totalUsage.turn_count ??
      totalUsage.turns ??
      totalUsage.requestCount ??
      totalUsage.request_count ??
      totalUsage.modelRequests ??
      totalUsage.model_requests ??
      source.stepsExecuted ??
      source.steps_executed ??
      source.modelSteps ??
      source.model_steps ??
      source.turnCount ??
      source.turn_count ??
      source.turns ??
      source.requestCount ??
      source.request_count ??
      source.modelRequests ??
      source.model_requests,
    ),
    thinkingTokens: readOptionalNumber(totalUsage.reasoning_output_tokens ?? totalUsage.reasoningOutputTokens ?? totalUsage.reasoningTokens ?? totalUsage.thinkingTokens),
    cacheReadTokens: readOptionalNumber(totalUsage.cached_input_tokens ?? totalUsage.cachedInputTokens ?? totalUsage.cache_read_tokens ?? totalUsage.cacheReadTokens),
    cacheCreationTokens: readOptionalNumber(totalUsage.cache_creation_input_tokens ?? totalUsage.cacheCreationInputTokens ?? totalUsage.cache_creation_tokens ?? totalUsage.cacheCreationTokens),
    sessionId,
  };
}

function extractCliJsonTokenUsage(envelope, payload, sessionId) {
  const payloadResponse = asRecord(payload.response);
  const envelopeResponse = asRecord(envelope.response);
  const candidates = [
    payload.info,
    payload.usage,
    payload.token_usage,
    payload.tokenUsage,
    payload.total_token_usage,
    payload.totalTokenUsage,
    payload.last_token_usage,
    payload.lastTokenUsage,
    payloadResponse?.usage,
    payloadResponse?.token_usage,
    payloadResponse?.tokenUsage,
    envelope.info,
    envelope.usage,
    envelope.token_usage,
    envelope.tokenUsage,
    envelope.total_token_usage,
    envelope.totalTokenUsage,
    envelope.last_token_usage,
    envelope.lastTokenUsage,
    envelopeResponse?.usage,
    envelopeResponse?.token_usage,
    envelopeResponse?.tokenUsage,
  ];

  for (const candidate of candidates) {
    const usage = normalizeCliJsonTokenUsage(candidate, sessionId);
    if (usage) {
      return usage;
    }
  }
  return null;
}

function updatePlanTokenUsage(usage) {
  const now = new Date().toISOString();
  const planPath = join(specDir, artifacts.implementationPlan);
  const merged = withFileWriteLock(planPath, 'runner:plan-token-usage', () => {
    let content = '';
    try {
      content = readFileSync(planPath, 'utf8');
    } catch {
      content = [
        '# Implementation Plan',
        '',
        'Feature: ' + taskTitle,
        'Created: ' + now,
        '',
        '## Description',
        '',
        taskDescription,
        '',
      ].join('\\n');
    }

    const currentMetadata = readPlanMachineMetadata(content);
    const previousUsage = normalizePersistedTokenUsage(currentMetadata.tokenUsage);
    const nextStepsExecuted = getNextTokenUsageStepCount(previousUsage, usage);
    const incoming = {
      ...usage,
      stepsExecuted: nextStepsExecuted,
      sessionId: usage.sessionId || previousUsage?.sessionId,
    };
    const nextUsage = mergeTokenUsage(previousUsage, incoming);

    content = upsertPlanMetadata(content, 'Updated', now);
    content = upsertPlanMachineMetadata(content, {
      tokenUsage: nextUsage,
      last_updated: now,
    });
    writeFileSync(planPath, content.endsWith('\\n') ? content : content + '\\n', 'utf8');
    return nextUsage;
  });
  emitTokenUsage(merged);

  if ((merged.totalTokens ?? 0) !== lastTokenUsageLogTotal) {
    lastTokenUsageLogTotal = merged.totalTokens ?? 0;
    appendTaskLogEntry(logPhase, 'info', formatTokenUsageMessage(merged));
  }
}

function readPlanMachineMetadata(content) {
  const match = /^<!--\\s*autocode-plan-meta:\\s*(\\{.*\\})\\s*-->\\s*$/m.exec(content);
  if (!match) {
    return {};
  }
  try {
    const parsed = JSON.parse(match[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getNextTokenUsageStepCount(previousUsage, usage) {
  const previousSteps = previousUsage?.stepsExecuted ?? 0;
  if (usage.stepsExecuted) {
    if (previousUsage && usage.sessionId && previousUsage.sessionId && usage.sessionId !== previousUsage.sessionId) {
      tokenUsageEventCount = Math.max(tokenUsageEventCount, previousSteps + usage.stepsExecuted);
      return tokenUsageEventCount || undefined;
    }
    if (previousUsage && !usage.sessionId && !tokenUsageImplicitSessionCounted) {
      tokenUsageImplicitSessionCounted = true;
      tokenUsageEventCount = Math.max(tokenUsageEventCount, previousSteps + usage.stepsExecuted);
      return tokenUsageEventCount || undefined;
    }
    tokenUsageEventCount = Math.max(tokenUsageEventCount, previousSteps, usage.stepsExecuted);
    return tokenUsageEventCount || undefined;
  }
  if (!previousUsage) {
    tokenUsageEventCount = Math.max(tokenUsageEventCount, 1);
    return tokenUsageEventCount || undefined;
  }
  if (usage.sessionId && previousUsage.sessionId && usage.sessionId !== previousUsage.sessionId) {
    tokenUsageEventCount = Math.max(tokenUsageEventCount + 1, previousSteps + 1);
    return tokenUsageEventCount || undefined;
  }
  if (!usage.sessionId && !tokenUsageImplicitSessionCounted) {
    tokenUsageImplicitSessionCounted = true;
    tokenUsageEventCount = Math.max(tokenUsageEventCount + 1, previousSteps + 1);
    return tokenUsageEventCount || undefined;
  }
  tokenUsageEventCount = Math.max(tokenUsageEventCount, previousSteps);
  return tokenUsageEventCount || undefined;
}

function normalizePersistedTokenUsage(value) {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  return {
    promptTokens: readNumber(record.promptTokens),
    completionTokens: readNumber(record.completionTokens),
    totalTokens: readNumber(record.totalTokens),
    thinkingTokens: readOptionalNumber(record.thinkingTokens),
    cacheReadTokens: readOptionalNumber(record.cacheReadTokens),
    cacheCreationTokens: readOptionalNumber(record.cacheCreationTokens),
    stepsExecuted: readOptionalNumber(record.stepsExecuted),
    estimated: record.estimated === true ? true : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };
}

function mergeTokenUsage(previous, incoming) {
  if (!previous) {
    return dropUndefinedTokenUsage(incoming);
  }
  if (previous.estimated === true && incoming.estimated !== true) {
    return dropUndefinedTokenUsage({
      ...incoming,
      stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
      sessionId: incoming.sessionId || previous.sessionId,
    });
  }
  const preferIncomingTokens = incoming.estimated !== true || previous.estimated === true;
  return dropUndefinedTokenUsage({
    promptTokens: preferIncomingTokens
      ? Math.max(previous.promptTokens ?? 0, incoming.promptTokens ?? 0)
      : previous.promptTokens,
    completionTokens: preferIncomingTokens
      ? Math.max(previous.completionTokens ?? 0, incoming.completionTokens ?? 0)
      : previous.completionTokens,
    totalTokens: preferIncomingTokens
      ? Math.max(previous.totalTokens ?? 0, incoming.totalTokens ?? 0)
      : previous.totalTokens,
    thinkingTokens: Math.max(previous.thinkingTokens ?? 0, incoming.thinkingTokens ?? 0) || undefined,
    cacheReadTokens: Math.max(previous.cacheReadTokens ?? 0, incoming.cacheReadTokens ?? 0) || undefined,
    cacheCreationTokens: Math.max(previous.cacheCreationTokens ?? 0, incoming.cacheCreationTokens ?? 0) || undefined,
    stepsExecuted: Math.max(previous.stepsExecuted ?? 0, incoming.stepsExecuted ?? 0) || undefined,
    estimated: previous.estimated === true && incoming.estimated === true ? true : undefined,
    sessionId: incoming.sessionId || previous.sessionId,
  });
}

function dropUndefinedTokenUsage(value) {
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined && item !== null && item !== '') {
      result[key] = item;
    }
  }
  return result;
}

function formatTokenUsageMessage(usage) {
  if (language === 'zh-CN') {
    return '模型用量更新：模型轮次 ' + (usage.stepsExecuted ?? 0) +
      ' 次，输入 ' + (usage.promptTokens ?? 0) +
      '，输出 ' + (usage.completionTokens ?? 0) +
      '，总计 ' + (usage.totalTokens ?? 0) + ' tokens。';
  }
  if (language === 'fr') {
    return 'Utilisation du modele : ' + (usage.stepsExecuted ?? 0) +
      ' etapes modele, entree ' + (usage.promptTokens ?? 0) +
      ', sortie ' + (usage.completionTokens ?? 0) +
      ', total ' + (usage.totalTokens ?? 0) + ' tokens.';
  }
  return 'Model usage updated: ' + (usage.stepsExecuted ?? 0) +
    ' model steps, input ' + (usage.promptTokens ?? 0) +
    ', output ' + (usage.completionTokens ?? 0) +
    ', total ' + (usage.totalTokens ?? 0) + ' tokens.';
}

function emitTokenUsage(usage) {
  process.stdout.write('__TASK_TOKEN_USAGE__:' + JSON.stringify(usage) + '\\n');
}

function emitTaskEvent(type, extra) {
  process.stdout.write(taskEventPrefix + JSON.stringify({
    type,
    taskId: basename(specDir),
    specId: basename(specDir),
    projectId: projectId || '',
    timestamp: new Date().toISOString(),
    eventId: basename(specDir) + '-' + type + '-' + Date.now(),
    sequence: Date.now(),
    ...(extra || {}),
  }) + '\\n');
}

function persistDirectSessionState(result, now, quality, changedFiles = []) {
  if (phase !== 'direct') {
    return;
  }

  const statePath = join(specDir, artifacts.directSession);
  const existing = readJsonFile(statePath) || {};
  const summary = readDirectCompletionSummary(result, currentAttemptStartedAt);
  const tokenUsage = readCurrentPlanTokenUsage();
  const sessionId = activeCliJsonSessionId
    ? activeCliJsonSessionId
    : typeof tokenUsage?.sessionId === 'string' && tokenUsage.sessionId.trim()
      ? tokenUsage.sessionId.trim()
      : typeof existing.sessionId === 'string' && existing.sessionId.trim()
        ? existing.sessionId.trim()
        : getDirectCliSessionPrefix() + randomUUID();
  const iteration = Number.isFinite(existing.iteration)
    ? Math.max(1, Math.floor(existing.iteration) + 1)
    : 1;

  if (summary) {
    writeFileSync(join(specDir, artifacts.directSummary), summary.endsWith('\\n') ? summary : summary + '\\n', 'utf8');
  }
  writeJson(statePath, {
    version: directSessionStateVersion,
    sessionId,
    createdAt: typeof existing.createdAt === 'string' && existing.createdAt.trim()
      ? existing.createdAt
      : now,
    updatedAt: now,
    iteration,
    provider: getDirectCliProviderName(),
    providerDisplayName: getDirectCliProviderDisplayName(),
    modelId: getDirectCliModelId(),
    originalRequest: compactDirectSessionText(
      typeof existing.originalRequest === 'string' && existing.originalRequest.trim()
        ? existing.originalRequest
        : taskDescription || taskTitle,
      4000,
      '\\n...[original request middle omitted for state budget; inspect task metadata if exact omitted detail is required]...\\n',
    ),
    latestSummary: compactDirectSessionText(
      summary || result.message,
      1200,
      '\\n...[direct session summary middle omitted for continuation budget; inspect runtime logs if exact omitted detail is required]...\\n',
    ),
    changedFiles: mergeRunnerChangedFiles(existing.changedFiles, changedFiles),
    lastOutcome: result.status || 'unknown',
  });
}

function collectRunnerGitChangedFileSnapshot() {
  return {
    files: new Set(collectRunnerGitChangedFiles()),
  };
}

function collectRunnerFilesChangedSinceBaseline(baseline) {
  const current = new Set(collectRunnerGitChangedFiles());
  const baselineFiles = baseline && baseline.files instanceof Set ? baseline.files : new Set();
  return uniqueRunnerProjectPaths([...current].filter((filePath) => !baselineFiles.has(filePath)));
}

function collectRunnerGitChangedFiles() {
  if (!isRunnerGitWorkspace()) {
    return [];
  }
  const outputs = [
    runRunnerGitListCommand(['diff', '--name-only', '--diff-filter=ACMRT', '--']),
    runRunnerGitListCommand(['diff', '--cached', '--name-only', '--diff-filter=ACMRT', '--']),
    runRunnerGitListCommand(['ls-files', '--others', '--exclude-standard']),
  ];
  return uniqueRunnerProjectPaths(outputs.flatMap((output) => output.split(/\\r?\\n/)));
}

function isRunnerGitWorkspace() {
  const result = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
  });
  return result.status === 0;
}

function runRunnerGitListCommand(args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout || '') : '';
}

function uniqueRunnerProjectPaths(paths) {
  const seen = new Set();
  const result = [];
  for (const rawPath of paths) {
    const normalized = normalizeRunnerProjectRelativePath(rawPath);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeRunnerProjectRelativePath(filePath) {
  const trimmed = String(filePath || '').trim();
  if (!trimmed) {
    return null;
  }
  const projectRoot = resolve(cwd);
  const resolvedPath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectRoot, trimmed);
  const relativePath = relative(projectRoot, resolvedPath).replace(/\\\\/g, '/');
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) {
    return null;
  }
  if (relativePath.includes('/../') || isRunnerAutocodeProjectDataPath(relativePath)) {
    return null;
  }
  return relativePath;
}

function isRunnerAutocodeProjectDataPath(relativePath) {
  const normalized = String(relativePath || '').replace(/\\\\/g, '/').replace(/^\\.\\//, '');
  return Boolean(projectDataRelativeDir) && (normalized === projectDataRelativeDir || normalized.startsWith(projectDataRelativeDir + '/'));
}

function inferRunnerProjectDataRelativeDir() {
  try {
    const projectRoot = resolve(cwd);
    const dataDir = resolve(dirname(dirname(specDir)));
    const relativeDir = relative(projectRoot, dataDir).replace(/\\\\/g, '/');
    if (!relativeDir || relativeDir === '..' || relativeDir.startsWith('../')) {
      return '.autocode';
    }
    return relativeDir.replace(/^\\.\\//, '');
  } catch {
    return '.autocode';
  }
}

function mergeRunnerChangedFiles(existing, current) {
  return uniqueRunnerProjectPaths([
    ...(Array.isArray(existing) ? existing : []),
    ...(Array.isArray(current) ? current : []),
  ]).slice(0, 100);
}
function readDirectCompletionSummary(result, minMtimeMs = runStartedAt) {
  const summaryPath = join(specDir, artifacts.directSummary);
  const liveText = (result.status && result.status !== 'success'
    ? result.message
    : defaultAttemptState.lastCliMessageText || result.message || '').trim();
  try {
    const summaryStats = statSync(summaryPath);
    const content = readFileSync(summaryPath, 'utf8').trim();
    if (content && summaryStats.mtimeMs >= minMtimeMs) {
      return content;
    }
  } catch {
    // Use current model output below.
  }
  return liveText;
}

async function evaluateDirectCliQuality(result, now, changedFiles = [], minSummaryMtimeMs = runStartedAt, activeDurationMs) {
  const finalText = readDirectCompletionSummary(result, minSummaryMtimeMs);
  const tokenUsage = readCurrentPlanTokenUsage();
  const durationMs = Math.max(
    0,
    Number.isFinite(activeDurationMs)
      ? Math.floor(activeDurationMs)
      : Date.now() - runStartedAt,
  );
  const stepsExecuted = Number.isFinite(tokenUsage && tokenUsage.stepsExecuted)
    ? Math.max(0, Math.floor(tokenUsage.stepsExecuted))
    : tokenUsageEventCount > 0
      ? 1
      : 0;
  const quality = {
    mode: 'direct',
    outcome: normalizeDirectCliQualityOutcome(result),
    changedFiles,
    filesChanged: changedFiles.length,
    stepsExecuted,
    toolCallCount: Math.max(0, Math.floor(defaultAttemptState.toolCallCount || 0)),
    durationMs,
    recordedAt: now,
    selfCritique: {
      status: 'skipped',
      filesReviewed: 0,
      improvements: changedFiles.length > 0
        ? ['Direct CLI runner records changed files but does not run in-process self-critique; review git diff before approval.']
        : ['No changed files were detected for this Direct CLI run; review runner output before approval.'],
    },
    validation: inferRunnerDirectValidationEvidence(finalText),
  };

  const fallbackValidation = quality.validation;
  const directSummary = await loadDirectTaskSummaryModule();
  if (directSummary && typeof directSummary.inferAutocodeDirectValidationEvidence === 'function') {
    try {
      const sharedValidation = directSummary.inferAutocodeDirectValidationEvidence(
        buildDirectCliSessionResultForQuality(result, quality, finalText, tokenUsage),
        finalText,
      );
      quality.validation = reconcileRunnerDirectValidationEvidence(fallbackValidation, sharedValidation);
    } catch {
      // Keep the local fallback evidence.
    }
  }

  return quality;
}

function reconcileRunnerDirectValidationEvidence(fallbackValidation, sharedValidation) {
  if (
    fallbackValidation &&
    sharedValidation &&
    fallbackValidation.status === 'reported_passed' &&
    !isRunnerDirectValidationPassed(sharedValidation.status)
  ) {
    return fallbackValidation;
  }
  return sharedValidation || fallbackValidation;
}

function normalizeDirectCliQualityOutcome(result) {
  if (!result) {
    return 'unknown';
  }
  if (result.status === 'success') {
    return 'completed';
  }
  return result.status || 'unknown';
}

function buildDirectCliSessionResultForQuality(result, quality, finalText, tokenUsage) {
  const usage = tokenUsage || {};
  return {
    outcome: quality.outcome,
    usage: {
      promptTokens: usage.promptTokens || 0,
      completionTokens: usage.completionTokens || 0,
      totalTokens: usage.totalTokens || 0,
      sessionId: usage.sessionId,
    },
    messages: finalText ? [{ role: 'assistant', content: finalText }] : [],
    stepsExecuted: quality.stepsExecuted,
    toolCallCount: quality.toolCallCount,
    durationMs: quality.durationMs,
    error: result && result.status !== 'success'
      ? {
          code: result.status || 'error',
          message: result.message || 'Direct CLI run failed.',
          retryable: result.status === 'rate_limited',
        }
      : undefined,
  };
}

async function getDirectCliQualityGateFailureReason(quality) {
  const directSummary = await loadDirectTaskSummaryModule();
  const requireValidation = isDirectCliValidationRequired(directSummary);
  const options = { requireValidation, requireSelfCritique: requireValidation };
  if (directSummary && typeof directSummary.getAutocodeDirectQualityGateFailureReason === 'function') {
    try {
      const sharedReason = directSummary.getAutocodeDirectQualityGateFailureReason(quality, options);
      if (sharedReason) {
        return sharedReason;
      }
    } catch {
      // Use the local fallback below.
    }
  }
  return getRunnerDirectQualityGateFailureReason(quality, options);
}

async function loadDirectTaskSummaryModule() {
  if (!directTaskSummaryModulePath) {
    return null;
  }
  if (!directTaskSummaryModulePromise) {
    directTaskSummaryModulePromise = import(pathToFileURL(directTaskSummaryModulePath).href).catch(() => null);
  }
  return directTaskSummaryModulePromise;
}

function isDirectCliValidationRequired(directSummary) {
  return phase === 'direct' && !isDirectCliNonImplementationTask(directSummary);
}

function isDirectCliNonImplementationTask(directSummary) {
  const plan = readCurrentPlanContextForDirectValidation();
  const metadata = asRecord(taskMetadata) || {};
  if (directSummary && typeof directSummary.shouldRequireAutocodeDirectValidation === 'function') {
    try {
      return !directSummary.shouldRequireAutocodeDirectValidation({
        plan,
        metadata,
        description: taskDescription,
      });
    } catch {
      // Use the local fallback below.
    }
  }
  return isDirectCliNonImplementationContext(plan, metadata, taskDescription);
}

function readCurrentPlanContextForDirectValidation() {
  try {
    const content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
    const metadata = readPlanMachineMetadata(content);
    const workflowType = getFirstString(metadata, ['workflow_type', 'workflowType', 'workflow']) || extractPlanWorkflowType(content);
    return {
      ...metadata,
      ...(workflowType ? { workflow_type: workflowType } : {}),
    };
  } catch {
    return {};
  }
}

function extractPlanWorkflowType(content) {
  const match = /^Workflow:\s*(.+?)\s*$/mi.exec(String(content || ''));
  return match && match[1] ? match[1].trim() : '';
}

function isDirectCliNonImplementationContext(plan, metadata, description) {
  const workflowType = normalizeDirectCliContextString(plan.workflow_type) ||
    normalizeDirectCliContextString(metadata.workflow_type) ||
    normalizeDirectCliContextString(metadata.workflowType);
  if (['documentation', 'investigation', 'analysis', 'research'].includes(workflowType)) {
    return true;
  }

  const metadataCategory = normalizeDirectCliContextString(metadata.category);
  const metadataSource = normalizeDirectCliContextString(metadata.sourceType) || normalizeDirectCliContextString(metadata.source_type);
  const metadataIdeaType = normalizeDirectCliContextString(metadata.ideationType) || normalizeDirectCliContextString(metadata.ideation_type);
  const metadataTaskType = normalizeDirectCliContextString(metadata.taskType) || normalizeDirectCliContextString(metadata.task_type) || normalizeDirectCliContextString(metadata.type);

  if (metadataCategory === 'documentation' || metadataSource === 'project_docs') {
    return true;
  }
  if (['documentation_gaps', 'documentation', 'analysis', 'investigation', 'research'].includes(metadataIdeaType)) {
    return true;
  }
  if (['documentation', 'analysis', 'investigation', 'research'].includes(metadataTaskType)) {
    return true;
  }
  if (
    directCliContextString(metadata.projectDocumentType) ||
    directCliContextString(metadata.project_document_type) ||
    directCliContextString(metadata.projectDocumentOutputDir) ||
    directCliContextString(metadata.project_document_output_dir) ||
    Array.isArray(metadata.projectDocumentOutputs) ||
    Array.isArray(metadata.project_document_outputs)
  ) {
    return true;
  }
  if (
    directCliContextString(plan.documentation_depth) ||
    directCliContextString(plan.documentation_profile) ||
    Array.isArray(plan.documentation_focus) ||
    Object.keys(asRecord(plan.project_documentation) || {}).length > 0
  ) {
    return true;
  }

  const requestText = [
    directCliContextString(description),
    directCliContextString(metadata.task_description),
    directCliContextString(metadata.description),
    directCliContextString(metadata.title),
    directCliContextString(plan.title),
    directCliContextString(plan.feature),
  ].filter(Boolean).join('\\n');
  return isDirectCliNonImplementationRequestText(requestText);
}

function isDirectCliNonImplementationRequestText(text) {
  if (!String(text || '').trim()) {
    return false;
  }
  if (hasDirectCliImplementationRequestSignal(text)) {
    return false;
  }
  return /\\b(?:analy[sz]e|analysis|investigate|investigation|research|audit|review|explain|summari[sz]e|summary|report|write[-\\s]?up|documentation|docs?|document)\\b/iu.test(text) ||
    /(?:\u5206\u6790|\u8c03\u67e5|\u8c03\u7814|\u7814\u7a76|\u5ba1\u8ba1|\u590d\u6838|\u89e3\u91ca|\u8bf4\u660e|\u603b\u7ed3|\u62a5\u544a|\u6587\u6863|\u68b3\u7406|\u5b9a\u4f4d\u539f\u56e0|\u539f\u56e0\u5206\u6790|\u4e3a\u4ec0\u4e48|\u4e3a\u5565)/u.test(text);
}

function hasDirectCliImplementationRequestSignal(text) {
  // Failure/validation nouns alone can describe analysis tasks; require an explicit implementation action.
  return /\\b(?:fix(?:e[sd])?|repair|resolve|implement(?:ed|s|ation|ing)?|coding|code|patch(?:ed|es|ing)?|refactor(?:ed|s|ing)?|bugfix)\\b/iu.test(text) ||
    /(?:\u4fee\u590d|\u5b9e\u73b0|\u7f16\u7801|\u91cd\u6784|\u6539\u4ee3\u7801|\u4ee3\u7801\u4fee\u6539)/u.test(text);
}

function directCliContextString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeDirectCliContextString(value) {
  return directCliContextString(value).toLowerCase();
}

function getRunnerDirectQualityGateFailureReason(quality, options = {}) {
  if (!quality) {
    return null;
  }
  if (options.requireSelfCritique !== false && quality.selfCritique && quality.selfCritique.status === 'failed') {
    const improvements = Array.isArray(quality.selfCritique.improvements)
      ? quality.selfCritique.improvements.slice(0, 3).map((item) => String(item || '').trim()).filter(Boolean).join('; ')
      : '';
    return 'Direct self-critique failed' + (improvements ? ': ' + improvements : ': quality score below threshold');
  }
  if (quality.validation && (quality.validation.status === 'reported_failed' || quality.validation.status === 'reported_mixed')) {
    return 'Direct validation ' + quality.validation.status + ': ' + quality.validation.reason;
  }
  if (options.requireValidation === true && quality.validation && !isRunnerDirectValidationPassed(quality.validation.status)) {
    return 'Direct validation ' + quality.validation.status + ': ' + quality.validation.reason;
  }
  return null;
}

function isRunnerDirectValidationPassed(status) {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'reported_passed' ||
    normalized === 'passed' ||
    normalized === 'pass' ||
    normalized === 'success' ||
    normalized === 'succeeded';
}

function inferRunnerDirectValidationEvidence(finalText) {
  const validationText = extractRunnerDirectValidationText(finalText);
  if (!validationText) {
    return {
      status: 'not_run',
      reason: 'No validation command or result was reported in the Direct final response.',
    };
  }

  const hasPass = hasRunnerDirectValidationPassSignal(validationText);
  const hasFail = hasRunnerDirectValidationFailSignal(validationText);
  const hasSkip = /\\b(?:not run|not executed|skipped|manual only|not required|n\\/a)\\b/i.test(validationText) ||
    /(?:\u672a\u8fd0\u884c|\u672a\u6267\u884c|\u8df3\u8fc7|\u672a\u9a8c\u8bc1|\u65e0\u9700\u9a8c\u8bc1|\u624b\u52a8\u9a8c\u8bc1)/u.test(validationText);
  const reason = compactRunnerDirectValidationReason(validationText);
  if (hasPass && hasFail) {
    return { status: 'reported_mixed', reason };
  }
  if (hasFail) {
    return { status: 'reported_failed', reason };
  }
  if (hasPass) {
    return { status: 'reported_passed', reason };
  }
  if (hasSkip) {
    return { status: 'not_run', reason };
  }
  return { status: 'reported', reason };
}

function extractRunnerDirectValidationText(value) {
  return cleanLogText(String(value || ''))
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .split('\\n')
    .map((line) => line.trim())
    .filter((line) => line && isRunnerDirectValidationLine(line))
    .slice(-12)
    .join('\\n');
}

function isRunnerDirectValidationLine(line) {
  return /\\b(?:validation|verify|verified|test|tests|typecheck|build|lint|smoke|passed|failed|not run|skipped|npm|npx|pnpm|yarn|dotnet|cargo|pytest|go test)\\b/i.test(line) ||
    /(?:\u9a8c\u8bc1|\u6d4b\u8bd5|\u6784\u5efa|\u7f16\u8bd1|\u68c0\u67e5|\u901a\u8fc7|\u5931\u8d25|\u672a\u8fd0\u884c|\u672a\u6267\u884c|\u672a\u9a8c\u8bc1)/u.test(line);
}

function hasRunnerDirectValidationPassSignal(text) {
  return /\\b(?:passed|pass|succeeded|success|green|ok|error[-\\s]?free|failure[-\\s]?free)\\b/i.test(text) ||
    /\\b(?:no|zero|0)\\s+(?:failed|failures?|errors?|exceptions?)\\b/i.test(text) ||
    /\\b(?:without|with no)\\s+(?:failed|failures?|errors?|exceptions?)\\b/i.test(text) ||
    /\\bnot\\s+(?:failing|failed)\\b/i.test(text) ||
    /\\b(?:failed|failures?|errors?|exceptions?)\\s*[:=]\\s*0\\b/i.test(text) ||
    /\\bexit\\s+code\\s*[:=]?\\s*0\\b/i.test(text) ||
    /(?:\\u901a\\u8fc7|\\u6210\\u529f|\\u6b63\\u5e38|\\u65e0\\u5f02\\u5e38|\\u65e0\\u9519\\u8bef|\\u672a\\u53d1\\u73b0\\u9519\\u8bef|\\u6ca1\\u6709\\u9519\\u8bef|\\u6ca1\\u6709\\u5f02\\u5e38)/u.test(text) ||
    hasRunnerDirectRenderValidationPassSignal(text);
}

function hasRunnerDirectValidationFailSignal(text) {
  const failureText = stripRunnerDirectNegatedFailureSignals(text);
  return /\\b(?:failed|failing|failure|error|errors|exception|red|non[-\\s]?zero)\\b/i.test(failureText) ||
    /\\bexit(?:ed)?\\s+(?:with\\s+)?(?:code\\s*)?[1-9]\\d*\\b/i.test(failureText) ||
    /(?:\\u5931\\u8d25|\\u672a\\u901a\\u8fc7|\\u62a5\\u9519|\\u9519\\u8bef|\\u5f02\\u5e38)/u.test(failureText) ||
    /(?:\\u9875\\u9762|\\u754c\\u9762|\\u5e94\\u7528).{0,30}(?:\\u65e0\\u6cd5\\u52a0\\u8f7d|\\u4e0d\\u53ef\\u52a0\\u8f7d|\\u4e0d\\u80fd\\u52a0\\u8f7d|\\u52a0\\u8f7d\\u5931\\u8d25)/u.test(failureText);
}

function hasRunnerDirectRenderValidationPassSignal(text) {
  return /(?:\\u622a\\u56fe|\\u6e32\\u67d3|Chrome|headless|canvas|file:\\/\\/).{0,100}(?:\\u786e\\u8ba4|\\u9a8c\\u8bc1).{0,50}(?:\\u9875\\u9762|\\u754c\\u9762|\\u5e94\\u7528).{0,40}(?:\\u53ef\\u52a0\\u8f7d|\\u80fd\\u52a0\\u8f7d|\\u53ef\\u4ee5\\u52a0\\u8f7d|\\u6b63\\u5e38\\u52a0\\u8f7d|\\u6210\\u529f\\u52a0\\u8f7d|\\u53ef\\u6253\\u5f00|\\u80fd\\u6253\\u5f00|\\u6b63\\u786e\\u6e32\\u67d3|\\u6210\\u529f\\u6e32\\u67d3)/iu.test(text) ||
    /(?:Chrome|node --check|UTF-8).{0,140}\\u7ead\\uE1BF\\uE17B.{0,50}\\u9359\\uE21A\\u59DE\\u675E/iu.test(text);
}

function stripRunnerDirectNegatedFailureSignals(text) {
  return String(text || '')
    .replace(/\\berror[-\\s]?free\\b/gi, ' ')
    .replace(/\\bfailure[-\\s]?free\\b/gi, ' ')
    .replace(/\\b(?:no|zero|0)\\s+(?:failed|failures?|errors?|exceptions?)\\b/gi, ' ')
    .replace(/\\b(?:without|with no)\\s+(?:failed|failures?|errors?|exceptions?)\\b/gi, ' ')
    .replace(/\\bnot\\s+(?:failing|failed)\\b/gi, ' ')
    .replace(/\\b(?:failed|failures?|errors?|exceptions?)\\s*[:=]\\s*0\\b/gi, ' ')
    .replace(/\\bexit\\s+code\\s*[:=]?\\s*0\\b/gi, ' ')
    .replace(/(?:\\u65e0\\u5f02\\u5e38|\\u65e0\\u9519\\u8bef|\\u672a\\u53d1\\u73b0\\u9519\\u8bef|\\u6ca1\\u6709\\u9519\\u8bef|\\u6ca1\\u6709\\u5f02\\u5e38|0\\s*(?:\\u4e2a)?\\s*\\u9519\\u8bef)/gu, ' ');
}


function compactRunnerDirectValidationReason(value) {
  const normalized = cleanLogText(String(value || '')).replace(/\\s+/g, ' ').trim();
  if (normalized.length <= 500) {
    return normalized;
  }
  return normalized.slice(0, 497).trimEnd() + '...';
}
function readCurrentPlanTokenUsage() {
  try {
    const content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
    return normalizePersistedTokenUsage(readPlanMachineMetadata(content).tokenUsage);
  } catch {
    return undefined;
  }
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function compactDirectSessionText(value, maxLength, marker) {
  const normalized = cleanLogText(String(value || ''))
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/[ \\t]+\\n/g, '\\n')
    .replace(/\\n{4,}/g, '\\n\\n\\n')
    .trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  const budget = Math.max(0, maxLength - marker.length);
  const headLength = Math.ceil(budget * 0.65);
  const tailLength = Math.max(0, budget - headLength);
  return [
    normalized.slice(0, headLength).trimEnd(),
    marker,
    normalized.slice(-tailLength).trimStart(),
  ].join('');
}

async function validateExpectedArtifacts() {
  const qualityError = await validateStandardPlanArtifactQuality();
  if (qualityError) {
    return qualityError;
  }

  const derivedPlanError = await deriveRuntimePlanFromStandardTasksIfNeeded();
  if (derivedPlanError) {
    return derivedPlanError;
  }

  if (phase === 'spec') {
    if (!existsSync(join(specDir, artifacts.specFile))) {
      return \`CLI finished without creating \${artifacts.specFile}.\`;
    }
    if (!planHasSubtasks()) {
      return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
    }
    const metadataError = validatePlanningSchedulingMetadata();
    if (metadataError) {
      return metadataError;
    }
  }
  if (phase === 'planning' && !planHasSubtasks()) {
    return \`CLI finished without creating \${artifacts.implementationPlan} subtasks.\`;
  }
  if (phase === 'planning') {
    const metadataError = validatePlanningSchedulingMetadata();
    if (metadataError) {
      return metadataError;
    }
  }
  return undefined;
}

async function validateStandardPlanArtifactQuality() {
  if (phase !== 'spec' && phase !== 'planning') {
    return undefined;
  }
  if (!planQualityModulePath) {
    return undefined;
  }
  try {
    repairStandardPlanEvidenceScaffolding();
    const moduleUrl = pathToFileURL(planQualityModulePath).href;
    const planQuality = await import(moduleUrl);
    const contextMarkdown = readOptionalArtifact(artifacts.context || 'context.md');
    const result = planQuality.validateAutocodeStandardPlanArtifacts({
      specMarkdown: readOptionalArtifact(artifacts.specFile),
      requirementsMarkdown: readOptionalArtifact(artifacts.requirements),
      tasksMarkdown: readOptionalArtifact(artifacts.tasks || 'tasks.md'),
      contextMarkdown,
      requireSpecEvidence: phase === 'planning',
      requireRequirementsEvidence: phase === 'planning',
      requireTaskEvidence: true,
      requireContextEvidence: phase === 'planning' && Boolean(contextMarkdown),
    });
    if (!result || result.valid) {
      return undefined;
    }
    const errors = Array.isArray(result.errors) ? result.errors : [];
    if (
      validationRetryCount >= maxValidationRetries &&
      hasOnlyStandardPlanRecoverableQualityErrors(planQuality, errors)
    ) {
      appendTaskLogEntry(
        logPhase,
        'info',
        'Standard plan artifact quality still has recoverable warnings after validation retries; continuing with the generated plan: ' +
          errors.slice(0, 4).join('; '),
      );
      return undefined;
    }
    return 'Standard plan artifact quality failed: ' + errors.slice(0, 8).join('; ');
  } catch (error) {
    return 'Unable to validate Standard plan artifact quality: ' + (error instanceof Error ? error.message : String(error));
  }
}

function repairStandardPlanEvidenceScaffolding() {
  const repaired = [];
  const scaffold = getStandardPlanEvidenceScaffold();
  if (ensureArtifactEvidenceSection(
    artifacts.specFile,
    'Evidence',
    scaffold.specEvidence,
  )) {
    repaired.push(artifacts.specFile);
  }
  if (phase === 'planning' && ensureArtifactEvidenceSection(
    artifacts.requirements,
    'Evidence Sources',
    scaffold.requirementsEvidence,
  )) {
    repaired.push(artifacts.requirements);
  }
  if (repaired.length > 0) {
    appendTaskLogEntry(logPhase, 'info', 'Added missing Standard evidence scaffolding to: ' + repaired.join(', '));
  }
}

function getStandardPlanEvidenceScaffold() {
  const requestEvidence = String(taskDescription || taskTitle || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
  if (String(language || '').trim().toLowerCase().replace(/_/g, '-').startsWith('zh')) {
    return {
      specEvidence: [
        requestEvidence
          ? '- 用户请求：' + requestEvidence
          : '- 用户请求由 Autocode 任务描述提供。',
        '- requirements.md 记录了本任务的用户请求和规划约束。',
        '- tasks.md 将实现工作映射回生成的 Standard 需求。',
      ],
      requirementsEvidence: [
        requestEvidence
          ? '- 用户任务描述：' + requestEvidence
          : '- Autocode 捕获的用户任务描述。',
        '- Autocode 捕获的用户任务描述。',
        '- spec.md 中的规划范围和成功标准。',
      ],
    };
  }
  return {
    specEvidence: [
      requestEvidence
        ? '- User request: ' + requestEvidence
        : '- User request captured by Autocode task metadata.',
      '- requirements.md captures the user request and planning constraints for this task.',
      '- tasks.md maps the implementation work back to the generated Standard requirements.',
    ],
    requirementsEvidence: [
      requestEvidence
        ? '- User task description: ' + requestEvidence
        : '- User task description captured by Autocode.',
      '- User task description captured by Autocode.',
      '- spec.md planning scope and success criteria.',
    ],
  };
}

function ensureArtifactEvidenceSection(fileName, heading, lines) {
  if (!fileName) {
    return false;
  }
  const filePath = join(specDir, fileName);
  if (!existsSync(filePath)) {
    return false;
  }
  const content = readFileSync(filePath, 'utf8');
  const headingPattern = new RegExp('^##\\\\s+' + escapeRegExp(heading) + '\\\\b', 'im');
  if (headingPattern.test(content)) {
    return false;
  }
  const section = ['', '## ' + heading, '', ...lines, ''].join('\\n');
  writeFileSync(filePath, content.replace(/\\s*$/u, '') + '\\n\\n' + section, 'utf8');
  return true;
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\\\{}()[\\]^$+*?.]/g, '\\\\$&');
}

function hasOnlyStandardPlanRecoverableQualityErrors(planQuality, errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return false;
  }
  return errors.every((error) =>
    isStandardPlanTaskGranularityError(planQuality, error) ||
    isStandardPlanEvidenceScaffoldError(error),
  );
}

function isStandardPlanTaskGranularityError(planQuality, error) {
  if (typeof planQuality.isAutocodePlanTaskGranularityError === 'function') {
    return planQuality.isAutocodePlanTaskGranularityError(error) === true;
  }
  return /\\btasks\\.md task \\S+ is too broad;/.test(String(error || ''));
}

function isStandardPlanEvidenceScaffoldError(error) {
  const text = String(error || '');
  return text === artifacts.specFile + ' missing "## Evidence" section.' ||
    text === artifacts.specFile + ' Requirements section must cite Evidence for requirements or acceptance criteria.' ||
    text === artifacts.specFile + ' Design Notes must cite Evidence or move unverified claims to Assumptions/Open Questions.' ||
    text === artifacts.requirements + ' missing non-empty "Evidence Sources" section.';
}

function readOptionalArtifact(fileName) {
  if (!fileName) {
    return undefined;
  }
  try {
    return readFileSync(join(specDir, fileName), 'utf8');
  } catch {
    return undefined;
  }
}

async function deriveRuntimePlanFromStandardTasksIfNeeded() {
  if (phase !== 'spec' && phase !== 'planning') {
    return undefined;
  }

  const tasksPath = join(specDir, artifacts.tasks || 'tasks.md');
  if (!existsSync(tasksPath)) {
    return \`CLI finished without creating \${artifacts.tasks || 'tasks.md'}.\`;
  }
  if (!workPackagesModulePath) {
    return 'Unable to load Autocode work package builder.';
  }

  try {
    const moduleUrl = pathToFileURL(workPackagesModulePath).href;
    const workPackages = await import(moduleUrl);
    const plan = workPackages.buildAutocodeRuntimeImplementationPlanFromTasksMarkdown(
      readFileSync(tasksPath, 'utf8'),
      {
        now: new Date().toISOString(),
        language,
        sourcePath: artifacts.tasks || 'tasks.md',
        requireTaskEvidence: true,
        includeCompletedTasks: false,
      },
    );
    const existingPlanMetadata = readExistingPlanMachineMetadata();
    if (existingPlanMetadata.tokenUsage) {
      plan.tokenUsage = existingPlanMetadata.tokenUsage;
    }
    if (existingPlanMetadata.last_updated) {
      plan.last_updated = existingPlanMetadata.last_updated;
    }
    const markdown = workPackages.stringifyAutocodeImplementationPlanMarkdown(plan);
    writeFileSync(join(specDir, artifacts.implementationPlan), markdown, 'utf8');
    appendTaskLogEntry(logPhase, 'info', 'Generated runtime work packages from tasks.md.');
    return undefined;
  } catch (error) {
    return \`Failed to generate \${artifacts.implementationPlan} from \${artifacts.tasks || 'tasks.md'}: \${error instanceof Error ? error.message : String(error)}\`;
  }
}

function readExistingPlanMachineMetadata() {
  try {
    return readPlanMachineMetadata(readFileSync(join(specDir, artifacts.implementationPlan), 'utf8'));
  } catch {
    return {};
  }
}

function shouldValidatePlanningSchedulingMetadata() {
  const mode = String(taskMetadata?.developmentMode || '').toLowerCase();
  return mode === 'standard' || runtimeConcurrency.mode === 'concurrent';
}

function validatePlanningSchedulingMetadata() {
  if (!shouldValidatePlanningSchedulingMetadata()) {
    return undefined;
  }
  const items = readPlanItems().filter((item) => item.isSubtask);
  const errors = [];
  const mode = String(taskMetadata?.developmentMode || '').toLowerCase();
  const requireEvidence = mode === 'standard';
  for (const item of items) {
    if (!item.hasDependencyMetadata) {
      errors.push(item.id + ' missing _Depends on: ..._ metadata');
    }
    if (requireEvidence && !item.hasEvidenceMetadata) {
      errors.push(item.id + ' missing _Evidence: ..._ metadata');
    }
    if (!item.hasVerificationMetadata) {
      errors.push(item.id + ' missing _Verification: ..._ metadata');
    }
  }
  const dependencyIssues = collectRunnerDependencyIssues(items, getPlanItemStatusMap(items));
  for (const issue of dependencyIssues) {
    errors.push(issue.message);
  }
  if (errors.length === 0) {
    return undefined;
  }
  const preview = errors.slice(0, 8).join('; ');
  return \`\${artifacts.implementationPlan} missing scheduling metadata: \${preview}\${errors.length > 8 ? '; ...' : ''}\`;
}

function compactArtifactValidationRetryBasePrompt(value) {
  const text = foldRepeatedRunnerPromptLines(
    String(value || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim(),
  );
  if (text.length <= VALIDATION_RETRY_BASE_PROMPT_MAX_CHARS) {
    return text;
  }
  const notice = '\\n\\n...[original prompt middle omitted for validation retry budget; reread referenced artifacts if exact omitted detail is required]...\\n\\n';
  const budget = Math.max(0, VALIDATION_RETRY_BASE_PROMPT_MAX_CHARS - notice.length);
  const headBudget = Math.ceil(budget * 0.68);
  const tailBudget = Math.max(0, budget - headBudget);
  return text.slice(0, headBudget).trimEnd() + notice + text.slice(-tailBudget).trimStart();
}

function compactArtifactValidationError(value) {
  const text = foldRepeatedRunnerPromptLines(
    String(value || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim(),
  ).replace(/\\s+/g, ' ').trim();
  if (text.length <= VALIDATION_RETRY_ERROR_MAX_CHARS) {
    return text;
  }
  const notice = ' ... [validation error middle omitted] ... ';
  const budget = Math.max(0, VALIDATION_RETRY_ERROR_MAX_CHARS - notice.length);
  const headBudget = Math.ceil(budget * 0.62);
  const tailBudget = Math.max(0, budget - headBudget);
  return text.slice(0, headBudget).trimEnd() + notice + text.slice(-tailBudget).trimStart();
}

function compactDirectQualityRetryText(value, maxChars = DIRECT_QUALITY_RETRY_FEEDBACK_MAX_CHARS) {
  const text = foldRepeatedRunnerPromptLines(
    String(value || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').trim(),
  );
  if (text.length <= maxChars) {
    return text;
  }
  const notice = '\\n...[direct retry feedback middle omitted]...\\n';
  const budget = Math.max(0, maxChars - notice.length);
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return text.slice(0, headBudget).trimEnd() + notice + text.slice(-tailBudget).trimStart();
}

function getDirectQualityFailureSignature(failureReason, quality) {
  const validation = quality && quality.validation ? quality.validation : {};
  const selfCritique = quality && quality.selfCritique ? quality.selfCritique : {};
  return normalizeDirectQualityFailureSignatureText([
    failureReason,
    validation.status,
    validation.reason,
    selfCritique.status,
    Array.isArray(selfCritique.improvements) ? selfCritique.improvements.slice(0, 3).join('|') : '',
  ].join(' '));
}

function normalizeDirectQualityFailureSignatureText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\\battempt\\s+\\d+(?:\\s*\\/\\s*\\d+)?\\b/g, 'attempt #')
    .replace(/\\bretry\\s+\\d+(?:\\s*\\/\\s*\\d+)?\\b/g, 'retry #')
    .replace(/\\bpid\\s*[:=]?\\s*\\d+\\b/g, 'pid #')
    .replace(/\\b\\d{4}-\\d{2}-\\d{2}t\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?z?\\b/g, '<timestamp>')
    .replace(/\\b\\d+(?:\\.\\d+)?\\s*(?:ms|milliseconds?|s|sec|seconds?|mins?|minutes?)\\b/g, '<duration>')
    .replace(/[a-z]:[\\\\/][^\\s]+/g, '<path>')
    .replace(/\s+/g, ' ')
    .trim();
}
function formatDirectQualityRetryList(items, limit = DIRECT_QUALITY_RETRY_FILE_PREVIEW_LIMIT) {
  const normalized = (Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (normalized.length === 0) {
    return 'none';
  }
  const preview = normalized.slice(0, limit).join(', ');
  return normalized.length > limit ? preview + ', ...and ' + (normalized.length - limit) + ' more' : preview;
}

function buildDirectQualityRetryPrompt(input) {
  const quality = input.quality || {};
  const validation = quality.validation || {};
  const selfCritique = quality.selfCritique
    ? String(quality.selfCritique.status || 'unknown') +
      (Number.isFinite(quality.selfCritique.score) ? ' (' + Math.round(quality.selfCritique.score * 100) + '%)' : '') +
      '; improvements: ' + formatDirectQualityRetryList(quality.selfCritique.improvements, 4)
    : 'not run';
  const nextAttempt = Math.max(2, Math.floor(input.attempt || 1) + 1);
  const maxAttempts = Math.max(nextAttempt, Math.floor(input.maxRetries || 0) + 1);
  const finalText = compactDirectQualityRetryText(input.finalText || '', 2000);
  const attemptTranscript = compactDirectQualityRetryText(input.attemptTranscript || '', 3000);

  return [
    compactArtifactValidationRetryBasePrompt(prompt),
    '',
    '---',
    '',
    '## Direct Validation Retry (' + nextAttempt + '/' + maxAttempts + ')',
    '',
    input.failedAttempt
      ? 'The previous Direct CLI attempt exited before completion or returned an error.'
      : 'The previous Direct CLI attempt exited successfully, but validation or the quality gate failed.',
    'Do not repeat the same implementation idea blindly. Inspect the current diff and relevant files first, then decide whether the previous hypothesis was wrong or only incomplete.',
    input.repeatedFailure ? 'Repeated failure guard: this failure matches an earlier Direct CLI attempt. Treat the previous approach as suspect, choose a different strategy, or reduce the fix to a smaller verifiable change before editing again.' : '',
    '',
    '## Previous Attempt Feedback',
    '',
    'Failure: ' + compactDirectQualityRetryText(input.failureReason),
    'Validation: ' + String(validation.status || 'unknown') + ' - ' + compactDirectQualityRetryText(validation.reason || 'No validation detail.'),
    'Self-critique: ' + compactDirectQualityRetryText(selfCritique),
    'Changed files: ' + formatDirectQualityRetryList(input.changedFiles),
    finalText ? 'Final response excerpt:\\n' + finalText : '',
    attemptTranscript && attemptTranscript !== finalText ? 'Previous attempt transcript:\\n' + attemptTranscript : '',
    '',
    '## Required Next Action',
    '',
    '1. Re-read the current files and git diff before editing.',
    '2. Diagnose why the previous attempt failed; do not only restate the error.',
    '3. Rework or replace prior edits if they caused the failure. Prefer a smaller verifiable change over repeating the same broad approach.',
    '4. Run the most focused validation command available and report the exact command and result.',
    '5. Leave an updated Direct summary in ' + specDir + '/' + artifacts.directSummary + ' or include the summary in the final response.',
  ].filter((line) => line !== '').join('\\n');
}

function buildArtifactValidationRetryPrompt(validationError) {
  const standardTasksMode = phase === 'spec' || phase === 'planning';
  const compactValidationError = compactArtifactValidationError(validationError);
  const rawValidationError = String(validationError || '');
  const shouldRepairSpecArtifact = standardTasksMode && /\\bspec\\.md\\b/i.test(rawValidationError);
  const shouldRepairRequirementsArtifact = standardTasksMode && /\\brequirements\\.md\\b/i.test(rawValidationError);
  const requiredOutputs = phase === 'spec'
    ? [
        \`- Write or repair \${specDir}/\${artifacts.specFile}.\`,
        standardTasksMode
          ? \`- Write or repair \${specDir}/\${artifacts.tasks || 'tasks.md'}.\`
          : \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ]
    : [
        ...(shouldRepairSpecArtifact
          ? [\`- Write or repair \${specDir}/\${artifacts.specFile}.\`]
          : []),
        ...(shouldRepairRequirementsArtifact
          ? [\`- Write or repair \${specDir}/\${artifacts.requirements}.\`]
          : []),
        standardTasksMode
          ? \`- Write or repair \${specDir}/\${artifacts.tasks || 'tasks.md'}.\`
          : \`- Write or repair \${specDir}/\${artifacts.implementationPlan}.\`,
      ];

  const retryIntro = [
    '## Retry Required',
    '',
    \`The previous CLI attempt exited successfully, but artifact validation failed: \${compactValidationError}\`,
    '',
    'Repair the missing or invalid artifact now. Write the file, not just an explanation.',
  ];

  const planRules = [
    standardTasksMode ? '## tasks.md Requirements' : '## implementation_plan.md Requirements',
    '',
    '- Single Autocode Markdown checklist.',
    '- Include at least one executable task numbered like 1.1, 1.2, or 2.1.',
    '- A top-level phase alone is not enough.',
    '- Each task must include _Depends on_, _Evidence_, and _Verification_. Include _Files to create/modify_ when write intent is known.',
    '- Evidence must cite spec.md, requirements.md, context.md, project source/docs, existing project patterns, or verified official/industry references.',
    '- Use Project Memory workflow recipes, pattern, decision, or module insight entries as architecture/design pattern references for similar tasks when they match current source/docs.',
    '- Do not force named architecture or design pattern guidance onto simple, single-boundary tasks.',
    '- For complex or high-risk plans, add a detailed but compact ## Architecture And Design Pattern References section to spec.md or tasks.md: 4-8 bullets covering boundary/layer, pattern or strategy, source/docs/Project Memory reference or labeled general guidance, and applicable task IDs/boundaries.',
    '- For complex or high-risk tasks, each executable task must include _Architecture: boundary; pattern/strategy; source/reference_ so implementation agents can apply the guidance directly.',
    '- Use exactly one architecture metadata line per task and keep the metadata key in English: _Architecture: ..._. Do not use localized keys such as _架构: ..._ or include both labels.',
    '- Do not introduce a named design pattern unless source evidence or similar-task memory shows it reduces concrete complexity.',
    ...(standardTasksMode
      ? [
          '- spec.md must include a non-empty ## Evidence section whenever spec.md is written or repaired.',
          '- requirements.md must include a non-empty ## Evidence Sources section whenever requirements.md is written or repaired.',
          '- requirements.md must include concrete User Requirements and Acceptance Criteria; do not leave either section as None when tasks.md derives requirements or acceptance criteria.',
          '- Do not keep the only concrete Requirement Index inside tasks.md; mirror concrete requirements and acceptance criteria into requirements.md.',
        ]
      : []),
    '- Cover every requirement, scenario, acceptance criterion, or success criterion from spec.md/requirements.md; call out blocked or out-of-scope items instead of dropping them.',
    '- Keep each executable task small enough for one focused coding session and include a clear done signal in guidance or _Done when: ..._.',
    '- Split broad work into focused leaf tasks; a task covering more than three behaviors, more than three requirement/acceptance references, or more than four write-intent files is too broad.',
    '- For runnable/user-facing deliverables, add runtime-readiness verification that starts/opens the artifact, exercises the primary path, and checks console/resource loading/blank-screen/startup/exit status.',
    '- Runtime-readiness verification cannot be node --check, lint, typecheck, file existence, or inspect-only review.',
    '- If split tasks touch the same file, keep them separate and add _Depends on_ only for real data, contract, or verification order; the runtime queues overlapping file writes safely.',
    '- Keep spec.md compact as a decision index; put detailed source evidence in context.md and cite it from tasks.md.',
    '- If this is a Request Changes retry, update only affected requirement/design/task sections and preserve unaffected content.',
    '- Use _Depends on: none_ for any task that has no true prerequisite. Use _Files to modify: none_ only for read-only validation.',
  ];

  return [
    compactArtifactValidationRetryBasePrompt(prompt),
    '',
    '---',
    '',
    ...retryIntro,
    '',
    '## Required Output',
    '',
    ...requiredOutputs,
    '',
    ...planRules,
    '',
    '~~~md',
    standardTasksMode ? '# Tasks' : '# Implementation Plan',
    '',
    'Feature: <task title>',
    'Workflow: feature',
    'Status: pending',
    '',
    '- [ ] 1. Implementation',
    '',
    '  - [ ] 1.1 Implement the first concrete change',
    '    - Describe the implementation step.',
    '    - For complex work, follow the existing boundary/pattern from src/example.ts or labeled general guidance; omit this for simple single-boundary work.',
    '    - _Files to modify: path/to/file.ts_',
    '    - _Depends on: none_',
    '    - _Requirements: 1.1_',
    '    - _Evidence: spec.md requirement 1.1; src/example.ts existing pattern_',
    '    - _Done when: the concrete change is implemented and verification passes_',
    '    - _Verification: npm test_',
    '~~~',
  ].join('\\n');
}

function planHasSubtasks() {
  try {
    const content = readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
    return /^\\s*-\\s+\\[[ xX/!-]\\]\\s+[A-Za-z0-9]+[.-][A-Za-z0-9]+(?:[.)])?\\s+.+/m.test(content);
  } catch {
    return false;
  }
}

function updatePlanRunningState() {
  const now = new Date().toISOString();
  const status = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
  const phaseValue = phase === 'coding' || phase === 'direct' ? 'coding' : 'planning';
  updatePlanMetadata({
    status,
    planStatus: status,
    xstateState: phaseValue,
    reviewReason: undefined,
    executionPhase: phaseValue,
    updatedAt: now,
    directExecution: phase === 'direct' ? { outcome: 'running' } : undefined,
  });
  if (phase === 'direct') {
    updateDirectCliPlanItemStatus('in_progress', 'Direct CLI run started.');
  }
}

function updatePlanStatus(failed, message, now, directQuality, result) {
  const isCodingPhase = phase === 'coding' || phase === 'direct';
  updatePlanMetadata({
    status: failed ? 'error' : 'human_review',
    planStatus: failed ? 'error' : 'review',
    xstateState: failed ? 'error' : isCodingPhase ? 'human_review' : 'plan_review',
    reviewReason: failed ? 'errors' : isCodingPhase ? 'completed' : 'plan_review',
    executionPhase: failed ? 'failed' : isCodingPhase ? 'complete' : 'planning',
    updatedAt: now,
    directExecution: phase === 'direct'
      ? {
          outcome: getDirectCliExecutionOutcome(failed, result),
          completedAt: failed ? undefined : now,
          quality: directQuality,
        }
      : undefined,
  });
  if (phase === 'direct') {
    updateDirectCliPlanItemStatus(
      failed ? 'failed' : 'completed',
      message || (failed ? 'Direct CLI run failed.' : 'Completed by Autocode Direct CLI run.'),
      directQuality && Number.isFinite(directQuality.durationMs) ? directQuality.durationMs : undefined,
    );
  }
}

function updateDirectCliPlanItemStatus(status, note, durationMs) {
  const content = readCurrentPlanContent();
  const directExecution = readPlanMachineMetadata(content).direct_execution;
  const currentSubtaskId = getDirectCliCurrentSubtaskId(directExecution, content);
  markPlanSubtaskStatus('direct', status, note, durationMs);
  markPlanSubtaskStatus(currentSubtaskId, status, note, durationMs);
}

function ensureDirectCliPlanItems(content, directExecution) {
  const currentSubtaskId = getDirectCliCurrentSubtaskId(directExecution, content);
  const normalized = String(content || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  const lines = normalized.split('\\n');
  let directIndex = findRunnerPlanItemLineIndex(lines, 'direct');
  if (directIndex < 0) {
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }
    if (lines.length > 0) {
      lines.push('');
    }
    lines.push('- [ ] direct. Direct execution');
    directIndex = lines.length - 1;
  }

  if (findRunnerPlanItemLineIndex(lines, currentSubtaskId) < 0) {
    let insertAt = directIndex + 1;
    while (insertAt < lines.length) {
      if (isRunnerTopLevelPlanItemLine(lines[insertAt])) {
        break;
      }
      insertAt += 1;
    }
    lines.splice(insertAt, 0, ...buildDirectCliSubtaskLines(currentSubtaskId));
  }

  return lines.join('\\n');
}

function buildDirectCliSubtaskLines(subtaskId) {
  const isChangeRequest = /^direct-cr-/i.test(subtaskId);
  const title = isChangeRequest ? 'Direct Request Changes' : 'Direct model execution';
  const description = isChangeRequest
    ? 'Continue the same Direct model session for the active change request.'
    : 'Implement the task directly with the configured CLI runner.';
  return [
    '  - [ ] ' + subtaskId + ' ' + title,
    '    - ' + description,
    '    - _Depends on: none_',
    '    - _Verification: Review direct_summary.md, runtime logs, and git diff_',
  ];
}

function findRunnerPlanItemLineIndex(lines, itemId) {
  for (let index = 0; index < lines.length; index += 1) {
    if (isRunnerPlanItemLineForId(lines[index], itemId)) {
      return index;
    }
  }
  return -1;
}

function isRunnerTopLevelPlanItemLine(line) {
  return /^-\\s+\\[[ xX/!\\-]\\]\\s+/.test(String(line || ''));
}

function isRunnerPlanItemLineForId(line, itemId) {
  const text = String(line || '').trim();
  const prefixPattern = /^-\\s+\\[[ xX/!\\-]\\]\\s+/;
  const match = prefixPattern.exec(text);
  if (!match) {
    return false;
  }
  const rest = text.slice(match[0].length);
  return rest === itemId || rest.startsWith(itemId + '.') || rest.startsWith(itemId + ' ');
}
function getDirectCliExecutionOutcome(failed, result) {
  if (!result) {
    return failed ? 'error' : 'completed';
  }
  if (result.status === 'success') {
    return 'completed';
  }
  return result.status || (failed ? 'error' : 'completed');
}

function readCurrentPlanDirectExecution() {
  const content = readCurrentPlanContent();
  return readPlanMachineMetadata(content).direct_execution;
}

function readCurrentPlanContent() {
  try {
    return readFileSync(join(specDir, artifacts.implementationPlan), 'utf8');
  } catch {
    return '';
  }
}

function buildDirectCliExecutionMetadata(existing, input, content) {
  const metadata = normalizeDirectCliMetadataObject(existing);
  metadata.enabled = true;
  metadata.outcome = input.outcome || metadata.outcome || 'unknown';
  metadata.summary_file = typeof metadata.summary_file === 'string' && metadata.summary_file.trim()
    ? metadata.summary_file
    : artifacts.directSummary;
  metadata.current_subtask_id = getDirectCliCurrentSubtaskId(metadata, content);
  if (input.completedAt) {
    metadata.completed_at = input.completedAt;
  } else {
    delete metadata.completed_at;
  }
  if (input.quality) {
    metadata.ai_coding_quality = input.quality;
  } else if (input.outcome === 'running') {
    delete metadata.ai_coding_quality;
  }
  return metadata;
}

function normalizeDirectCliMetadataObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function getDirectCliCurrentSubtaskId(existing, content) {
  const metadata = normalizeDirectCliMetadataObject(existing);
  const current = typeof metadata.current_subtask_id === 'string' ? metadata.current_subtask_id.trim() : '';
  if (current) {
    return current;
  }
  return inferDirectCliCurrentSubtaskIdFromPlan(content) || 'direct-implementation';
}

function inferDirectCliCurrentSubtaskIdFromPlan(content) {
  const lines = String(content || '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n').split('\\n');
  const candidates = [];
  for (const line of lines) {
    const match = /^\\s*-\\s+\\[([ xX/!\\-])\\]\\s+(direct-cr-[A-Za-z0-9_.-]+)(?:\\s+|\\.|$)/i.exec(String(line || '').trim());
    if (!match) {
      continue;
    }
    candidates.push({ id: match[2], status: markerToStatus(match[1]) });
  }
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index].status === 'in_progress' || candidates[index].status === 'pending') {
      return candidates[index].id;
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1].id : '';
}
function updatePlanMetadata(input) {
  const planPath = join(specDir, artifacts.implementationPlan);
  withFileWriteLock(planPath, 'runner:plan-metadata', () => {
    let content = '';
    try {
      content = readFileSync(planPath, 'utf8');
    } catch {
      content = [
        '# Implementation Plan',
        '',
        \`Feature: \${taskTitle}\`,
        \`Created: \${input.updatedAt}\`,
        '',
        '## Description',
        '',
        taskDescription,
        '',
      ].join('\\n');
    }
    content = upsertPlanMetadata(content, 'Status', input.status);
    if (input.reviewReason) {
      content = upsertPlanMetadata(content, 'Review Reason', input.reviewReason);
    } else {
      content = removePlanMetadata(content, 'Review Reason');
    }
    content = upsertPlanMetadata(content, 'Execution Phase', input.executionPhase);
    content = upsertPlanMetadata(content, 'Updated', input.updatedAt);
    const currentMachineMetadata = readPlanMachineMetadata(content);
    const machineUpdates = {
      planStatus: input.planStatus,
      xstateState: input.xstateState,
      last_updated: input.updatedAt,
    };
    if (input.directExecution) {
      const directExecutionMetadata = buildDirectCliExecutionMetadata(
        currentMachineMetadata.direct_execution,
        input.directExecution,
        content,
      );
      machineUpdates.direct_execution = directExecutionMetadata;
      content = ensureDirectCliPlanItems(content, directExecutionMetadata);
    }
    content = upsertPlanMachineMetadata(content, machineUpdates);
    writeFileSync(planPath, content.endsWith('\\n') ? content : \`\${content}\\n\`, 'utf8');
  });
}

function upsertPlanMetadata(content, key, value) {
  const line = \`\${key}: \${value}\`;
  const pattern = new RegExp(\`^\${key}:.*$\`, 'm');
  if (pattern.test(content)) {
    return content.replace(pattern, line);
  }
  const lines = content.split(/\\r?\\n/);
  const insertAt = Math.min(lines.findIndex((item, index) => index > 0 && item.trim() === ''), lines.length);
  const safeInsertAt = insertAt < 0 ? lines.length : insertAt;
  lines.splice(safeInsertAt, 0, line);
  return lines.join('\\n');
}

function removePlanMetadata(content, key) {
  const pattern = new RegExp(\`^\${key}:.*(?:\\r?\\n)?\`, 'm');
  return content.replace(pattern, '');
}

function upsertPlanMachineMetadata(content, updates) {
  const pattern = /^<!--\\s*autocode-plan-meta:\\s*(\\{.*\\})\\s*-->\\s*$/m;
  const existingMatch = pattern.exec(content);
  let metadata = {};
  if (existingMatch) {
    try {
      const parsed = JSON.parse(existingMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed;
      }
    } catch {
      metadata = {};
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') {
      delete metadata[key];
    } else {
      metadata[key] = value;
    }
  }

  const line = \`<!-- autocode-plan-meta: \${JSON.stringify(metadata)} -->\`;
  if (existingMatch) {
    return content.replace(pattern, line);
  }

  const lines = content.split(/\\r?\\n/);
  const insertAt = lines.findIndex((item, index) => index > 0 && item.trim() === '');
  const safeInsertAt = insertAt < 0 ? lines.length : insertAt;
  lines.splice(safeInsertAt, 0, line);
  return lines.join('\\n');
}

function appendTaskLogEntry(logPhase, type, message, detail, extra) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  withFileWriteLock(logsPath, 'runner:task-logs:append:' + logPhase, () => {
    const records = [];
    if (!hasTaskLogRecords(logsPath)) {
      records.push(createTaskLogMetaRecord(now));
    }
    records.push({
      record_type: 'phase',
      timestamp: now,
      phase: logPhase,
      status: 'active',
      started_at: now,
      completed_at: null,
    });
    records.push({
      record_type: 'entry',
      entry: {
        timestamp: now,
        type,
        content: limitLogText(message, 4000),
        phase: logPhase,
        ...(detail ? { detail: limitLogText(detail, 12000), collapsed: true } : {}),
        ...(extra ? dropUndefinedTokenUsage(extra) : {}),
      },
    });
    appendTaskLogRecords(logsPath, records);
  });
}

function updateTaskLogs(logPhase, status, message, appendEntry = true) {
  const now = new Date().toISOString();
  const logsPath = join(specDir, artifacts.taskLogs);
  withFileWriteLock(logsPath, 'runner:task-logs:phase:' + logPhase, () => {
    const records = [];
    if (!hasTaskLogRecords(logsPath)) {
      records.push(createTaskLogMetaRecord(now));
    }
    records.push({
      record_type: 'phase',
      timestamp: now,
      phase: logPhase,
      status,
      started_at: now,
      completed_at: status === 'completed' || status === 'failed' ? now : null,
    });
    if (appendEntry && message) {
      records.push({
        record_type: 'entry',
        entry: {
          timestamp: now,
          type: status === 'failed' ? 'error' : status === 'completed' ? 'success' : 'info',
          content: limitLogText(message, 4000),
          phase: logPhase,
        },
      });
    }
    appendTaskLogRecords(logsPath, records);
  });
}

function createTaskLogMetaRecord(now) {
  return {
    record_type: 'meta',
    spec_id: specDir.split(/[\\\\/]/).pop() || taskTitle,
    created_at: now,
    updated_at: now,
  };
}

function appendTaskLogRecords(logsPath, records) {
  if (!records.length) {
    return;
  }
  mkdirSync(dirname(logsPath), { recursive: true });
  appendFileSync(
    logsPath,
    records.map((record) => JSON.stringify(record)).join('\\n') + '\\n',
    'utf8',
  );
}

function hasTaskLogRecords(logsPath) {
  try {
    return existsSync(logsPath) && statSync(logsPath).size > 0;
  } catch {
    return false;
  }
}

function resolveCliJsonEventParser(command, args) {
  return (Array.isArray(cliJsonEventParsers) ? cliJsonEventParsers : []).find((parser) => {
    if (!parser || !isCliCommandOneOf(command, parser.commandNames)) {
      return false;
    }
    const requiredArgs = Array.isArray(parser.requiredArgs) ? parser.requiredArgs : [];
    return requiredArgs.every((arg) => Array.isArray(args) && args.includes(arg));
  }) || null;
}

function getCliJsonEventParserCommandNames(type) {
  const parser = (Array.isArray(cliJsonEventParsers) ? cliJsonEventParsers : [])
    .find((item) => item && item.type === type);
  return Array.isArray(parser?.commandNames) ? parser.commandNames : [];
}



function isCliCommandOneOf(command, names) {
  const commandName = getCliCommandName(command);
  return (Array.isArray(names) ? names : [])
    .map((name) => String(name || '').toLowerCase())
    .includes(commandName);
}

function getCliCommandName(command) {
  return String(command || '').split(/[\\\\/]/).pop().toLowerCase().replace(/\\.cmd$|\\.exe$/, '');
}

function getDirectCliProviderName() {
  const routeId = normalizeDirectCliIdentity(directCliRuntimeRouteId);
  if (routeId) {
    return routeId;
  }
  const normalized = normalizeDirectCliIdentity(cli) || 'custom';
  return normalized + '-cli';
}

function getDirectCliProviderDisplayName() {
  const normalized = String(directCliRuntimeRouteDisplayName || '').trim();
  return normalized || undefined;
}

function getDirectCliProviderDisplayLabel() {
  return getDirectCliProviderDisplayName() || getDirectCliProviderName();
}

function getDirectCliModelId() {
  const normalized = String(directCliModelId || '').trim();
  return normalized || undefined;
}

function normalizeDirectCliIdentity(value) {
  return String(value || '').trim().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function getDirectCliSessionPrefix() {
  return getDirectCliProviderName().replace(/[^A-Za-z0-9_.-]+/g, '-') + '-';
}

function runCliPreflightActions() {
  const actions = Array.isArray(cliPreflightActions) ? cliPreflightActions : [];
  for (const action of actions) {
    if (!action || typeof action !== 'object') {
      continue;
    }
    if (!doesCliPreflightActionApply(action)) {
      continue;
    }
    if (action.type === 'strip-utf8-bom-from-rules') {
      stripUtf8BomFromCliRuleFiles(action);
    }
  }
}

function doesCliPreflightActionApply(action) {
  const commandNames = Array.isArray(action.commandNames) ? action.commandNames : [];
  return commandNames.length === 0 || isCliCommandOneOf(command, commandNames);
}

function stripUtf8BomFromCliRuleFiles(action) {
  const rulesDir = resolveCliPreflightRulesDir(action);
  if (!rulesDir || !existsSync(rulesDir)) {
    return;
  }

  let entries = [];
  try {
    entries = readdirSync(rulesDir, { withFileTypes: true });
  } catch (error) {
    appendTaskLogEntry(logPhase, 'info', 'Unable to inspect CLI rules directory: ' + formatErrorMessage(error));
    return;
  }

  const extension = typeof action.fileExtension === 'string' && action.fileExtension.trim()
    ? action.fileExtension.trim().toLowerCase()
    : '.rules';
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(extension)) {
      continue;
    }
    stripUtf8BomFromCliRuleFile(join(rulesDir, entry.name), action);
  }
}

function resolveCliPreflightRulesDir(action) {
  const explicitDirectory = typeof action.directory === 'string' ? action.directory.trim() : '';
  if (explicitDirectory) {
    return explicitDirectory;
  }

  const childDir = typeof action.childDir === 'string' && action.childDir.trim()
    ? action.childDir.trim()
    : 'rules';
  const envHomeKey = typeof action.envHome === 'string' ? action.envHome.trim() : '';
  const envHome = envHomeKey && typeof process.env[envHomeKey] === 'string'
    ? process.env[envHomeKey].trim()
    : '';
  if (envHome) {
    return join(envHome, childDir);
  }

  const profileHome = typeof process.env.USERPROFILE === 'string' ? process.env.USERPROFILE.trim() : '';
  const unixHome = typeof process.env.HOME === 'string' ? process.env.HOME.trim() : '';
  const home = profileHome || unixHome;
  const homeSubdir = typeof action.homeSubdir === 'string' ? action.homeSubdir.trim() : '';
  return home && homeSubdir ? join(home, homeSubdir, childDir) : '';
}

function stripUtf8BomFromCliRuleFile(filePath, action) {
  const label = typeof action.displayName === 'string' && action.displayName.trim()
    ? action.displayName.trim()
    : 'CLI rules';
  let bytes;
  try {
    bytes = readFileSync(filePath);
  } catch (error) {
    appendTaskLogEntry(logPhase, 'info', 'Unable to read ' + label + ' file: ' + filePath + '. ' + formatErrorMessage(error));
    return;
  }

  if (bytes.length < 3 || bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf) {
    return;
  }

  try {
    writeFileSync(filePath, bytes.subarray(3));
    appendTaskLogEntry(logPhase, 'info', 'Removed UTF-8 BOM from ' + label + ' file: ' + filePath);
  } catch (error) {
    appendTaskLogEntry(
      logPhase,
      'info',
      label + ' file starts with a UTF-8 BOM and may fail to parse: ' + filePath + '. ' + formatErrorMessage(error),
    );
  }
}

function formatErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function localizeMessage(key, fallback, values) {
  if (language !== 'zh-CN') {
    return fallback;
  }
  const phaseText = values?.phase || phase;
  const commandText = values?.command || command;
  switch (key) {
    case 'startCoding':
      return '\u5f00\u59cb\u4f7f\u7528 ' + commandText + ' \u6267\u884c Autocode ' + phaseText + ' \u7f16\u7801\u4efb\u52a1\u3002';
    case 'startPlanning':
      return '\u5f00\u59cb\u4f7f\u7528 ' + commandText + ' \u6267\u884c Autocode ' + phaseText + ' \u89c4\u5212\u4efb\u52a1\u3002';
    case 'completed':
      return 'Autocode CLI \u8fd0\u884c\u5b8c\u6210\u3002';
    case 'commandCompleted':
      return '\u547d\u4ee4\u6267\u884c\u5b8c\u6210';
    case 'commandFailed':
      return '\u547d\u4ee4\u6267\u884c\u5931\u8d25';
    case 'internalCliJsonCollapsed':
      return 'CLI \u5185\u90e8\u4e8b\u4ef6\u65e5\u5fd7\u5df2\u6298\u53e0\u3002';
    default:
      return fallback;
  }
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function getFirstString(record, keys) {
  const source = asRecord(record);
  if (!source) {
    return undefined;
  }
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyCliJsonText(value) {
  if (typeof value === 'string') {
    return cleanLogText(value);
  }
  if (value === null || value === undefined) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map((item) => stringifyCliJsonText(item)).filter(Boolean).join('\\n');
  }
  const record = asRecord(value);
  if (record) {
    for (const key of ['text', 'content', 'message', 'output']) {
      if (record[key] !== undefined) {
        const text = stringifyCliJsonText(record[key]);
        if (text) {
          return text;
        }
      }
    }
  }
  try {
    return cleanLogText(JSON.stringify(value));
  } catch {
    return cleanLogText(String(value));
  }
}

function readNumber(value) {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function readOptionalNumber(value) {
  const number = readNumber(value);
  return number > 0 ? number : undefined;
}

function cleanLogText(value) {
  return repairChineseMojibakeText(String(value ?? ''))
    .replace(/\\r\\n/g, '\\n')
    .replace(/\\r/g, '\\n')
    .replace(/\\x1B\\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]/g, '');
}

function foldRepeatedRunnerPromptLines(value) {
  const lines = String(value || '').split('\\n');
  const folded = [];
  let previousKey = '';
  let repeatedCount = 0;

  const flushRepeatedMarker = () => {
    if (repeatedCount <= 0) {
      return;
    }
    folded.push('[... ' + repeatedCount + ' repeated line(s) omitted for prompt budget ...]');
    repeatedCount = 0;
  };

  for (const line of lines) {
    const key = line.trim().replace(/\\s+/g, ' ');
    if (key.length >= RUNNER_REPEATED_LINE_MIN_CHARS && key === previousKey) {
      repeatedCount += 1;
      continue;
    }
    flushRepeatedMarker();
    folded.push(line);
    previousKey = key;
  }

  flushRepeatedMarker();
  return folded.join('\\n');
}

function stripNoisyCliDiagnosticLines(value) {
  return String(value ?? '')
    .split('\\n')
    .filter((line) => !isNoisyCliDiagnosticLine(line))
    .join('\\n')
    .replace(/\\n{3,}/g, '\\n\\n');
}

function isNoisyCliDiagnosticLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed) {
    return false;
  }

  const message = trimmed.replace(/^\\d{4}-\\d{2}-\\d{2}T[^\\s]+\\s+/, '').trim();
  return NOISY_CLI_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(message));
}

function limitLogText(value, maxLength) {
  const text = foldRepeatedRunnerPromptLines(cleanLogText(value));
  return text.length > maxLength ? text.slice(0, maxLength - 3) + '...' : text;
}

function emitPhase(phase, message, progress) {
  process.stdout.write('__EXEC_PHASE__:' + JSON.stringify({ phase, message, progress }) + '\\n');
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  const tmpPath = filePath + '.tmp';
  const serialized = \`\${JSON.stringify(value, null, 2)}\\n\`;
  JSON.parse(serialized);
  try {
    writeFileSync(tmpPath, serialized, 'utf8');
    JSON.parse(readFileSync(tmpPath, 'utf8'));
    renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failures and rethrow the original write failure.
    }
    throw error;
  }
}
`;
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function isCodingRunPhase(phase: AutocodeTaskRunPhase): boolean {
  return phase === 'coding' || phase === 'direct';
}
