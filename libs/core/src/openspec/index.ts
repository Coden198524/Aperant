import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path';
import { AUTOCODE_TASK_ARTIFACTS, normalizeAutocodeProjectDataDirName } from '../tasks/artifacts.js';
import {
  loadAutocodeImplementationPlanSync,
  parseAutocodeImplementationPlanMarkdown,
  saveAutocodeImplementationPlanSync,
} from '../tasks/plan-store.js';
import type { MutableAutocodePlan, MutableAutocodePlanPhase, MutableAutocodePlanSubtask } from '../tasks/plan-file.js';
import {
  loadAutocodeTaskRequirementsSync,
  saveAutocodeTaskRequirementsSync,
} from '../tasks/requirements-store.js';
import {
  inferAutocodeRuntimeFileWriteLockScopeFromSpecDir,
  withAutocodeRuntimeFileWriteLockSync,
} from '../runtime/workspace-claims.js';
import {
  analyzeAutocodeWorkDependencies,
  describeAutocodeWorkDependencyBlockers,
} from '../runtime/work-dependencies.js';
import {
  createAutocodeTask,
  getAutocodeSpecDir,
  listAutocodeTasks,
  slugifySpecTitle,
  type AutocodeTask,
  type AutocodeTaskCreationArtifacts,
  type AutocodeTaskCreationContext,
  type AutocodeTaskMetadata,
  type AutocodeTaskRequirements,
} from '../tasks/spec-store.js';
import { resolveAutocodeTaskRuntimeConcurrency } from '../runtime/concurrency.js';

export const OPENSPEC_DIR_NAME = 'openspec';
export const OPENSPEC_CHANGES_DIR_NAME = 'changes';
export const OPENSPEC_SPECS_DIR_NAME = 'specs';
export const OPENSPEC_PROPOSAL_FILE_NAME = 'proposal.md';
export const OPENSPEC_DESIGN_FILE_NAME = 'design.md';
export const OPENSPEC_TASKS_FILE_NAME = 'tasks.md';
export const OPENSPEC_DEFAULT_SCHEMA = 'spec-driven';

const OPENSPEC_SPEC_DRIVEN_ARTIFACT_ORDER = ['proposal', 'design', 'specs', 'tasks'] as const;

export interface OpenSpecArtifact {
  fileName: string;
  relativePath: string;
  absolutePath: string;
  content: string;
}

export interface OpenSpecSpecDelta extends OpenSpecArtifact {
  capability: string;
}

export interface OpenSpecChangeSource {
  changeId: string;
  changeDir: string;
  relativeChangeDir: string;
  proposal?: OpenSpecArtifact;
  design?: OpenSpecArtifact;
  tasks?: OpenSpecArtifact;
  specDeltas: OpenSpecSpecDelta[];
  title: string;
  summary: string;
  scaffold?: OpenSpecCliCommandResult;
  validation?: OpenSpecCliCommandResult;
}

export interface OpenSpecChangeSourceInput {
  projectRoot: string;
  changeId?: string;
  changeDir?: string;
}

export interface CreateAutocodeTaskFromOpenSpecChangeInput extends OpenSpecChangeSourceInput {
  dataDirName?: string;
  title?: string;
  specId?: string;
  overwrite?: boolean;
  now?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  prepareSpecArtifacts?: (context: AutocodeTaskCreationContext) => AutocodeTaskCreationArtifacts | void;
}

export interface CreateOpenSpecChangeDraftInput {
  projectRoot: string;
  title: string;
  description: string;
  language?: string;
  changeId?: string;
  capability?: string;
  overwrite?: boolean;
  now?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  openSpecCli?: OpenSpecCliAdapter | false;
  openSpecSchema?: string;
}

export interface CreateGeneratedOpenSpecChangeDraftInput extends CreateOpenSpecChangeDraftInput {
  artifactGenerator: OpenSpecArtifactGenerator;
  requireOpenSpecProtocol?: boolean;
  validateOpenSpec?: boolean;
  onProgress?: OpenSpecArtifactProgressHandler;
}

export interface CreateAutocodeTaskFromOpenSpecDraftInput extends CreateOpenSpecChangeDraftInput {
  dataDirName?: string;
  specId?: string;
  prepareSpecArtifacts?: (context: AutocodeTaskCreationContext) => AutocodeTaskCreationArtifacts | void;
}

export interface CreateAutocodeTaskFromGeneratedOpenSpecDraftInput extends CreateGeneratedOpenSpecChangeDraftInput {
  dataDirName?: string;
  specId?: string;
  prepareSpecArtifacts?: (context: AutocodeTaskCreationContext) => AutocodeTaskCreationArtifacts | void;
}

export interface EnsureOpenSpecArtifactsForAutocodeTaskInput extends OpenSpecChangeSourceInput {
  dataDirName?: string;
  taskId: string;
  language?: string;
  overwrite?: boolean;
  now?: string;
  reviewFeedback?: string;
  requireOpenSpecProtocol?: boolean;
  openSpecCli?: OpenSpecCliAdapter | false;
  openSpecSchema?: string;
  artifactGenerator: OpenSpecArtifactGenerator;
  validateOpenSpec?: boolean;
  onProgress?: OpenSpecArtifactProgressHandler;
}

export interface SyncOpenSpecTasksFromAutocodePlanInput {
  specDir: string;
  projectRoot?: string;
}

export interface SyncOpenSpecTasksFromAutocodePlanResult {
  changed: boolean;
  tasksPath?: string;
  updatedCount: number;
}

export interface AutocodeOpenSpecTaskPlan {
  title: string;
  description: string;
  specMarkdown: string;
  implementationPlan: MutableAutocodePlan;
  metadata: AutocodeTaskMetadata;
  requirements: AutocodeTaskRequirements;
}

export interface AutocodeOpenSpecTaskResult {
  task: AutocodeTask;
  change: OpenSpecChangeSource;
  plan: AutocodeOpenSpecTaskPlan;
}

export interface EnsureOpenSpecArtifactsForAutocodeTaskResult {
  task: AutocodeTask;
  change?: OpenSpecChangeSource;
  plan?: AutocodeOpenSpecTaskPlan;
  generated: boolean;
}

export interface OpenSpecCreateChangeCliInput {
  projectRoot: string;
  changeId: string;
  description: string;
  schema?: string;
}

export interface OpenSpecChangeCliInput {
  projectRoot: string;
  changeId: string;
  schema?: string;
}

export interface OpenSpecArtifactInstructionsCliInput extends OpenSpecChangeCliInput {
  artifactId: string;
}

export interface OpenSpecValidateChangeCliInput extends OpenSpecChangeCliInput {
  strict?: boolean;
  json?: boolean;
}

export interface OpenSpecCliCommandResult {
  command: string;
  args: string[];
  cwd: string;
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface OpenSpecCliJsonCommandResult<T> extends OpenSpecCliCommandResult {
  data: T;
}

export interface OpenSpecChangeStatusArtifact {
  id: string;
  outputPath?: string;
  status?: string;
  missingDeps?: string[];
  [key: string]: unknown;
}

export interface OpenSpecChangeStatus {
  changeName?: string;
  schemaName?: string;
  isComplete?: boolean;
  applyRequires?: string[];
  artifacts?: OpenSpecChangeStatusArtifact[];
  [key: string]: unknown;
}

export interface OpenSpecArtifactInstructions {
  artifact?: string;
  artifactId?: string;
  outputPath?: string;
  template?: string;
  instruction?: string;
  context?: string;
  rules?: string[] | string;
  dependencies?: unknown;
  [key: string]: unknown;
}

export interface OpenSpecGeneratedArtifact {
  content: string;
  outputPath?: string;
  capability?: string;
}

export type OpenSpecArtifactProgressStage =
  | 'artifact_start'
  | 'artifact_model_start'
  | 'artifact_model_delta'
  | 'artifact_heartbeat'
  | 'artifact_model_complete'
  | 'artifact_complete'
  | 'artifact_retry'
  | 'artifact_failed';

export interface OpenSpecArtifactProgress {
  stage: OpenSpecArtifactProgressStage;
  artifactId: string;
  outputPath: string;
  changeId: string;
  capability: string;
  artifactIndex?: number;
  totalArtifacts?: number;
  attempt?: number;
  generatedChars?: number;
  elapsedMs?: number;
  modelId?: string;
  error?: string;
}

export type OpenSpecArtifactProgressHandler = (event: OpenSpecArtifactProgress) => void;

export interface OpenSpecArtifactGeneratorInput {
  projectRoot: string;
  changeId: string;
  changeDir: string;
  language?: string;
  artifactId: string;
  title: string;
  description: string;
  capability: string;
  outputPath: string;
  now: string;
  schema: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  instructions: OpenSpecArtifactInstructions;
  dependencies: OpenSpecArtifact[];
  existingArtifacts: OpenSpecArtifact[];
  artifactIndex?: number;
  totalArtifacts?: number;
  attempt?: number;
  onProgress?: OpenSpecArtifactProgressHandler;
}

export interface OpenSpecArtifactGenerator {
  generateArtifact(input: OpenSpecArtifactGeneratorInput): Promise<string | OpenSpecGeneratedArtifact>;
}

export interface OpenSpecCliAdapter {
  createChange(input: OpenSpecCreateChangeCliInput): OpenSpecCliCommandResult;
  getStatus?(input: OpenSpecChangeCliInput): OpenSpecCliJsonCommandResult<OpenSpecChangeStatus>;
  getInstructions?(input: OpenSpecArtifactInstructionsCliInput): OpenSpecCliJsonCommandResult<OpenSpecArtifactInstructions>;
  validateChange?(input: OpenSpecValidateChangeCliInput): OpenSpecCliCommandResult;
}

export interface ProcessOpenSpecCliAdapterOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface DetectOpenSpecCliOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
}

export interface OpenSpecCliDetectionResult {
  found: boolean;
  command: string;
  displayCommand: string;
  version?: string;
  message: string;
}

export function getOpenSpecDir(projectRoot: string): string {
  return join(projectRoot, OPENSPEC_DIR_NAME);
}

export function getOpenSpecChangesDir(projectRoot: string): string {
  return join(getOpenSpecDir(projectRoot), OPENSPEC_CHANGES_DIR_NAME);
}

export function getOpenSpecSpecsDir(projectRoot: string): string {
  return join(getOpenSpecDir(projectRoot), OPENSPEC_SPECS_DIR_NAME);
}

export function getOpenSpecChangeDir(projectRoot: string, changeId: string): string {
  assertValidOpenSpecChangeId(changeId);
  return join(getOpenSpecChangesDir(projectRoot), changeId);
}

export function listOpenSpecChanges(projectRoot: string): string[] {
  const changesDir = getOpenSpecChangesDir(projectRoot);
  if (!existsSync(changesDir)) {
    return [];
  }

  return readdirSync(changesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isOpenSpecChangeId(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function createProcessOpenSpecCliAdapter(
  options: ProcessOpenSpecCliAdapterOptions = {},
): OpenSpecCliAdapter {
  return {
    createChange(input) {
      const schema = input.schema?.trim() || OPENSPEC_DEFAULT_SCHEMA;
      const openSpecArgs = [
        'new',
        'change',
        '--description',
        input.description,
        '--schema',
        schema,
        input.changeId,
      ];
      return runProcessOpenSpecCommand(openSpecArgs, input.projectRoot, options);
    },
    getStatus(input) {
      const args = [
        'status',
        '--change',
        input.changeId,
        '--schema',
        input.schema?.trim() || OPENSPEC_DEFAULT_SCHEMA,
        '--json',
      ];
      const result = runProcessOpenSpecCommand(args, input.projectRoot, options);
      return {
        ...result,
        data: parseOpenSpecJson<OpenSpecChangeStatus>(result, 'OpenSpec status'),
      };
    },
    getInstructions(input) {
      const args = [
        'instructions',
        input.artifactId,
        '--change',
        input.changeId,
        '--schema',
        input.schema?.trim() || OPENSPEC_DEFAULT_SCHEMA,
        '--json',
      ];
      const result = runProcessOpenSpecCommand(args, input.projectRoot, options);
      return {
        ...result,
        data: parseOpenSpecJson<OpenSpecArtifactInstructions>(result, `OpenSpec ${input.artifactId} instructions`),
      };
    },
    validateChange(input) {
      const args = [
        'validate',
        input.changeId,
        '--type',
        'change',
        ...(input.strict === false ? [] : ['--strict']),
        ...(input.json === false ? [] : ['--json']),
      ];
      return runProcessOpenSpecCommand(args, input.projectRoot, options);
    },
  };
}

export function getOpenSpecInstallCommand(): string {
  return 'npm install -g @fission-ai/openspec@latest';
}

export function detectOpenSpecCli(
  options: DetectOpenSpecCliOptions = {},
): OpenSpecCliDetectionResult {
  const env = { ...process.env, ...options.env };
  const invocation = resolveOpenSpecCliInvocation(options.command, env);
  const result = spawnSync(invocation.command, [...invocation.argsPrefix, '--version'], {
    cwd: options.cwd ?? process.cwd(),
    encoding: 'utf8',
    env,
    timeout: options.timeoutMs ?? 5_000,
  });

  if (result.error) {
    return {
      found: false,
      command: invocation.command,
      displayCommand: invocation.displayCommand,
      message: `OpenSpec CLI not found: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim() || `exit code ${result.status}`;
    return {
      found: false,
      command: invocation.command,
      displayCommand: invocation.displayCommand,
      message: `OpenSpec CLI check failed: ${detail}`,
    };
  }

  const version = (result.stdout || result.stderr || '').trim().split(/\r?\n/)[0]?.trim();
  return {
    found: true,
    command: invocation.command,
    displayCommand: invocation.displayCommand,
    version: version || undefined,
    message: `Using OpenSpec CLI: ${invocation.displayCommand}`,
  };
}

export function readOpenSpecChangeSource(input: OpenSpecChangeSourceInput): OpenSpecChangeSource {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const resolvedProjectRoot = resolve(projectRoot);
  const changeDir = resolveOpenSpecChangeDir(resolvedProjectRoot, input);
  const changeId = input.changeId?.trim() || basename(changeDir);
  assertValidOpenSpecChangeId(changeId);

  if (!existsSync(changeDir)) {
    throw new Error(`OpenSpec change not found: ${changeId}`);
  }

  const relativeChangeDir = toProjectRelativePath(resolvedProjectRoot, changeDir);
  const proposal = readOpenSpecArtifact(resolvedProjectRoot, changeDir, OPENSPEC_PROPOSAL_FILE_NAME);
  const design = readOpenSpecArtifact(resolvedProjectRoot, changeDir, OPENSPEC_DESIGN_FILE_NAME);
  const tasks = readOpenSpecArtifact(resolvedProjectRoot, changeDir, OPENSPEC_TASKS_FILE_NAME);
  const specDeltas = collectOpenSpecSpecDeltas(resolvedProjectRoot, changeDir);

  if (!proposal && !design && !tasks && specDeltas.length === 0) {
    throw new Error(`OpenSpec change ${changeId} has no supported artifacts.`);
  }

  const title = inferOpenSpecChangeTitle(changeId, proposal, design, specDeltas);
  const summary = firstMarkdownParagraph(proposal?.content)
    || firstMarkdownParagraph(design?.content)
    || `Implement OpenSpec change ${changeId}.`;

  return {
    changeId,
    changeDir,
    relativeChangeDir,
    ...(proposal ? { proposal } : {}),
    ...(design ? { design } : {}),
    ...(tasks ? { tasks } : {}),
    specDeltas,
    title,
    summary,
  };
}

export function buildAutocodeTaskFromOpenSpecChangePlan(
  change: OpenSpecChangeSource,
  input: Pick<CreateAutocodeTaskFromOpenSpecChangeInput, 'title' | 'metadata' | 'requirements' | 'now'> = {},
): AutocodeOpenSpecTaskPlan {
  const now = input.now ?? new Date().toISOString();
  const title = input.title?.trim() || `Implement OpenSpec change: ${change.title}`;
  const language = resolveOpenSpecLanguage(input.metadata?.language, input.metadata);
  const description = buildOpenSpecTaskDescription(change, language);
  const metadataBase: AutocodeTaskMetadata = {
    category: 'feature',
    priority: 'high',
    impact: 'high',
    complexity: inferOpenSpecChangeComplexity(change),
    workflowMode: 'balanced',
    ...input.metadata,
    sourceType: 'openspec',
    openSpecChangeId: change.changeId,
    openSpecChangeDir: change.relativeChangeDir,
    openSpecProposalPath: change.proposal?.relativePath,
    openSpecDesignPath: change.design?.relativePath,
    openSpecTasksPath: change.tasks?.relativePath,
    openSpecSpecDeltaPaths: change.specDeltas.map((delta) => delta.relativePath),
    openSpecScaffoldCommand: change.scaffold ? formatOpenSpecCliInvocation(change.scaffold) : undefined,
    openSpecValidationCommand: change.validation ? formatOpenSpecCliInvocation(change.validation) : undefined,
    upstreamSpecSystem: 'openspec',
    downstreamExecutionSystem: 'autocode',
  };
  const metadata: AutocodeTaskMetadata = {
    ...metadataBase,
    runtimeConcurrency: resolveAutocodeTaskRuntimeConcurrency(metadataBase),
  };
  const requirements: AutocodeTaskRequirements = {
    ...input.requirements,
    task_description: description,
    workflow_type: metadata.category ?? 'feature',
    user_requirements: mergeRequirementList(input.requirements?.user_requirements, [
      `Implement OpenSpec change \`${change.changeId}\`.`,
      'Use OpenSpec artifacts as the upstream source of truth.',
      'Use Autocode files only as downstream runtime state.',
    ]),
    acceptance_criteria: mergeRequirementList(input.requirements?.acceptance_criteria, [
      'The implementation satisfies the OpenSpec proposal, design notes, tasks, and spec deltas.',
      'Autocode runtime plan subtasks are completed or explicitly blocked with evidence.',
      'Verification evidence is recorded in the Autocode plan, logs, or QA report.',
    ]),
    constraints: mergeRequirementList(input.requirements?.constraints, [
      'Do not regenerate or duplicate OpenSpec proposal, design, or spec delta documents.',
      'Do not treat Autocode spec.md as the long-lived product specification.',
      'When upstream OpenSpec and downstream Autocode files disagree, follow OpenSpec and record the drift.',
    ]),
    created_at: now,
    openspec: {
      change_id: change.changeId,
      change_dir: change.relativeChangeDir,
      proposal: change.proposal?.relativePath,
      design: change.design?.relativePath,
      tasks: change.tasks?.relativePath,
      spec_deltas: change.specDeltas.map((delta) => ({
        capability: delta.capability,
        path: delta.relativePath,
      })),
      scaffold_command: change.scaffold ? formatOpenSpecCliInvocation(change.scaffold) : undefined,
      validation_command: change.validation ? formatOpenSpecCliInvocation(change.validation) : undefined,
    },
  };

  return {
    title,
    description,
    specMarkdown: buildOpenSpecExecutionSpecMarkdown(change, title, description, language),
    implementationPlan: buildOpenSpecRuntimeImplementationPlan(change, {
      title,
      description,
      now,
      language,
    }),
    metadata,
    requirements,
  };
}

export function createOpenSpecChangeDraft(input: CreateOpenSpecChangeDraftInput): OpenSpecChangeSource {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const title = requireNonEmpty(input.title || truncateTitle(input.description), 'title');
  const description = requireNonEmpty(input.description, 'description');
  const changeId = input.changeId?.trim()
    ? normalizeOpenSpecChangeId(input.changeId)
    : nextOpenSpecChangeId(projectRoot, slugifySpecTitle(title) || slugifySpecTitle(description) || 'change');
  assertValidOpenSpecChangeId(changeId);

  const changeDir = getOpenSpecChangeDir(projectRoot, changeId);
  const changeAlreadyExists = existsSync(changeDir);
  if (changeAlreadyExists && input.overwrite !== true) {
    throw new Error(`OpenSpec change already exists: ${changeId}`);
  }

  const now = input.now ?? new Date().toISOString();
  const language = resolveOpenSpecLanguage(input.language, input.metadata);
  const scaffold = changeAlreadyExists
    ? undefined
    : scaffoldOpenSpecChange(input.openSpecCli, {
      projectRoot,
      changeId,
      description,
      schema: input.openSpecSchema,
    });
  const capability = normalizeOpenSpecCapability(input.capability)
    || normalizeOpenSpecCapability(stringFrom(input.metadata?.openSpecCapability))
    || normalizeOpenSpecCapability(stringFrom(input.metadata?.category))
    || 'project';
  const proposalPath = join(changeDir, OPENSPEC_PROPOSAL_FILE_NAME);
  const designPath = join(changeDir, OPENSPEC_DESIGN_FILE_NAME);
  const tasksPath = join(changeDir, OPENSPEC_TASKS_FILE_NAME);
  const specDeltaPath = join(changeDir, OPENSPEC_SPECS_DIR_NAME, capability, 'spec.md');

  mkdirSync(dirname(proposalPath), { recursive: true });
  mkdirSync(dirname(specDeltaPath), { recursive: true });
  writeFileSync(proposalPath, buildOpenSpecProposalMarkdown({ changeId, title, description, now, language, metadata: input.metadata, requirements: input.requirements }), 'utf8');
  writeFileSync(designPath, buildOpenSpecDesignMarkdown({ title, description, now, language, metadata: input.metadata, requirements: input.requirements }), 'utf8');
  writeFileSync(tasksPath, buildOpenSpecTasksMarkdown({ title, description, now, language, metadata: input.metadata, requirements: input.requirements }), 'utf8');
  writeFileSync(specDeltaPath, buildOpenSpecSpecDeltaMarkdown({ title, description, capability, now, language, metadata: input.metadata, requirements: input.requirements }), 'utf8');

  return {
    ...readOpenSpecChangeSource({ projectRoot, changeId }),
    ...(scaffold ? { scaffold } : {}),
  };
}

export async function createOpenSpecChangeDraftWithGeneratedArtifacts(
  input: CreateGeneratedOpenSpecChangeDraftInput,
): Promise<OpenSpecChangeSource> {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const title = requireNonEmpty(input.title || truncateTitle(input.description), 'title');
  const description = requireNonEmpty(input.description, 'description');
  const changeId = input.changeId?.trim()
    ? normalizeOpenSpecChangeId(input.changeId)
    : nextOpenSpecChangeId(projectRoot, slugifySpecTitle(title) || slugifySpecTitle(description) || 'change');
  assertValidOpenSpecChangeId(changeId);

  const changeDir = getOpenSpecChangeDir(projectRoot, changeId);
  const changeAlreadyExists = existsSync(changeDir);
  if (changeAlreadyExists && input.overwrite !== true) {
    throw new Error(`OpenSpec change already exists: ${changeId}`);
  }

  const now = input.now ?? new Date().toISOString();
  const language = resolveOpenSpecLanguage(input.language, input.metadata);
  const schema = input.openSpecSchema?.trim() || OPENSPEC_DEFAULT_SCHEMA;
  const cli = input.openSpecCli === false
    ? undefined
    : input.openSpecCli ?? createProcessOpenSpecCliAdapter();
  const scaffold = changeAlreadyExists
    ? undefined
    : scaffoldOpenSpecChange(cli ?? false, {
      projectRoot,
      changeId,
      description,
      schema,
    });
  const capability = normalizeOpenSpecCapability(input.capability)
    || normalizeOpenSpecCapability(stringFrom(input.metadata?.openSpecCapability))
    || normalizeOpenSpecCapability(stringFrom(input.metadata?.category))
    || 'project';

  await writeGeneratedOpenSpecArtifacts({
    projectRoot,
    changeId,
    changeDir,
    title,
    description,
    capability,
    now,
    language,
    schema,
    metadata: input.metadata,
    requirements: input.requirements,
    cli,
    requireOpenSpecProtocol: input.requireOpenSpecProtocol === true,
    artifactGenerator: input.artifactGenerator,
    onProgress: input.onProgress,
  });

  const validation = input.validateOpenSpec === false || !cli?.validateChange
    ? undefined
    : cli.validateChange({
      projectRoot,
      changeId,
      schema,
      strict: true,
      json: true,
    });

  return {
    ...readOpenSpecChangeSource({ projectRoot, changeId }),
    ...(scaffold ? { scaffold } : {}),
    ...(validation ? { validation } : {}),
  };
}

export function createAutocodeTaskFromOpenSpecDraft(
  input: CreateAutocodeTaskFromOpenSpecDraftInput,
): AutocodeOpenSpecTaskResult {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const change = createOpenSpecChangeDraft(input);
  const metadata: AutocodeTaskMetadata = {
    ...input.metadata,
    openSpecGenerationMode: 'template',
  };
  return createAutocodeTaskFromResolvedOpenSpecChange(projectRoot, dataDirName, change, {
    ...input,
    metadata,
    title: input.title?.trim() || change.title,
  });
}

export async function createAutocodeTaskFromOpenSpecDraftWithGeneratedArtifacts(
  input: CreateAutocodeTaskFromGeneratedOpenSpecDraftInput,
): Promise<AutocodeOpenSpecTaskResult> {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const metadata: AutocodeTaskMetadata = {
    ...input.metadata,
    openSpecGenerationMode: 'ai',
  };
  const change = await createOpenSpecChangeDraftWithGeneratedArtifacts({
    ...input,
    metadata,
  });
  return createAutocodeTaskFromResolvedOpenSpecChange(projectRoot, dataDirName, change, {
    ...input,
    metadata,
    title: input.title?.trim() || change.title,
  });
}

export async function ensureOpenSpecArtifactsForAutocodeTask(
  input: EnsureOpenSpecArtifactsForAutocodeTaskInput,
): Promise<EnsureOpenSpecArtifactsForAutocodeTaskResult> {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const task = listAutocodeTasks({ projectRoot, dataDirName })
    .find((candidate) => candidate.id === input.taskId || candidate.specId === input.taskId);

  if (!task) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const metadata = task.metadata ?? {};
  if (metadata.sourceType !== 'openspec') {
    return { task, generated: false };
  }

  if (input.overwrite !== true && hasCompleteOpenSpecArtifactSet(projectRoot, metadata)) {
    return { task, generated: false };
  }

  const specDir = getAutocodeSpecDir({
    projectRoot,
    dataDirName,
    specId: task.specId,
  });
  const now = input.now ?? new Date().toISOString();
  const reviewFeedback = normalizeOpenSpecReviewFeedback(input.reviewFeedback)
    || readOpenSpecReviewFeedback(specDir);
  const requireOpenSpecProtocol = input.requireOpenSpecProtocol === true || Boolean(reviewFeedback);
  const changeId = normalizeOpenSpecChangeId(stringFrom(metadata.openSpecChangeId) || task.specId || task.title);
  const language = resolveOpenSpecLanguage(input.language, metadata);
  const currentRequirements = loadAutocodeTaskRequirementsSync(specDir) ?? {};
  const recoveredChange = input.overwrite !== true && !reviewFeedback
    ? tryReadCompleteOpenSpecChange({ projectRoot, changeId })
    : null;

  if (recoveredChange) {
    const recoveredMetadata: AutocodeTaskMetadata = {
      ...metadata,
      sourceType: 'openspec',
      openSpecChangeId: recoveredChange.changeId,
      openSpecGenerationMode: metadata.openSpecGenerationMode && metadata.openSpecGenerationMode !== 'deferred'
        ? metadata.openSpecGenerationMode
        : 'ai',
      upstreamSpecSystem: 'openspec',
      downstreamExecutionSystem: 'autocode',
      ...(language ? { language } : {}),
    };
    const recoveredPlan = buildAutocodeTaskFromOpenSpecChangePlan(recoveredChange, {
      title: task.title,
      metadata: recoveredMetadata,
      requirements: currentRequirements,
      now,
    });
    writeOpenSpecRuntimeTaskFiles(specDir, recoveredChange, recoveredPlan, language);

    const refreshed = listAutocodeTasks({ projectRoot, dataDirName })
      .find((candidate) => candidate.id === task.id || candidate.specId === task.specId);

    return {
      task: refreshed ?? task,
      change: recoveredChange,
      plan: recoveredPlan,
      generated: true,
    };
  }

  const requirements = mergeOpenSpecReviewFeedbackIntoRequirements(
    currentRequirements,
    reviewFeedback,
    now,
    language,
  );
  const generationMetadata: AutocodeTaskMetadata = {
    ...metadata,
    sourceType: 'openspec',
    openSpecChangeId: changeId,
    openSpecGenerationMode: 'ai',
    openSpecGeneratedAt: now,
    ...(language ? { language } : {}),
    upstreamSpecSystem: 'openspec',
    downstreamExecutionSystem: 'autocode',
    ...(reviewFeedback ? {
      openSpecReviewFeedback: reviewFeedback,
      openSpecReviewFeedbackUpdatedAt: now,
    } : {}),
  };
  const change = await createOpenSpecChangeDraftWithGeneratedArtifacts({
    projectRoot,
    title: task.title,
    description: buildOpenSpecGenerationDescription(task.description, reviewFeedback, language),
    language,
    changeId,
    overwrite: true,
    now,
    metadata: generationMetadata,
    requirements,
    openSpecCli: input.openSpecCli,
    openSpecSchema: input.openSpecSchema,
    artifactGenerator: input.artifactGenerator,
    requireOpenSpecProtocol,
    validateOpenSpec: input.validateOpenSpec,
    onProgress: input.onProgress,
  });
  const plan = buildAutocodeTaskFromOpenSpecChangePlan(change, {
    title: task.title,
    metadata: generationMetadata,
    requirements,
    now,
  });

  writeOpenSpecRuntimeTaskFiles(specDir, change, plan, language);

  const refreshed = listAutocodeTasks({ projectRoot, dataDirName })
    .find((candidate) => candidate.id === task.id || candidate.specId === task.specId);

  return {
    task: refreshed ?? task,
    change,
    plan,
    generated: true,
  };
}

export function syncOpenSpecTasksFromAutocodePlan(
  input: SyncOpenSpecTasksFromAutocodePlanInput,
): SyncOpenSpecTasksFromAutocodePlanResult {
  const resolvedSpecDirOrPlanPath = resolve(input.specDir);
  const specDir = basename(resolvedSpecDirOrPlanPath) === AUTOCODE_TASK_ARTIFACTS.implementationPlan
    ? dirname(resolvedSpecDirOrPlanPath)
    : resolvedSpecDirOrPlanPath;
  const metadata = readJson<AutocodeTaskMetadata>(join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata));
  if (metadata?.sourceType !== 'openspec' || typeof metadata.openSpecTasksPath !== 'string') {
    return { changed: false, updatedCount: 0 };
  }

  const projectRoot = input.projectRoot?.trim()
    ? resolve(input.projectRoot)
    : inferProjectRootFromSpecDir(specDir);
  const tasksPath = resolve(projectRoot, metadata.openSpecTasksPath);
  assertPathWithinProject(projectRoot, tasksPath, 'openSpecTasksPath');
  if (!existsSync(tasksPath)) {
    return { changed: false, tasksPath, updatedCount: 0 };
  }

  const lockScope = inferAutocodeRuntimeFileWriteLockScopeFromSpecDir(specDir);
  const statusById = withAutocodeRuntimeFileWriteLockSync(
    {
      ...lockScope,
      filePath: join(specDir, AUTOCODE_TASK_ARTIFACTS.implementationPlan),
      ownerId: `openspec-sync:${metadata.openSpecChangeId ?? metadata.openSpecTasksPath}:plan`,
    },
    () => {
      const plan = loadAutocodeImplementationPlanSync(specDir);
      if (!plan) {
        return null;
      }

      const statusById = buildPlanTaskStatusMap(plan);
      if (statusById.size === 0) {
        return null;
      }

      return statusById;
    },
  );

  if (!statusById) {
    return { changed: false, tasksPath, updatedCount: 0 };
  }

  return withAutocodeRuntimeFileWriteLockSync(
    {
      ...lockScope,
      filePath: tasksPath,
      ownerId: `openspec-sync:${metadata.openSpecChangeId ?? metadata.openSpecTasksPath}:tasks`,
    },
    () => syncOpenSpecTasksFile(tasksPath, statusById),
  );
}

function syncOpenSpecTasksFile(
  tasksPath: string,
  statusById: Map<string, string>,
): SyncOpenSpecTasksFromAutocodePlanResult {
  const original = readFileSync(tasksPath, 'utf8');
  populateParentOpenSpecTaskStatuses(original, statusById);
  let updatedCount = 0;
  const updated = original.replace(
    /^(\s*-\s+\[)([ xX/!\-])(\]\s+)([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(\.?)(\s+.+)$/gm,
    (line, prefix: string, marker: string, suffix: string, id: string, dot: string, rest: string) => {
      const status = statusById.get(id);
      if (!status) {
        return line;
      }
      const nextMarker = status === 'completed' ? 'x' : ' ';
      if (marker !== nextMarker) {
        updatedCount += 1;
      }
      return `${prefix}${nextMarker}${suffix}${id}${dot}${rest}`;
    },
  );

  if (updated === original) {
    return { changed: false, tasksPath, updatedCount: 0 };
  }

  writeFileSync(tasksPath, updated, 'utf8');
  return { changed: true, tasksPath, updatedCount };
}

function populateParentOpenSpecTaskStatuses(content: string, statusById: Map<string, string>): void {
  const taskIds = [...content.matchAll(/^\s*-\s+\[[ xX/!\-]\]\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\.?)\s+.+$/gm)]
    .map((match) => match[1])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  for (const taskId of taskIds) {
    if (statusById.has(taskId)) {
      continue;
    }
    const children = taskIds.filter((candidate) => candidate !== taskId && candidate.startsWith(`${taskId}.`));
    if (children.length === 0 || children.some((childId) => !statusById.has(childId))) {
      continue;
    }
    statusById.set(
      taskId,
      children.every((childId) => statusById.get(childId) === 'completed') ? 'completed' : 'pending',
    );
  }
}

function readOpenSpecReviewFeedback(specDir: string): string {
  try {
    const humanInputPath = join(specDir, 'HUMAN_INPUT.md');
    if (!existsSync(humanInputPath)) {
      return '';
    }
    return normalizeOpenSpecReviewFeedback(readFileSync(humanInputPath, 'utf8'));
  } catch {
    return '';
  }
}

function normalizeOpenSpecReviewFeedback(value: unknown): string {
  const content = stringFrom(value);
  if (!content) {
    return '';
  }
  const requestedChanges = markdownSection(content, 'Requested Changes');
  return (requestedChanges || content).trim();
}

function markdownSection(content: string, title: string): string {
  const target = title.toLowerCase();
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const sectionLines: string[] = [];
  let inSection = false;

  for (const line of lines) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (inSection) {
        break;
      }
      inSection = heading[1].trim().toLowerCase() === target;
      continue;
    }

    if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.join('\n').trim();
}

function mergeOpenSpecReviewFeedbackIntoRequirements(
  requirements: AutocodeTaskRequirements,
  reviewFeedback: string,
  now: string,
  language?: string,
): AutocodeTaskRequirements {
  if (!reviewFeedback) {
    return requirements;
  }

  return {
    ...requirements,
    user_requirements: mergeRequirementList(requirements.user_requirements, [
      isChineseLanguage(language)
        ? `计划审核要求：${singleLine(reviewFeedback)}`
        : `Plan review requested: ${singleLine(reviewFeedback)}`,
    ]),
    plan_review_feedback: reviewFeedback,
    plan_review_feedback_updated_at: now,
  };
}

function buildOpenSpecGenerationDescription(description: string, reviewFeedback: string, language?: string): string {
  if (!reviewFeedback) {
    return description;
  }

  return [
    description.trim(),
    '',
    isChineseLanguage(language)
      ? '重新生成下游计划前，先应用到上游 OpenSpec 文档的计划审核反馈：'
      : 'Plan review feedback to apply to upstream OpenSpec artifacts before regenerating downstream plans:',
    reviewFeedback,
  ].join('\n');
}

export function createAutocodeTaskFromOpenSpecChange(
  input: CreateAutocodeTaskFromOpenSpecChangeInput,
): AutocodeOpenSpecTaskResult {
  const projectRoot = requireNonEmpty(input.projectRoot, 'projectRoot');
  const dataDirName = normalizeAutocodeProjectDataDirName(input.dataDirName);
  const change = readOpenSpecChangeSource(input);
  return createAutocodeTaskFromResolvedOpenSpecChange(projectRoot, dataDirName, change, input);
}

function tryReadCompleteOpenSpecChange(input: OpenSpecChangeSourceInput): OpenSpecChangeSource | null {
  try {
    const change = readOpenSpecChangeSource(input);
    return isCompleteOpenSpecChangeSource(change) ? change : null;
  } catch {
    return null;
  }
}

function isCompleteOpenSpecChangeSource(change: OpenSpecChangeSource): boolean {
  return Boolean(change.proposal && change.design && change.tasks && change.specDeltas.length > 0);
}

function hasCompleteOpenSpecArtifactSet(projectRoot: string, metadata: AutocodeTaskMetadata): boolean {
  return (
    hasProjectRelativeFile(projectRoot, metadata.openSpecProposalPath)
    && hasProjectRelativeFile(projectRoot, metadata.openSpecDesignPath)
    && hasProjectRelativeFile(projectRoot, metadata.openSpecTasksPath)
    && Array.isArray(metadata.openSpecSpecDeltaPaths)
    && metadata.openSpecSpecDeltaPaths.length > 0
    && metadata.openSpecSpecDeltaPaths.every((path) => hasProjectRelativeFile(projectRoot, path))
  );
}

function hasProjectRelativeFile(projectRoot: string, value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }

  const absolutePath = resolve(projectRoot, value);
  assertPathWithinProject(projectRoot, absolutePath, 'OpenSpec artifact path');
  return existsSync(absolutePath);
}

function inferProjectRootFromSpecDir(specDir: string): string {
  return dirname(dirname(dirname(specDir)));
}

function buildPlanTaskStatusMap(plan: MutableAutocodePlan): Map<string, string> {
  const statusById = new Map<string, string>();
  for (const [phaseIndex, phase] of (plan.phases ?? []).entries()) {
    const phaseId = stringFrom(phase.id ?? phase.phase ?? phaseIndex + 1);
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    if (phaseId && subtasks.length > 0) {
      statusById.set(
        phaseId,
        subtasks.every((subtask) => subtaskCompleted(subtask)) ? 'completed' : 'pending',
      );
    }
    for (const [subtaskIndex, subtask] of subtasks.entries()) {
      const fallbackId = phaseId ? `${phaseId}.${subtaskIndex + 1}` : String(subtaskIndex + 1);
      const subtaskId = stringFrom(subtask.id ?? subtask.subtask_id ?? fallbackId);
      const status = subtaskCompleted(subtask) ? 'completed' : 'pending';
      if (subtaskId) {
        statusById.set(subtaskId, status);
      }
      for (const upstreamTaskId of toStringArray(subtask.upstream_task_ids)) {
        statusById.set(upstreamTaskId, status);
      }
    }
  }
  return statusById;
}

function subtaskCompleted(subtask: Record<string, unknown>): boolean {
  return subtask.status === 'completed';
}

function createAutocodeTaskFromResolvedOpenSpecChange(
  projectRoot: string,
  dataDirName: string,
  change: OpenSpecChangeSource,
  input: CreateAutocodeTaskFromOpenSpecChangeInput,
): AutocodeOpenSpecTaskResult {
  const plan = buildAutocodeTaskFromOpenSpecChangePlan(change, input);
  const task = createAutocodeTask({
    projectRoot,
    dataDirName,
    title: plan.title,
    description: plan.description,
    specId: input.specId,
    fallbackSlug: slugifySpecTitle(change.changeId) || 'openspec-change',
    overwrite: input.overwrite,
    metadata: plan.metadata,
    requirements: plan.requirements,
    now: input.now,
    prepareSpecArtifacts: (context) => {
      const { specDir } = context;
      writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile), `${plan.specMarkdown.trimEnd()}\n`, 'utf8');
      writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecContext), `${buildOpenSpecContextMarkdown(change, resolveOpenSpecLanguage(input.metadata?.language, input.metadata)).trimEnd()}\n`, 'utf8');
      const prepared = input.prepareSpecArtifacts?.(context);
      return {
        metadata: {
          ...plan.metadata,
          ...prepared?.metadata,
          sourceType: 'openspec',
        },
        requirements: {
          ...plan.requirements,
          ...prepared?.requirements,
        },
      };
    },
  });

  saveAutocodeImplementationPlanSync(task.specsPath, plan.implementationPlan);
  const refreshed = listAutocodeTasks({ projectRoot, dataDirName })
    .find((candidate) => candidate.id === task.id || candidate.specId === task.specId);

  return {
    task: refreshed ?? task,
    change,
    plan,
  };
}

async function writeGeneratedOpenSpecArtifacts(input: {
  projectRoot: string;
  changeId: string;
  changeDir: string;
  title: string;
  description: string;
  capability: string;
  now: string;
  language?: string;
  schema: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  cli?: OpenSpecCliAdapter;
  requireOpenSpecProtocol?: boolean;
  artifactGenerator: OpenSpecArtifactGenerator;
  onProgress?: OpenSpecArtifactProgressHandler;
}): Promise<void> {
  const artifactIds = resolveOpenSpecArtifactOrder(input.cli, {
    projectRoot: input.projectRoot,
    changeId: input.changeId,
    schema: input.schema,
  }, input.requireOpenSpecProtocol === true);
  const totalArtifacts = artifactIds.length;

  for (const [index, artifactId] of artifactIds.entries()) {
    const outputPath = defaultOpenSpecArtifactOutputPath(artifactId, input.capability);
    const instructions = readOpenSpecArtifactInstructions(input.cli, {
      projectRoot: input.projectRoot,
      changeId: input.changeId,
      schema: input.schema,
      artifactId,
    }, input.requireOpenSpecProtocol === true, input.language);
    await generateAndWriteOpenSpecArtifact({
      ...input,
      artifactId,
      outputPath,
      instructions,
      artifactIndex: index + 1,
      totalArtifacts,
    });
  }
}

async function generateAndWriteOpenSpecArtifact(input: {
  projectRoot: string;
  changeId: string;
  changeDir: string;
  artifactId: string;
  title: string;
  description: string;
  capability: string;
  outputPath: string;
  now: string;
  language?: string;
  schema: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
  instructions: OpenSpecArtifactInstructions;
  artifactGenerator: OpenSpecArtifactGenerator;
  artifactIndex?: number;
  totalArtifacts?: number;
  onProgress?: OpenSpecArtifactProgressHandler;
}): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const artifactStartedAt = Date.now();
    const existingArtifacts = collectAvailableOpenSpecArtifacts(input.projectRoot, input.changeDir);
    const instructions = attempt === 0
      ? input.instructions
      : buildOpenSpecArtifactRetryInstructions(input.instructions, lastError, input.language);
    try {
      emitOpenSpecArtifactProgress(input.onProgress, {
        stage: 'artifact_start',
        artifactId: input.artifactId,
        outputPath: input.outputPath,
        changeId: input.changeId,
        capability: input.capability,
        artifactIndex: input.artifactIndex,
        totalArtifacts: input.totalArtifacts,
        attempt: attempt + 1,
        elapsedMs: Date.now() - artifactStartedAt,
      });
      const generated = await input.artifactGenerator.generateArtifact({
        projectRoot: input.projectRoot,
        changeId: input.changeId,
        changeDir: input.changeDir,
        language: input.language,
        artifactId: input.artifactId,
        title: input.title,
        description: input.description,
        capability: input.capability,
        outputPath: input.outputPath,
        now: input.now,
        schema: input.schema,
        metadata: input.metadata,
        requirements: input.requirements,
        instructions,
        dependencies: existingArtifacts,
        existingArtifacts,
        artifactIndex: input.artifactIndex,
        totalArtifacts: input.totalArtifacts,
        attempt: attempt + 1,
        onProgress: input.onProgress,
      });
      const artifact = normalizeGeneratedOpenSpecArtifact(input.artifactId, generated);
      const targetPath = resolveGeneratedArtifactPath(
        input.projectRoot,
        input.changeDir,
        input.artifactId,
        input.outputPath,
        artifact,
      );
      validateGeneratedOpenSpecArtifact(input.artifactId, artifact.content);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${artifact.content.trimEnd()}\n`, 'utf8');
      emitOpenSpecArtifactProgress(input.onProgress, {
        stage: 'artifact_complete',
        artifactId: input.artifactId,
        outputPath: relative(input.changeDir, targetPath),
        changeId: input.changeId,
        capability: artifact.capability || input.capability,
        artifactIndex: input.artifactIndex,
        totalArtifacts: input.totalArtifacts,
        attempt: attempt + 1,
        generatedChars: artifact.content.length,
        elapsedMs: Date.now() - artifactStartedAt,
      });
      return;
    } catch (error) {
      lastError = error;
      emitOpenSpecArtifactProgress(input.onProgress, {
        stage: attempt < 1 ? 'artifact_retry' : 'artifact_failed',
        artifactId: input.artifactId,
        outputPath: input.outputPath,
        changeId: input.changeId,
        capability: input.capability,
        artifactIndex: input.artifactIndex,
        totalArtifacts: input.totalArtifacts,
        attempt: attempt + 1,
        elapsedMs: Date.now() - artifactStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to generate OpenSpec ${input.artifactId}.`);
}

function emitOpenSpecArtifactProgress(
  handler: OpenSpecArtifactProgressHandler | undefined,
  event: OpenSpecArtifactProgress,
): void {
  if (!handler) {
    return;
  }
  try {
    handler(event);
  } catch {
    // Progress reporting is best-effort and must not break artifact generation.
  }
}

function buildOpenSpecArtifactRetryInstructions(
  instructions: OpenSpecArtifactInstructions,
  error: unknown,
  language?: string,
): OpenSpecArtifactInstructions {
  const message = error instanceof Error ? error.message : String(error);
  const retryRule = isChineseLanguage(language)
    ? `上一次输出没有通过校验：${message}。重新生成完整文档，满足所有必需标题、checkbox 和 OpenSpec 格式规则；除 OpenSpec 结构关键字外使用简体中文。`
    : `Previous output failed validation: ${message}. Regenerate the artifact and satisfy every required heading, checkbox, and OpenSpec format rule exactly.`;
  const rules = Array.isArray(instructions.rules)
    ? [...instructions.rules, retryRule]
    : typeof instructions.rules === 'string' && instructions.rules.trim()
      ? [instructions.rules, retryRule]
      : [retryRule];

  return {
    ...instructions,
    instruction: [
      stringFrom(instructions.instruction),
      retryRule,
      isChineseLanguage(language)
        ? '返回完整修正后的 Markdown 文档，不要返回补丁。'
        : 'Return the complete corrected Markdown artifact, not a patch.',
    ].filter(Boolean).join('\n\n'),
    rules,
  };
}

function writeOpenSpecRuntimeTaskFiles(
  specDir: string,
  change: OpenSpecChangeSource,
  plan: AutocodeOpenSpecTaskPlan,
  language?: string,
): void {
  writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.specFile), `${plan.specMarkdown.trimEnd()}\n`, 'utf8');
  writeFileSync(join(specDir, AUTOCODE_TASK_ARTIFACTS.openSpecContext), `${buildOpenSpecContextMarkdown(change, language).trimEnd()}\n`, 'utf8');
  saveAutocodeImplementationPlanSync(specDir, plan.implementationPlan);
  saveAutocodeTaskRequirementsSync(specDir, plan.requirements);
  writeJson(join(specDir, AUTOCODE_TASK_ARTIFACTS.taskMetadata), plan.metadata);
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function resolveOpenSpecArtifactOrder(
  cli: OpenSpecCliAdapter | undefined,
  input: OpenSpecChangeCliInput,
  requireProtocol = false,
): string[] {
  let status: OpenSpecChangeStatus | undefined;
  try {
    if (requireProtocol && !cli?.getStatus) {
      throw new Error('OpenSpec status interface is not available.');
    }
    status = cli?.getStatus?.(input).data;
  } catch (error) {
    if (requireProtocol) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenSpec status interface failed: ${message}`);
    }
    status = undefined;
  }
  const ids = status?.artifacts
    ?.map((artifact) => artifact.id)
    .filter((id): id is string => Boolean(id?.trim())) ?? [];
  if (ids.length === 0) {
    return [...OPENSPEC_SPEC_DRIVEN_ARTIFACT_ORDER];
  }

  const known = OPENSPEC_SPEC_DRIVEN_ARTIFACT_ORDER.filter((id) => ids.includes(id));
  const extra = ids.filter((id) => !OPENSPEC_SPEC_DRIVEN_ARTIFACT_ORDER.includes(id as typeof OPENSPEC_SPEC_DRIVEN_ARTIFACT_ORDER[number]));
  return [...known, ...extra];
}

function readOpenSpecArtifactInstructions(
  cli: OpenSpecCliAdapter | undefined,
  input: OpenSpecArtifactInstructionsCliInput,
  requireProtocol = false,
  language?: string,
): OpenSpecArtifactInstructions {
  try {
    if (requireProtocol && !cli?.getInstructions) {
      throw new Error('OpenSpec instructions interface is not available.');
    }
    const instructions = cli?.getInstructions?.(input).data ?? fallbackOpenSpecArtifactInstructions(input.artifactId, language);
    return enforceOpenSpecTaskDependencyInstructions(
      localizeOpenSpecArtifactInstructions(instructions, input.artifactId, language),
      input.artifactId,
      language,
    );
  } catch (error) {
    if (requireProtocol) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`OpenSpec instructions interface failed for ${input.artifactId}: ${message}`);
    }
    return enforceOpenSpecTaskDependencyInstructions(
      fallbackOpenSpecArtifactInstructions(input.artifactId, language),
      input.artifactId,
      language,
    );
  }
}

function defaultOpenSpecArtifactOutputPath(artifactId: string, capability: string): string {
  if (artifactId === 'proposal') return OPENSPEC_PROPOSAL_FILE_NAME;
  if (artifactId === 'design') return OPENSPEC_DESIGN_FILE_NAME;
  if (artifactId === 'tasks') return OPENSPEC_TASKS_FILE_NAME;
  if (artifactId === 'specs') return `${OPENSPEC_SPECS_DIR_NAME}/${capability}/spec.md`;
  return `${artifactId}.md`;
}

function resolveGeneratedArtifactPath(
  projectRoot: string,
  changeDir: string,
  artifactId: string,
  fallbackOutputPath: string,
  generated: OpenSpecGeneratedArtifact,
): string {
  const outputPath = generated.outputPath?.trim() && !generated.outputPath.includes('*')
    ? generated.outputPath.trim()
    : fallbackOutputPath;
  const targetPath = resolve(changeDir, outputPath);
  assertPathWithinProject(projectRoot, targetPath, `${artifactId} outputPath`);
  assertPathWithinProject(changeDir, targetPath, `${artifactId} outputPath`);
  return targetPath;
}

function normalizeGeneratedOpenSpecArtifact(
  artifactId: string,
  generated: string | OpenSpecGeneratedArtifact,
): OpenSpecGeneratedArtifact {
  const candidate = typeof generated === 'string'
    ? { content: generated }
    : generated;
  const content = stripMarkdownFence(candidate.content ?? '').trim();
  if (!content) {
    throw new Error('OpenSpec artifact generator returned empty content.');
  }
  return {
    ...candidate,
    content: normalizeGeneratedOpenSpecArtifactContent(artifactId, content),
  };
}

function normalizeGeneratedOpenSpecArtifactContent(artifactId: string, content: string): string {
  if (artifactId === 'tasks') {
    return normalizeGeneratedOpenSpecTasksMarkdown(content);
  }
  if (artifactId === 'specs') {
    return normalizeGeneratedOpenSpecSpecMarkdown(content);
  }
  return content;
}

function stripMarkdownFence(content: string): string {
  return content
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function validateGeneratedOpenSpecArtifact(artifactId: string, content: string): void {
  const placeholderPattern = /<!--|<name>|<brief|<condition>|<expected|<requirement name>|<task description>|TBD|TODO/i;
  if (placeholderPattern.test(content)) {
    throw new Error(`Generated OpenSpec ${artifactId} still contains template placeholders.`);
  }

  if (artifactId === 'proposal') {
    requireAnyMarkdownSection(content, ['Why', '背景', '原因'], artifactId, '背景');
    requireAnyMarkdownSection(content, ['What Changes', '变更内容', '变更'], artifactId, '变更内容');
    return;
  }

  if (artifactId === 'design') {
    requireAnyMarkdownSection(content, ['Context', '上下文'], artifactId, '上下文');
    requireAnyMarkdownSection(content, ['Decisions', '决策'], artifactId, '决策');
    return;
  }

  if (artifactId === 'tasks') {
    if (!/^\s*-\s+\[[ xX]\]\s+.+$/m.test(content)) {
      throw new Error('Generated OpenSpec tasks must contain Markdown checkbox tasks.');
    }
    assertGeneratedOpenSpecTasksHaveDependencyMetadata(content);
    return;
  }

  if (artifactId === 'specs') {
    if (!/^##\s+(ADDED|MODIFIED|REMOVED)\s+Requirements/m.test(content)) {
      throw new Error('Generated OpenSpec specs must use ADDED/MODIFIED/REMOVED Requirements sections.');
    }
    if (!/^####\s+Scenario:/m.test(content)) {
      throw new Error('Generated OpenSpec specs must include at least one Scenario.');
    }
  }
}

function requireAnyMarkdownSection(content: string, sections: string[], artifactId: string, displaySection: string): void {
  for (const section of sections) {
    const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`^##\\s+${escaped}\\s*$`, 'im').test(content)) {
      return;
    }
  }
  throw new Error(`Generated OpenSpec ${artifactId} must include "## ${displaySection}".`);
}

interface OpenSpecTaskMarkdownItem {
  id: string;
  indent: number;
  lineIndex: number;
}

function assertGeneratedOpenSpecTasksHaveDependencyMetadata(content: string): void {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const items = collectOpenSpecTaskMarkdownItems(lines);
  const leafItems = items.filter((item, index) => {
    const nextItem = items[index + 1];
    return !nextItem || nextItem.indent <= item.indent;
  });
  const executableTaskIds = new Set(leafItems.map((item) => item.id));

  for (const [index, item] of leafItems.entries()) {
    const nextItem = items.find((candidate) => candidate.lineIndex > item.lineIndex && candidate.indent <= item.indent);
    const block = lines.slice(item.lineIndex + 1, nextItem?.lineIndex ?? lines.length);
    const dependencyLines = block.filter((line) => /^\s*-\s+_Depends on:\s*.*?_\s*$/i.test(line));
    if (dependencyLines.length === 0) {
      throw new Error(`Generated OpenSpec tasks must include _Depends on: ..._ for executable task ${item.id}.`);
    }
    if (dependencyLines.length > 1) {
      throw new Error(`Generated OpenSpec task ${item.id} must include exactly one Depends on line.`);
    }

    const dependencyValue = dependencyLines[0].replace(/^\s*-\s+_Depends on:\s*/i, '').replace(/_\s*$/, '').trim();
    if (!dependencyValue) {
      throw new Error(`Generated OpenSpec task ${item.id} has an empty Depends on value.`);
    }

    if (/^none$/i.test(dependencyValue)) {
      continue;
    }

    for (const dependencyId of dependencyValue.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (!executableTaskIds.has(dependencyId)) {
        throw new Error(`Generated OpenSpec task ${item.id} depends on unknown task ${dependencyId}.`);
      }
      if (dependencyId === item.id) {
        throw new Error(`Generated OpenSpec task ${item.id} cannot depend on itself.`);
      }
      const dependencyIndex = leafItems.findIndex((candidate) => candidate.id === dependencyId);
      if (dependencyIndex > index) {
        throw new Error(`Generated OpenSpec task ${item.id} depends on later task ${dependencyId}; dependencies must form a DAG in execution order.`);
      }
    }
  }

  const parsedPlan = parseAutocodeImplementationPlanMarkdown(lines.join('\n'));
  const runtimeTasks = completeOpenSpecRuntimeTaskDependencyGraph(flattenOpenSpecRuntimeTasks(parsedPlan.phases ?? []));
  assertOpenSpecRuntimeTasksHaveValidDependencies(runtimeTasks);
}

function collectOpenSpecTaskMarkdownItems(lines: string[]): OpenSpecTaskMarkdownItem[] {
  const pattern = /^(\s*)-\s+\[[ xX]\]\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)(?:\.)?\s+.+?\s*$/;
  const items: OpenSpecTaskMarkdownItem[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    const match = pattern.exec(line);
    if (match) {
      items.push({
        id: match[2],
        indent: match[1].length,
        lineIndex,
      });
    }
  }
  return items;
}

function normalizeGeneratedOpenSpecTasksMarkdown(content: string): string {
  const lines = expandInlineOpenSpecDependencyMetadataLines(content.replace(/\r\n/g, '\n').split('\n'));
  const items = collectOpenSpecTaskMarkdownItems(lines);
  if (items.length === 0) {
    return content;
  }

  const leafItems = collectOpenSpecExecutableTaskMarkdownItems(items);
  if (leafItems.length === 0) {
    return content;
  }

  const parsedPlan = parseAutocodeImplementationPlanMarkdown(content);
  const runtimeTasks = completeOpenSpecRuntimeTaskDependencyGraph(flattenOpenSpecRuntimeTasks(parsedPlan.phases ?? []));
  const dependsOnByTaskId = new Map(
    runtimeTasks.map((task) => [
      task.id,
      task.dependsOn.length > 0 ? task.dependsOn.join(', ') : 'none',
    ]),
  );

  for (let index = leafItems.length - 1; index >= 0; index -= 1) {
    const item = leafItems[index];
    const nextItem = items.find((candidate) => candidate.lineIndex > item.lineIndex && candidate.indent <= item.indent);
    const blockEnd = nextItem?.lineIndex ?? lines.length;
    const dependencyLineIndexes = collectOpenSpecDependencyMetadataLineIndexes(lines, item.lineIndex + 1, blockEnd);
    const dependencyValue = resolveOpenSpecDependencyMetadataValue(lines, dependencyLineIndexes)
      ?? dependsOnByTaskId.get(item.id)
      ?? 'none';
    const canonicalLine = `${' '.repeat(item.indent + 2)}- _Depends on: ${dependencyValue}_`;

    if (dependencyLineIndexes.length === 0) {
      lines.splice(item.lineIndex + 1, 0, canonicalLine);
      continue;
    }

    const [firstDependencyLineIndex, ...duplicateDependencyLineIndexes] = dependencyLineIndexes;
    lines[firstDependencyLineIndex] = canonicalLine;
    for (const duplicateLineIndex of duplicateDependencyLineIndexes.reverse()) {
      lines.splice(duplicateLineIndex, 1);
    }
  }

  return lines.join('\n').trimEnd();
}

function expandInlineOpenSpecDependencyMetadataLines(lines: string[]): string[] {
  const expanded: string[] = [];
  for (const line of lines) {
    const splitLine = splitOpenSpecTaskLineWithInlineDependencyMetadata(line);
    if (splitLine) {
      expanded.push(splitLine.taskLine, splitLine.dependencyLine);
      if (splitLine.trailingLine) {
        expanded.push(splitLine.trailingLine);
      }
      continue;
    }

    const metadata = parseOpenSpecDependencyMetadataLine(line);
    if (metadata?.trailing) {
      expanded.push(`${metadata.indent}${metadata.hasBullet ? '- ' : ''}_Depends on: ${metadata.value}_`);
      expanded.push(`${metadata.indent}${metadata.trailing}`);
      continue;
    }

    expanded.push(line);
  }
  return expanded;
}

function splitOpenSpecTaskLineWithInlineDependencyMetadata(line: string): {
  taskLine: string;
  dependencyLine: string;
  trailingLine?: string;
} | null {
  const itemMatch = /^(\s*)-\s+\[[ xX]\]\s+[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*(?:\.)?\s+.+$/u.exec(line);
  if (!itemMatch) {
    return null;
  }

  const metadataStart = line.search(/\s+-\s+_(?:Depends on|依赖|依赖于|前置任务|前置|先决条件)\s*[:：]/iu);
  if (metadataStart < 0) {
    return null;
  }

  const metadata = parseOpenSpecDependencyMetadataLine(line.slice(metadataStart).trim());
  if (!metadata) {
    return null;
  }

  const childIndent = ' '.repeat(itemMatch[1].length + 2);
  return {
    taskLine: line.slice(0, metadataStart).trimEnd(),
    dependencyLine: `${childIndent}- _Depends on: ${metadata.value}_`,
    trailingLine: metadata.trailing ? `${childIndent}${metadata.trailing}` : undefined,
  };
}

function collectOpenSpecExecutableTaskMarkdownItems(items: OpenSpecTaskMarkdownItem[]): OpenSpecTaskMarkdownItem[] {
  return items.filter((item, index) => {
    const nextItem = items[index + 1];
    return !nextItem || nextItem.indent <= item.indent;
  });
}

function collectOpenSpecDependencyMetadataLineIndexes(lines: string[], startIndex: number, endIndex: number): number[] {
  const indexes: number[] = [];
  for (let index = startIndex; index < endIndex; index += 1) {
    if (isOpenSpecDependencyMetadataLine(lines[index])) {
      indexes.push(index);
    }
  }
  return indexes;
}

function isOpenSpecDependencyMetadataLine(line: string): boolean {
  return Boolean(parseOpenSpecDependencyMetadataLine(line));
}

function parseOpenSpecDependencyMetadataLine(line: string): {
  indent: string;
  hasBullet: boolean;
  value: string;
  trailing: string;
} | null {
  const match = /^(\s*)(-\s+)?_(?:Depends on|依赖|依赖于|前置任务|前置|先决条件)\s*[:：]\s*([^_]+?)_\s*(.*?)\s*$/iu.exec(line);
  if (!match) {
    return null;
  }
  return {
    indent: match[1],
    hasBullet: Boolean(match[2]),
    value: normalizeOpenSpecDependencyMetadataValue(match[3]),
    trailing: match[4].trim(),
  };
}

function resolveOpenSpecDependencyMetadataValue(lines: string[], dependencyLineIndexes: number[]): string | undefined {
  for (const lineIndex of [...dependencyLineIndexes].reverse()) {
    const value = parseOpenSpecDependencyMetadataLine(lines[lineIndex])?.value;
    if (value) {
      return value;
    }
  }
  return undefined;
}

function normalizeOpenSpecDependencyMetadataValue(value: string): string {
  const normalized = value.trim();
  if (!normalized || /^(none|无|なし|n\/a|na)$/iu.test(normalized)) {
    return 'none';
  }
  const dependencyIds = normalized
    .split(/[,，、;；]/u)
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/u.test(item));
  return dependencyIds.length > 0 ? uniqueStrings(dependencyIds).join(', ') : 'none';
}

function normalizeGeneratedOpenSpecSpecMarkdown(content: string): string {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  let requirementStart = -1;
  let firstBodyLine = -1;
  let hasShallOrMust = false;
  let insideScenario = false;

  const flushRequirement = (): boolean => {
    if (requirementStart < 0 || hasShallOrMust) {
      return false;
    }
    if (firstBodyLine >= 0) {
      lines[firstBodyLine] = addShallToOpenSpecRequirementLine(lines[firstBodyLine]);
      return false;
    }
    lines.splice(requirementStart + 1, 0, '系统 SHALL 满足该需求。');
    return true;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^###\s+Requirement:/u.test(line)) {
      if (flushRequirement()) {
        index += 1;
      }
      requirementStart = index;
      firstBodyLine = -1;
      hasShallOrMust = false;
      insideScenario = false;
      continue;
    }

    if (requirementStart < 0) {
      continue;
    }

    if (/^##\s+/u.test(line) && !/^####\s+Scenario:/u.test(line)) {
      if (flushRequirement()) {
        index += 1;
      }
      requirementStart = -1;
      firstBodyLine = -1;
      hasShallOrMust = false;
      insideScenario = false;
      continue;
    }

    if (/^####\s+Scenario:/u.test(line)) {
      insideScenario = true;
      continue;
    }

    if (insideScenario || !line.trim()) {
      continue;
    }

    if (/\b(?:SHALL|MUST)\b/iu.test(line)) {
      hasShallOrMust = true;
    }
    if (firstBodyLine < 0 && !/^#/u.test(line.trim())) {
      firstBodyLine = index;
    }
  }

  flushRequirement();
  return lines.join('\n').trimEnd();
}

function addShallToOpenSpecRequirementLine(line: string): string {
  const leadingWhitespace = line.match(/^\s*/u)?.[0] ?? '';
  const text = line.trim();
  if (/\b(?:SHALL|MUST)\b/iu.test(text)) {
    return line;
  }
  const chineseModal = /^(系统|软件|应用|页面|服务|功能|用户界面)?\s*(必须|应当|需要|可以|能够|要)\s*/u.exec(text);
  if (chineseModal) {
    return `${leadingWhitespace}${chineseModal[1] || '系统'} SHALL ${text.slice(chineseModal[0].length)}`;
  }
  return `${leadingWhitespace}系统 SHALL ${text}`;
}

function fallbackOpenSpecArtifactInstructions(artifactId: string, language?: string): OpenSpecArtifactInstructions {
  if (isChineseLanguage(language)) {
    return fallbackChineseOpenSpecArtifactInstructions(artifactId);
  }

  if (artifactId === 'proposal') {
    return {
      artifactId,
      outputPath: OPENSPEC_PROPOSAL_FILE_NAME,
      template: [
        '## Why',
        '',
        '## What Changes',
        '',
        '## Capabilities',
        '',
        '### New Capabilities',
        '- `<name>`: <brief description>',
        '',
        '### Modified Capabilities',
        '- `<existing-name>`: <what changes>',
        '',
        '## Impact',
      ].join('\n'),
      instruction: 'Create the OpenSpec proposal: problem, change scope, capabilities, and impact.',
    };
  }
  if (artifactId === 'design') {
    return {
      artifactId,
      outputPath: OPENSPEC_DESIGN_FILE_NAME,
      template: [
        '## Context',
        '',
        '## Goals / Non-Goals',
        '',
        '**Goals:**',
        '',
        '**Non-Goals:**',
        '',
        '## Decisions',
        '',
        '## Risks / Trade-offs',
      ].join('\n'),
      instruction: 'Create the OpenSpec design using the proposal and project context.',
    };
  }
  if (artifactId === 'tasks') {
    return {
      artifactId,
      outputPath: OPENSPEC_TASKS_FILE_NAME,
      template: [
        '## 1. Task Group',
        '',
        '- [ ] 1.1 Task description',
        '  - _Depends on: none_',
        '- [ ] 1.2 Follow-up task',
        '  - _Depends on: 1.1_',
      ].join('\n'),
      instruction: 'Create concrete implementation tasks grouped by phase. Every executable task must include a machine-readable _Depends on: ..._ line.',
      rules: [
        'Every executable checkbox task must include exactly one _Depends on: ..._ metadata line.',
        'Use _Depends on: none_ only for root tasks. Otherwise list prerequisite task IDs only, separated by commas.',
        'Infer the minimum required dependency graph from implementation order, file ownership, verification needs, and runtime prerequisites.',
        'Keep dependencies minimal: do not make each task depend on the previous task or phase unless it is truly blocked by that work.',
        'Expose parallel branches for independent modules, files, UI surfaces, tests, and validation scenarios.',
        'Verification tasks may share the same implementation prerequisite; do not chain them together unless one scenario genuinely requires another.',
      ],
    };
  }
  return {
    artifactId,
    outputPath: 'specs/**/*.md',
      template: [
        '## ADDED Requirements',
        '',
        '### Requirement: Requirement name',
        'The system SHALL describe the required behavior.',
        '',
        '#### Scenario: Scenario name',
        '- **WHEN** condition',
      '- **THEN** expected outcome',
    ].join('\n'),
    instruction: 'Create OpenSpec requirement deltas with scenarios.',
  };
}

function fallbackChineseOpenSpecArtifactInstructions(artifactId: string): OpenSpecArtifactInstructions {
  if (artifactId === 'proposal') {
    return {
      artifactId,
      outputPath: OPENSPEC_PROPOSAL_FILE_NAME,
      template: [
        '## 背景',
        '',
        '## 变更内容',
        '',
        '## 能力范围',
        '',
        '### 新增能力',
        '- `能力名`: 具体说明',
        '',
        '### 修改能力',
        '- `已有能力`: 变更说明',
        '',
        '## 影响',
      ].join('\n'),
      instruction: '创建 OpenSpec 提案，说明问题背景、变更范围、能力影响和用户可见行为。全文使用简体中文。',
      rules: [
        'proposal.md 的自然语言、标题和列表内容使用简体中文。',
        '不要输出英文模板标题，例如 Why、What Changes、Capabilities、Impact。',
      ],
    };
  }
  if (artifactId === 'design') {
    return {
      artifactId,
      outputPath: OPENSPEC_DESIGN_FILE_NAME,
      template: [
        '## 上下文',
        '',
        '## 目标 / 非目标',
        '',
        '**目标：**',
        '',
        '**非目标：**',
        '',
        '## 决策',
        '',
        '## 风险 / 权衡',
      ].join('\n'),
      instruction: '根据提案和项目上下文创建 OpenSpec 设计文档。全文使用简体中文。',
      rules: [
        'design.md 的自然语言、标题和列表内容使用简体中文。',
        '不要输出英文模板标题，例如 Context、Goals / Non-Goals、Decisions、Risks / Trade-offs。',
      ],
    };
  }
  if (artifactId === 'tasks') {
    return {
      artifactId,
      outputPath: OPENSPEC_TASKS_FILE_NAME,
      template: [
        '# 任务',
        '',
        '- [ ] 1. 任务分组',
        '  - [ ] 1.1 具体任务',
        '    - _Depends on: none_',
        '  - [ ] 1.2 后续任务',
        '    - _Depends on: 1.1_',
      ].join('\n'),
      instruction: '创建按阶段分组、可执行、可验证的 OpenSpec 任务清单。任务标题和说明使用简体中文；每个可执行任务必须包含机器可解析的 _Depends on: ..._ 行。',
      rules: [
        'tasks.md 的任务标题、说明、文件提示、依赖提示、需求引用和验证说明使用简体中文。',
        '保留 Markdown checkbox 语法和数字编号，例如 - [ ] 1.1。',
        '每个可执行 checkbox 任务必须包含且只包含一个独立的 `- _Depends on: ..._` 元数据行，不能写在任务标题同一行，也不能重复。',
        '根任务使用 _Depends on: none_；有前置任务时只填写任务 ID，多个 ID 用英文逗号分隔。',
        '根据实现顺序、文件归属、验证前置条件和运行依赖推断最小依赖图。',
        '依赖必须最小化：不要默认让每个任务依赖上一条任务或上一整个阶段，只有真实阻塞时才写依赖。',
        '独立模块、独立文件、独立 UI 区域、独立测试和独立验收场景要拆成可并行分支。',
        '多个验证任务可以共同依赖同一个实现任务；除非验证场景之间真实有前后关系，否则不要互相串行依赖。',
      ],
    };
  }
  return {
    artifactId,
    outputPath: 'specs/**/*.md',
      template: [
        '## ADDED Requirements',
        '',
        '### Requirement: 需求名称',
        '系统 SHALL 使用简体中文描述需求正文。',
        '',
        '#### Scenario: 场景名称',
        '- **WHEN** 触发条件',
      '- **THEN** 期望结果',
    ].join('\n'),
    instruction: '创建 OpenSpec 需求增量和场景。除 OpenSpec 必需结构关键字外，需求名称、场景名称和正文使用简体中文。',
    rules: [
      '保留 OpenSpec 必需结构关键字：ADDED/MODIFIED/REMOVED Requirements、Requirement、Scenario、WHEN、THEN。',
      '每个 Requirement 正文必须包含字面英文 SHALL 或 MUST；中文正文写成“系统 SHALL ...”。',
      '除上述结构关键字、代码标识、命令和路径外，所有自然语言使用简体中文。',
    ],
  };
}

function localizeOpenSpecArtifactInstructions(
  instructions: OpenSpecArtifactInstructions,
  artifactId: string,
  language?: string,
): OpenSpecArtifactInstructions {
  if (!isChineseLanguage(language)) {
    return instructions;
  }

  const languageRule = artifactId === 'specs'
    ? '中文输出规则：保留 OpenSpec 必需结构关键字 ADDED/MODIFIED/REMOVED Requirements、Requirement、Scenario、WHEN、THEN；每个 Requirement 正文必须包含字面英文 SHALL 或 MUST，中文正文写成“系统 SHALL ...”；其余需求名称、场景名称、条件和结果正文使用简体中文。'
    : '中文输出规则：标题、正文、任务描述、文件提示、依赖提示、需求引用和验证说明都使用简体中文；不要沿用英文模板标题。';
  const rules = Array.isArray(instructions.rules)
    ? [...instructions.rules, languageRule]
    : typeof instructions.rules === 'string' && instructions.rules.trim()
      ? [instructions.rules, languageRule]
      : [languageRule];

  return {
    ...instructions,
    instruction: [
      stringFrom(instructions.instruction),
      languageRule,
    ].filter(Boolean).join('\n\n'),
    rules,
  };
}

function enforceOpenSpecTaskDependencyInstructions(
  instructions: OpenSpecArtifactInstructions,
  artifactId: string,
  language?: string,
): OpenSpecArtifactInstructions {
  if (artifactId !== 'tasks') {
    return instructions;
  }

  const dependencyRules = isChineseLanguage(language)
    ? [
      '依赖图规则：OpenSpec tasks.md 必须显式写出任务之间的依赖关系。',
      '每个可执行 checkbox 任务必须包含一个机器可解析的独立 `- _Depends on: ..._` 行，不能写在任务标题同一行，也不能重复。',
      '根任务写 _Depends on: none_；非根任务只写前置任务 ID，例如 _Depends on: 1.1, 1.2_。',
      '不要在 Depends on 中写自然语言、章节标题、需求 ID、文件路径或“见上文”。',
      '如果依赖不明显，请根据实现顺序、共享文件、验证前置条件和运行时前置条件推断最小 DAG。',
      '依赖必须最小化：不要按章节顺序或任务列表顺序自动串行化；只有真实数据、接口、文件或运行前置关系才算依赖。',
      '能并行的任务必须显式形成扇出/汇合 DAG，例如 1.1 -> 1.2, 1.3 -> 1.4，而不是 1.1 -> 1.2 -> 1.3 -> 1.4。',
      '验证任务默认依赖被验证的实现完成点，不要把不同验证场景互相串起来。',
    ]
    : [
      'Dependency graph rule: OpenSpec tasks.md must explicitly describe task-to-task dependencies.',
      'Every executable checkbox task must include one machine-readable _Depends on: ..._ line.',
      'Root tasks use _Depends on: none_; non-root tasks list prerequisite task IDs only, for example _Depends on: 1.1, 1.2_.',
      'Do not put prose, phase titles, requirement IDs, file paths, or "see above" in Depends on.',
      'When dependencies are unclear, infer the minimum DAG from implementation order, shared files, verification prerequisites, and runtime prerequisites.',
      'Keep dependencies minimal: do not serialize by phase or list order unless there is a real data, interface, file, or runtime prerequisite.',
      'Tasks that can run independently must form fan-out/join DAGs, for example 1.1 -> 1.2, 1.3 -> 1.4, instead of 1.1 -> 1.2 -> 1.3 -> 1.4.',
      'Verification tasks normally depend on the implementation point they verify; do not chain independent verification scenarios together.',
    ];
  const existingRules = Array.isArray(instructions.rules)
    ? instructions.rules
    : typeof instructions.rules === 'string' && instructions.rules.trim()
      ? [instructions.rules]
      : [];

  return {
    ...instructions,
    instruction: [
      stringFrom(instructions.instruction),
      ...dependencyRules,
    ].filter(Boolean).join('\n\n'),
    rules: [...existingRules, ...dependencyRules],
  };
}

function collectAvailableOpenSpecArtifacts(projectRoot: string, changeDir: string): OpenSpecArtifact[] {
  return [
    readOpenSpecArtifact(projectRoot, changeDir, OPENSPEC_PROPOSAL_FILE_NAME),
    readOpenSpecArtifact(projectRoot, changeDir, OPENSPEC_DESIGN_FILE_NAME),
    readOpenSpecArtifact(projectRoot, changeDir, OPENSPEC_TASKS_FILE_NAME),
    ...collectOpenSpecSpecDeltas(projectRoot, changeDir),
  ].filter((artifact): artifact is OpenSpecArtifact => Boolean(artifact));
}

function buildOpenSpecProposalMarkdown(input: {
  changeId: string;
  title: string;
  description: string;
  now: string;
  language?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
}): string {
  if (isChineseLanguage(input.language)) {
    return [
      `# ${input.title}`,
      '',
      '## 背景',
      input.description,
      '',
      '## 变更内容',
      ...markdownList([
        '实现用户提出的产品或代码变更。',
        ...toStringArray(input.requirements?.user_requirements),
      ]),
      '',
      '## 验收标准',
      ...markdownList(toStringArray(input.metadata?.acceptanceCriteria).concat(toStringArray(input.requirements?.acceptance_criteria))),
      '',
      '## 非目标',
      ...markdownList([
        '不把 Autocode 运行态文件作为长期产品规格。',
        '不在 OpenSpec 文档中记录执行日志或临时状态。',
      ]),
      '',
      '## 元数据',
      `- 变更 ID：\`${input.changeId}\``,
      `- 创建时间：${input.now}`,
      input.metadata?.category ? `- 分类：${input.metadata.category}` : '',
      input.metadata?.priority ? `- 优先级：${input.metadata.priority}` : '',
      input.metadata?.complexity ? `- 复杂度：${input.metadata.complexity}` : '',
      '',
    ].filter((line) => line !== '').join('\n');
  }

  return [
    `# ${input.title}`,
    '',
    '## Why',
    input.description,
    '',
    '## Scope',
    ...markdownList([
      'Implement the requested product or code change.',
      ...toStringArray(input.requirements?.user_requirements),
    ]),
    '',
    '## Acceptance Criteria',
    ...markdownList(toStringArray(input.metadata?.acceptanceCriteria).concat(toStringArray(input.requirements?.acceptance_criteria))),
    '',
    '## Non-Goals',
    ...markdownList([
      'Do not use Autocode runtime files as long-lived product specs.',
      'Do not include execution logs or transient state in OpenSpec documents.',
    ]),
    '',
    '## Metadata',
    `- Change ID: \`${input.changeId}\``,
    `- Created: ${input.now}`,
    input.metadata?.category ? `- Category: ${input.metadata.category}` : '',
    input.metadata?.priority ? `- Priority: ${input.metadata.priority}` : '',
    input.metadata?.complexity ? `- Complexity: ${input.metadata.complexity}` : '',
    '',
  ].filter((line) => line !== '').join('\n');
}

function buildOpenSpecDesignMarkdown(input: {
  title: string;
  description: string;
  now: string;
  language?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
}): string {
  const fileHints = [...new Set([
    ...toStringArray(input.metadata?.affectedFiles),
    ...toReferencedFilePaths(input.metadata?.referencedFiles),
  ])];
  if (isChineseLanguage(input.language)) {
    return [
      `# 设计：${input.title}`,
      '',
      '## 上下文',
      input.description,
      '',
      '## 方案',
      ...markdownList([
        '遵循现有项目架构和代码约定。',
        'OpenSpec 文档只记录稳定需求和设计决策。',
        'Autocode 只用于下游执行状态、日志和 QA 证据。',
      ]),
      '',
      '## 文件和模块提示',
      ...markdownList(fileHints),
      '',
      '## 风险',
      ...markdownList(toStringArray(input.requirements?.constraints).concat([
        '源代码分析后可能需要微调实现细节。',
      ])),
      '',
      '## 决策',
      ...markdownList([
        '先以 OpenSpec 文档作为上游事实来源，再生成下游执行计划。',
      ]),
      '',
      '## 验证',
      ...markdownList([
        '运行与改动范围最相关的项目验证命令。',
        '在下游 Autocode 任务中记录验证证据。',
      ]),
      '',
      `创建时间：${input.now}`,
      '',
    ].join('\n');
  }

  return [
    `# Design: ${input.title}`,
    '',
    '## Context',
    input.description,
    '',
    '## Approach',
    ...markdownList([
      'Follow the existing project architecture and conventions.',
      'Keep OpenSpec documents focused on stable requirements and design.',
      'Use Autocode only for downstream execution state, logs, and QA evidence.',
    ]),
    '',
    '## File and Module Hints',
    ...markdownList(fileHints),
    '',
    '## Risks',
    ...markdownList(toStringArray(input.requirements?.constraints).concat([
      'Implementation details may need adjustment after source inspection.',
    ])),
    '',
    '## Verification',
    ...markdownList([
      'Run the smallest relevant project validation command.',
      'Record verification evidence in the downstream Autocode task.',
    ]),
    '',
    `Created: ${input.now}`,
    '',
  ].join('\n');
}

function buildOpenSpecTasksMarkdown(input: {
  title: string;
  description: string;
  now: string;
  language?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
}): string {
  const affectedFiles = toStringArray(input.metadata?.affectedFiles);
  const dependencies = toStringArray(input.metadata?.dependencies);
  const acceptance = toStringArray(input.metadata?.acceptanceCriteria).concat(toStringArray(input.requirements?.acceptance_criteria));
  if (isChineseLanguage(input.language)) {
    const lines = [
      '# 任务',
      '',
      '- [ ] 1. 实现 OpenSpec 变更',
      `  - ${singleLine(input.description)}`,
      '  - _Depends on: none_',
    ];
    if (affectedFiles.length > 0) lines.push(`  - _文件：${affectedFiles.join(', ')}_`);
    if (dependencies.length > 0) lines.push(`  - 项目依赖：${dependencies.join(', ')}`);
    if (acceptance.length > 0) lines.push(`  - _需求：${acceptance.map((_, index) => `1.${index + 1}`).join(', ')}_`);
    lines.push('  - _验证：运行最相关的项目验证命令，并在 Autocode 中记录结果。_');
    lines.push('');
    lines.push(`_创建时间：${input.now}_`);
    lines.push('');
    return lines.join('\n');
  }

  const lines = [
    '# Tasks',
    '',
    '- [ ] 1. Implement the OpenSpec change',
    `  - ${singleLine(input.description)}`,
    '  - _Depends on: none_',
  ];
  if (affectedFiles.length > 0) lines.push(`  - _Files: ${affectedFiles.join(', ')}_`);
  if (dependencies.length > 0) lines.push(`  - Project dependencies: ${dependencies.join(', ')}`);
  if (acceptance.length > 0) lines.push(`  - _Requirements: ${acceptance.map((_, index) => `1.${index + 1}`).join(', ')}_`);
  lines.push('  - _Verification: Run the most relevant project validation and record the result in Autocode._');
  lines.push('');
  lines.push(`_Created: ${input.now}_`);
  lines.push('');
  return lines.join('\n');
}

function buildOpenSpecSpecDeltaMarkdown(input: {
  title: string;
  description: string;
  capability: string;
  now: string;
  language?: string;
  metadata?: AutocodeTaskMetadata;
  requirements?: AutocodeTaskRequirements;
}): string {
  const acceptance = toStringArray(input.metadata?.acceptanceCriteria)
    .concat(toStringArray(input.requirements?.acceptance_criteria));
  const criteria = acceptance.length > 0
    ? acceptance
    : [isChineseLanguage(input.language) ? '请求的行为已实现并通过验证。' : 'The requested behavior is implemented and verified.'];
  if (isChineseLanguage(input.language)) {
    return [
      '## ADDED Requirements',
      '',
      `### Requirement: ${input.title}`,
      input.description,
      '',
      ...criteria.flatMap((criterion, index) => [
        `#### Scenario: ${scenarioTitle(criterion, index)}`,
        '- **WHEN** 用户执行相关流程',
        `- **THEN** ${singleLine(criterion)}`,
        '',
      ]),
      `<!-- 能力: ${input.capability}; 创建时间: ${input.now} -->`,
      '',
    ].join('\n');
  }

  return [
    '## ADDED Requirements',
    '',
    `### Requirement: ${input.title}`,
    input.description,
    '',
    ...criteria.flatMap((criterion, index) => [
      `#### Scenario: ${scenarioTitle(criterion, index)}`,
      `- **WHEN** the change is implemented`,
      `- **THEN** ${singleLine(criterion)}`,
      '',
    ]),
    `<!-- capability: ${input.capability}; created: ${input.now} -->`,
    '',
  ].join('\n');
}

function buildOpenSpecTaskDescription(change: OpenSpecChangeSource, language?: string): string {
  if (isChineseLanguage(language)) {
    return [
      `实现 OpenSpec 变更 \`${change.changeId}\`。`,
      '',
      'OpenSpec 是上游规格层。Autocode 是下游执行层，负责运行、记录日志并验证实现。',
      '',
      '事实来源：',
      ...listOpenSpecSourcePaths(change).map((path) => `- \`${path}\``),
    ].join('\n');
  }

  return [
    `Implement OpenSpec change \`${change.changeId}\`.`,
    '',
    'OpenSpec is the upstream specification layer. Autocode is the downstream execution layer for running, logging, and verifying the implementation.',
    '',
    'Source of truth:',
    ...listOpenSpecSourcePaths(change).map((path) => `- \`${path}\``),
  ].join('\n');
}

function buildOpenSpecExecutionSpecMarkdown(
  change: OpenSpecChangeSource,
  title: string,
  description: string,
  language?: string,
): string {
  const sourcePaths = listOpenSpecSourcePaths(change);
  const specDeltas = change.specDeltas.length > 0
    ? change.specDeltas.map((delta) => `- \`${delta.relativePath}\` (${delta.capability})`)
    : [isChineseLanguage(language) ? '- 无' : '- None'];

  if (isChineseLanguage(language)) {
    return [
      `# ${title}`,
      '',
      '## 角色',
      '此文件是下游 Autocode 执行交接文档，不替代 OpenSpec。',
      '',
      '## 任务',
      description,
      '',
      '## 上游事实来源',
      ...sourcePaths.map((path) => `- \`${path}\``),
      '',
      '## 规格增量',
      ...specDeltas,
      '',
      '## 执行规则',
      '- 修改源码前先阅读 OpenSpec 文档。',
      '- 实现 OpenSpec 变更；除非用户明确要求，不重写 proposal.md、design.md 或 spec delta 文件。',
      '- 执行时只更新 implementation_plan.md 中的下游运行状态。',
      '- 如果 OpenSpec 与 Autocode 运行态文件不一致，以 OpenSpec 为准，并在完成摘要中记录差异。',
      '',
      '## 验收',
      '- OpenSpec 任务已完成，或明确记录阻塞原因。',
      '- 代码改动符合 proposal、design 和 spec delta。',
      '- 验证证据记录在 Autocode 运行输出中。',
    ].join('\n');
  }

  return [
    `# ${title}`,
    '',
    '## Role',
    'This file is a downstream Autocode execution handoff, not a replacement for OpenSpec.',
    '',
    '## Task',
    description,
    '',
    '## Upstream Source of Truth',
    ...sourcePaths.map((path) => `- \`${path}\``),
    '',
    '## Spec Deltas',
    ...specDeltas,
    '',
    '## Execution Rules',
    '- Read the OpenSpec artifacts before changing source code.',
    '- Implement the OpenSpec change; do not rewrite proposal.md, design.md, or spec delta files unless the user explicitly asks.',
    '- Update only downstream runtime state in implementation_plan.md while executing.',
    '- If OpenSpec and Autocode runtime files disagree, follow OpenSpec and note the drift in the completion summary.',
    '',
    '## Acceptance',
    '- OpenSpec tasks are completed or explicitly blocked with reason.',
    '- Code changes align with proposal, design, and spec deltas.',
    '- Verification evidence is recorded in the Autocode runtime outputs.',
  ].join('\n');
}

function buildOpenSpecRuntimeImplementationPlan(
  change: OpenSpecChangeSource,
  input: { title: string; description: string; now: string; language?: string },
): MutableAutocodePlan {
  const parsedTasks = change.tasks?.content
    ? parseAutocodeImplementationPlanMarkdown(change.tasks.content)
    : null;
  const parsedPhases = parsedTasks?.phases?.filter((phase) => {
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    return subtasks.length > 0;
  }) ?? [];

  const phases = buildOpenSpecRuntimeWorkPackagePhases(change, parsedPhases, input.language);

  return {
    feature: input.title,
    description: input.description,
    workflow_type: 'feature',
    status: 'pending',
    planStatus: 'pending',
    created_at: input.now,
    updated_at: input.now,
    phases,
    source_task: {
      kind: 'openspec-change',
      change_id: change.changeId,
      change_dir: change.relativeChangeDir,
      proposal: change.proposal?.relativePath,
      design: change.design?.relativePath,
      tasks: change.tasks?.relativePath,
      spec_deltas: change.specDeltas.map((delta) => delta.relativePath),
      context: AUTOCODE_TASK_ARTIFACTS.openSpecContext,
      runtime_granularity: 'work_package',
      ownership: {
        upstream: 'openspec',
        downstream: 'autocode-runtime',
      },
    },
  };
}

interface OpenSpecRuntimeTask {
  id: string;
  title: string;
  description: string;
  status: string;
  phaseId: string;
  phaseName: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  dependsOn: string[];
  requirements: string[];
  verification?: unknown;
}

interface OpenSpecRuntimeWorkPackage {
  id: string;
  title: string;
  phaseId: string;
  phaseName: string;
  tasks: OpenSpecRuntimeTask[];
  dependsOn: string[];
}

const OPENSPEC_WORK_PACKAGE_MAX_TASKS = 4;

function buildOpenSpecRuntimeWorkPackagePhases(
  change: OpenSpecChangeSource,
  parsedPhases: Array<Record<string, unknown>>,
  language?: string,
): MutableAutocodePlanPhase[] {
  const runtimeTasks = completeOpenSpecRuntimeTaskDependencyGraph(
    flattenOpenSpecRuntimeTasks(parsedPhases, language),
  );
  assertOpenSpecRuntimeTasksHaveValidDependencies(runtimeTasks);
  if (runtimeTasks.length === 0) {
    return [
      {
        id: '1',
        name: isChineseLanguage(language) ? 'OpenSpec 工作包' : 'OpenSpec work packages',
        subtasks: [
          buildOpenSpecFallbackWorkPackage(change, language),
        ],
      },
    ];
  }

  const workPackages = groupOpenSpecTasksIntoWorkPackages(runtimeTasks, language);
  return [
    {
      id: 'wp',
      name: isChineseLanguage(language) ? 'OpenSpec 工作包' : 'OpenSpec work packages',
      subtasks: workPackages.map((workPackage) => buildOpenSpecWorkPackageSubtask(change, workPackage, language)),
    },
  ];
}

function assertOpenSpecRuntimeTasksHaveValidDependencies(tasks: OpenSpecRuntimeTask[]): void {
  if (tasks.length === 0) {
    return;
  }
  const analysis = analyzeAutocodeWorkDependencies(
    tasks.map((task) => ({
      id: task.id,
      status: task.status,
      dependsOn: task.dependsOn,
    })),
  );
  if (analysis.issues.length === 0) {
    return;
  }

  const summary = describeAutocodeWorkDependencyBlockers(analysis.blocked);
  throw new Error(`OpenSpec task dependency graph is invalid: ${summary}`);
}

function flattenOpenSpecRuntimeTasks(parsedPhases: Array<Record<string, unknown>>, language?: string): OpenSpecRuntimeTask[] {
  const tasks: OpenSpecRuntimeTask[] = [];
  for (const [phaseIndex, phase] of parsedPhases.entries()) {
    const phaseId = stringFrom(phase.id ?? phase.phase) || String(phaseIndex + 1);
    const phaseName = stringFrom(phase.name ?? phase.title)
      || (isChineseLanguage(language) ? `OpenSpec 阶段 ${phaseIndex + 1}` : `OpenSpec phase ${phaseIndex + 1}`);
    const subtasks = Array.isArray(phase.subtasks)
      ? phase.subtasks
      : Array.isArray(phase.chunks)
        ? phase.chunks
        : [];
    for (const [subtaskIndex, rawSubtask] of subtasks.entries()) {
      if (!rawSubtask || typeof rawSubtask !== 'object') {
        continue;
      }
      const subtask = rawSubtask as Record<string, unknown>;
      const id = stringFrom(subtask.id ?? subtask.subtask_id) || `${phaseId}.${subtaskIndex + 1}`;
      const title = stringFrom(subtask.title ?? subtask.description)
        || (isChineseLanguage(language) ? `OpenSpec 任务 ${id}` : `OpenSpec task ${id}`);
      const description = sanitizeOpenSpecTaskDescriptionForRuntime(stringFrom(subtask.description) || title, title);
      tasks.push({
        id,
        title,
        description,
        status: stringFrom(subtask.status) || 'pending',
        phaseId,
        phaseName,
        filesToCreate: toStringArray(subtask.files_to_create),
        filesToModify: uniqueStrings([
          ...toStringArray(subtask.files_to_modify),
          ...toStringArray(subtask.files),
        ]),
        patternFiles: toStringArray(subtask.pattern_files),
        dependsOn: sanitizeOpenSpecDependencyIds(toStringArray(subtask.depends_on)),
        requirements: toStringArray(subtask.requirements),
        verification: subtask.verification,
      });
    }
  }
  return tasks;
}

function sanitizeOpenSpecTaskDescriptionForRuntime(description: string, fallbackTitle = ''): string {
  const cleanedLines = description
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripOpenSpecDependencyMetadataPrefix(line).trim())
    .filter(Boolean);
  return cleanedLines.join('\n') || fallbackTitle;
}

function stripOpenSpecDependencyMetadataPrefix(line: string): string {
  return line.replace(/^\s*(?:-\s+)?_(?:Depends on|依赖|依赖于|前置任务|前置|先决条件)\s*[:：]\s*[^_]+?_\s*/iu, '');
}

function sanitizeOpenSpecDependencyIds(values: string[]): string[] {
  return uniqueStrings(
    values.flatMap((value) => normalizeOpenSpecDependencyMetadataValue(value).split(/,\s*/u))
      .map((value) => value.trim())
      .filter((value) => value && value.toLowerCase() !== 'none')
      .filter((value) => /^[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*$/u.test(value)),
  );
}

function groupOpenSpecTasksIntoWorkPackages(tasks: OpenSpecRuntimeTask[], language?: string): OpenSpecRuntimeWorkPackage[] {
  const packages: OpenSpecRuntimeWorkPackage[] = [];
  let packageIndex = 1;

  const pushPackage = (packageTasks: OpenSpecRuntimeTask[]) => {
    if (packageTasks.length === 0) {
      return;
    }
    packages.push({
      id: `wp-${packageIndex++}`,
      title: buildWorkPackageTitle(packageTasks, language),
      phaseId: 'wp',
      phaseName: buildWorkPackagePhaseName(packageTasks, language),
      tasks: packageTasks,
      dependsOn: [],
    });
  };

  for (const phaseTasks of groupOpenSpecTasksByPhase(tasks)) {
    for (const packageTasks of buildOpenSpecTaskDependencyChains(phaseTasks)) {
      pushPackage(packageTasks);
    }
  }

  populateOpenSpecWorkPackageDependencies(packages);
  assertOpenSpecWorkPackagesHaveValidDependencies(packages);
  return packages;
}

function completeOpenSpecRuntimeTaskDependencyGraph(tasks: OpenSpecRuntimeTask[]): OpenSpecRuntimeTask[] {
  if (tasks.length <= 1) {
    return tasks;
  }

  const hasExplicitDependencyGraph = tasks.some((task) => task.dependsOn.length > 0);
  return tasks.map((task, index) => {
    if (task.dependsOn.length > 0) {
      return { ...task, dependsOn: uniqueStrings(task.dependsOn) };
    }

    const inferred = inferOpenSpecTaskDependencies(task, index, tasks, hasExplicitDependencyGraph);
    return inferred.length > 0
      ? { ...task, dependsOn: inferred }
      : { ...task, dependsOn: [] };
  });
}

function inferOpenSpecTaskDependencies(
  task: OpenSpecRuntimeTask,
  taskIndex: number,
  tasks: OpenSpecRuntimeTask[],
  hasExplicitDependencyGraph: boolean,
): string[] {
  const mentionedDependencies = extractOpenSpecTaskDependencyMentions(task, taskIndex, tasks);
  if (mentionedDependencies.length > 0) {
    return mentionedDependencies;
  }

  const previousSamePhase = findPreviousOpenSpecTaskInPhase(task, taskIndex, tasks);
  if (!hasExplicitDependencyGraph) {
    return previousSamePhase
      ? [previousSamePhase.id]
      : findPreviousOpenSpecPhaseTerminalTaskIds(task, taskIndex, tasks);
  }

  if (isVerificationOpenSpecTask(task)) {
    return previousSamePhase
      ? [previousSamePhase.id]
      : findPreviousOpenSpecPhaseTerminalTaskIds(task, taskIndex, tasks);
  }

  return [];
}

function extractOpenSpecTaskDependencyMentions(
  task: OpenSpecRuntimeTask,
  taskIndex: number,
  tasks: OpenSpecRuntimeTask[],
): string[] {
  const text = `${task.title}\n${task.description}`;
  if (!/\b(depends?|requires?|after|prerequisite|blocked by|based on)\b|依赖|前置|先完成|完成后|基于/u.test(text)) {
    return [];
  }

  const previousTasks = tasks.slice(0, taskIndex);
  const previousById = new Map(previousTasks.map((candidate) => [candidate.id, candidate]));
  return previousTasks
    .map((candidate) => candidate.id)
    .sort((left, right) => right.length - left.length)
    .filter((candidateId) => previousById.has(candidateId) && containsOpenSpecTaskId(text, candidateId));
}

function containsOpenSpecTaskId(text: string, taskId: string): boolean {
  const escaped = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9.])${escaped}($|[^A-Za-z0-9.])`, 'u').test(text);
}

function findPreviousOpenSpecTaskInPhase(
  task: OpenSpecRuntimeTask,
  taskIndex: number,
  tasks: OpenSpecRuntimeTask[],
): OpenSpecRuntimeTask | undefined {
  for (let index = taskIndex - 1; index >= 0; index -= 1) {
    const candidate = tasks[index];
    if (candidate.phaseId === task.phaseId) {
      return candidate;
    }
  }
  return undefined;
}

function findPreviousOpenSpecPhaseTerminalTaskIds(
  task: OpenSpecRuntimeTask,
  taskIndex: number,
  tasks: OpenSpecRuntimeTask[],
): string[] {
  for (let index = taskIndex - 1; index >= 0; index -= 1) {
    const candidate = tasks[index];
    if (candidate.phaseId !== task.phaseId) {
      return [candidate.id];
    }
  }
  return [];
}

function isVerificationOpenSpecTask(task: OpenSpecRuntimeTask): boolean {
  return /\b(test|verify|verification|validate|validation|qa|review)\b|测试|验证|验收|检查|审核/u
    .test(`${task.title}\n${task.description}`.toLowerCase());
}

function groupOpenSpecTasksByPhase(tasks: OpenSpecRuntimeTask[]): OpenSpecRuntimeTask[][] {
  const groups: OpenSpecRuntimeTask[][] = [];
  let active: OpenSpecRuntimeTask[] = [];
  let activePartitionId = '';

  for (const task of tasks) {
    const partitionId = getOpenSpecTaskPackagingPartitionId(task);
    if (active.length > 0 && activePartitionId !== partitionId) {
      groups.push(active);
      active = [];
    }
    active.push(task);
    activePartitionId = partitionId;
  }

  if (active.length > 0) {
    groups.push(active);
  }
  return groups;
}

function getOpenSpecTaskPackagingPartitionId(task: OpenSpecRuntimeTask): string {
  return isTopLevelOpenSpecTask(task) ? '__top_level_tasks__' : task.phaseId;
}

function buildOpenSpecTaskDependencyChains(tasks: OpenSpecRuntimeTask[]): OpenSpecRuntimeTask[][] {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const internalDependenciesById = new Map(tasks.map((task) => [task.id, new Set<string>()]));
  const internalChildrenById = new Map(tasks.map((task) => [task.id, new Set<string>()]));

  for (const task of tasks) {
    for (const dependencyId of task.dependsOn) {
      const dependency = taskById.get(dependencyId);
      if (!dependency || !canGroupOpenSpecTaskDependency(task, dependency)) {
        continue;
      }
      internalDependenciesById.get(task.id)?.add(dependencyId);
      internalChildrenById.get(dependencyId)?.add(task.id);
    }
  }

  const orderedTasks = topologicallySortOpenSpecTasks(tasks);
  const visited = new Set<string>();
  const chains: OpenSpecRuntimeTask[][] = [];

  for (const task of orderedTasks) {
    if (visited.has(task.id)) {
      continue;
    }

    const chain: OpenSpecRuntimeTask[] = [];
    let current: OpenSpecRuntimeTask | undefined = task;

    while (current && !visited.has(current.id) && chain.length < OPENSPEC_WORK_PACKAGE_MAX_TASKS) {
      chain.push(current);
      visited.add(current.id);

      const nextIds = [...(internalChildrenById.get(current.id) ?? [])]
        .filter((childId) => !visited.has(childId))
        .sort((left, right) => getOpenSpecTaskOrder(orderedTasks, left) - getOpenSpecTaskOrder(orderedTasks, right));
      if (nextIds.length !== 1) {
        break;
      }

      const [nextId] = nextIds;
      const next = taskById.get(nextId);
      const nextDependencies = internalDependenciesById.get(nextId) ?? new Set<string>();
      if (!next || nextDependencies.size !== 1 || !nextDependencies.has(current.id)) {
        break;
      }

      current = next;
    }

    chains.push(chain);
  }

  return chains;
}

function getOpenSpecTaskOrder(tasks: OpenSpecRuntimeTask[], taskId: string): number {
  const index = tasks.findIndex((task) => task.id === taskId);
  return index >= 0 ? index : Number.MAX_SAFE_INTEGER;
}

function canGroupOpenSpecTaskDependency(task: OpenSpecRuntimeTask, dependency: OpenSpecRuntimeTask): boolean {
  return task.phaseId === dependency.phaseId || (isTopLevelOpenSpecTask(task) && isTopLevelOpenSpecTask(dependency));
}

function isTopLevelOpenSpecTask(task: OpenSpecRuntimeTask): boolean {
  return !task.id.includes('.');
}

function topologicallySortOpenSpecTasks(tasks: OpenSpecRuntimeTask[]): OpenSpecRuntimeTask[] {
  const remaining = new Set(tasks.map((task) => task.id));
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const orderById = new Map(tasks.map((task, index) => [task.id, index]));
  const sorted: OpenSpecRuntimeTask[] = [];

  while (remaining.size > 0) {
    const runnable = [...remaining]
      .map((id) => taskById.get(id))
      .filter((task): task is OpenSpecRuntimeTask => Boolean(task))
      .filter((task) => task.dependsOn.every((dependencyId) => !remaining.has(dependencyId)))
      .sort((left, right) => (orderById.get(left.id) ?? 0) - (orderById.get(right.id) ?? 0));

    if (runnable.length === 0) {
      return tasks;
    }

    for (const task of runnable) {
      sorted.push(task);
      remaining.delete(task.id);
    }
  }

  return sorted;
}

function buildWorkPackagePhaseName(tasks: OpenSpecRuntimeTask[], language?: string): string {
  const packagePhases = uniqueStrings(tasks.map((task) => task.phaseName));
  return packagePhases.length === 1
    ? packagePhases[0]
    : isChineseLanguage(language)
      ? 'OpenSpec 工作包'
      : 'OpenSpec work packages';
}

function populateOpenSpecWorkPackageDependencies(packages: OpenSpecRuntimeWorkPackage[]): void {
  const packageByTaskId = new Map<string, string>();
  for (const workPackage of packages) {
    for (const task of workPackage.tasks) {
      packageByTaskId.set(task.id, workPackage.id);
    }
  }

  for (const workPackage of packages) {
    const dependsOn = new Set<string>();
    for (const task of workPackage.tasks) {
      for (const upstreamDependencyId of task.dependsOn) {
        const dependencyPackageId = packageByTaskId.get(upstreamDependencyId);
        if (dependencyPackageId && dependencyPackageId !== workPackage.id) {
          dependsOn.add(dependencyPackageId);
        }
      }
    }
    const packageOrder = new Map(packages.map((candidate, index) => [candidate.id, index]));
    workPackage.dependsOn = [...dependsOn].sort(
      (left, right) => (packageOrder.get(left) ?? 0) - (packageOrder.get(right) ?? 0),
    );
  }
}

function assertOpenSpecWorkPackagesHaveValidDependencies(packages: OpenSpecRuntimeWorkPackage[]): void {
  const analysis = analyzeAutocodeWorkDependencies(
    packages.map((workPackage) => ({
      id: workPackage.id,
      status: 'pending',
      dependsOn: workPackage.dependsOn,
    })),
  );
  if (analysis.issues.length > 0) {
    const summary = describeAutocodeWorkDependencyBlockers(analysis.blocked);
    throw new Error(`OpenSpec work package dependency graph is invalid: ${summary}`);
  }
}

function buildOpenSpecWorkPackageSubtask(
  change: OpenSpecChangeSource,
  workPackage: OpenSpecRuntimeWorkPackage,
  language?: string,
): MutableAutocodePlanSubtask {
  const upstreamTaskIds = workPackage.tasks.map((task) => task.id);
  const filesToCreate = uniqueStrings(workPackage.tasks.flatMap((task) => task.filesToCreate));
  const filesToModify = uniqueStrings(workPackage.tasks.flatMap((task) => task.filesToModify));
  const patternFiles = uniqueStrings(workPackage.tasks.flatMap((task) => task.patternFiles));
  const requirements = uniqueStrings([
    ...upstreamTaskIds,
    ...workPackage.tasks.flatMap((task) => task.requirements),
  ]);

  return {
    id: workPackage.id,
    title: workPackage.title,
    description: buildRuntimeWorkPackageDescription(change, workPackage, language),
    status: workPackage.tasks.every((task) => task.status === 'completed') ? 'completed' : 'pending',
    ...(filesToCreate.length > 0 ? { files_to_create: filesToCreate } : {}),
    ...(filesToModify.length > 0 ? { files_to_modify: filesToModify } : {}),
    ...(patternFiles.length > 0 ? { pattern_files: patternFiles } : {}),
    ...(workPackage.dependsOn.length > 0 ? { depends_on: workPackage.dependsOn } : {}),
    ...(requirements.length > 0 ? { requirements } : {}),
    verification: {
      type: 'manual',
      run: buildWorkPackageVerification(workPackage, language),
    },
    upstream_source: change.tasks?.relativePath ?? change.relativeChangeDir,
    upstream_task_ids: upstreamTaskIds,
    work_package: true,
  };
}

function buildOpenSpecFallbackWorkPackage(change: OpenSpecChangeSource, language?: string): MutableAutocodePlanSubtask {
  if (isChineseLanguage(language)) {
    return {
      id: 'wp-1',
      title: `实现 OpenSpec 变更 ${change.changeId}`,
      description: [
        '基于精简 OpenSpec 上下文实现此运行工作包。',
        '',
        `先阅读 ${AUTOCODE_TASK_ARTIFACTS.openSpecContext}，只有需要精确措辞时再打开完整 OpenSpec 文档。`,
        '',
        '事实来源：',
        ...listOpenSpecSourcePaths(change).map((path) => `- ${path}`),
      ].join('\n'),
      status: 'pending',
      pattern_files: listOpenSpecSourcePaths(change),
      verification: {
        type: 'manual',
        run: '确认实现满足 OpenSpec 变更，并记录验证证据。',
      },
      upstream_source: change.relativeChangeDir,
      upstream_task_ids: [],
      work_package: true,
    };
  }

  return {
    id: 'wp-1',
    title: `Implement OpenSpec change ${change.changeId}`,
    description: [
      'Implement this runtime work package from the compact OpenSpec context.',
      '',
      `Read ${AUTOCODE_TASK_ARTIFACTS.openSpecContext} first, then open full OpenSpec artifacts only when exact wording is needed.`,
      '',
      'Source of truth:',
      ...listOpenSpecSourcePaths(change).map((path) => `- ${path}`),
    ].join('\n'),
    status: 'pending',
    pattern_files: listOpenSpecSourcePaths(change),
    verification: {
      type: 'manual',
      run: 'Confirm the implementation satisfies the OpenSpec change and record verification evidence.',
    },
    upstream_source: change.relativeChangeDir,
    upstream_task_ids: [],
    work_package: true,
  };
}

function buildRuntimeWorkPackageDescription(
  change: OpenSpecChangeSource,
  workPackage: OpenSpecRuntimeWorkPackage,
  language?: string,
): string {
  if (isChineseLanguage(language)) {
    return [
      '实现此运行工作包，它合并了多个上游 OpenSpec 任务。',
      '',
      `先阅读 ${AUTOCODE_TASK_ARTIFACTS.openSpecContext}。只有需要精确需求或设计措辞时，再打开完整 OpenSpec 文档。`,
      '',
      `上游变更：${change.changeId}`,
      `上游任务：${workPackage.tasks.map((task) => task.id).join(', ')}`,
      '',
      '包含的 OpenSpec 任务：',
      ...workPackage.tasks.flatMap((task) => [
        `- ${task.id} ${task.title}`,
        `  ${singleLine(sanitizeOpenSpecTaskDescriptionForRuntime(task.description, task.title))}`,
        ...(task.dependsOn.length > 0 ? [`  依赖：${task.dependsOn.join(', ')}`] : []),
      ]),
      '',
      '运行规则：在单次 agent 执行中完成所有包含的上游任务，然后将此工作包标记为完成。',
    ].join('\n');
  }

  return [
    'Implement this runtime work package, which covers multiple upstream OpenSpec tasks.',
    '',
    `Read ${AUTOCODE_TASK_ARTIFACTS.openSpecContext} first. Open full OpenSpec artifacts only when exact requirement/design wording is needed.`,
    '',
    `Upstream change: ${change.changeId}`,
    `Upstream tasks: ${workPackage.tasks.map((task) => task.id).join(', ')}`,
    '',
    'Included OpenSpec tasks:',
    ...workPackage.tasks.flatMap((task) => [
      `- ${task.id} ${task.title}`,
      `  ${singleLine(sanitizeOpenSpecTaskDescriptionForRuntime(task.description, task.title))}`,
      ...(task.dependsOn.length > 0 ? [`  Depends on: ${task.dependsOn.join(', ')}`] : []),
    ]),
    '',
    'Runtime rule: complete all included upstream tasks in this single agent run, then mark this work package completed.',
  ].join('\n');
}

function buildWorkPackageTitle(tasks: OpenSpecRuntimeTask[], language?: string): string {
  if (tasks.length === 1) {
    return isChineseLanguage(language) ? `工作包：${tasks[0].title}` : `Work package: ${tasks[0].title}`;
  }
  const first = tasks[0]?.title ?? (isChineseLanguage(language) ? 'OpenSpec 任务' : 'OpenSpec tasks');
  return isChineseLanguage(language)
    ? `工作包：${first}（另含 ${tasks.length - 1} 个相关任务）`
    : `Work package: ${first} (+${tasks.length - 1} related tasks)`;
}

function buildWorkPackageVerification(workPackage: OpenSpecRuntimeWorkPackage, language?: string): string {
  const verifications = uniqueStrings(
    workPackage.tasks
      .map((task) => stringifyVerification(task.verification))
      .filter(Boolean),
  );
  return verifications.length > 0
    ? verifications.join('; ')
    : isChineseLanguage(language)
      ? '运行此工作包最相关的最小验证，并记录结果。'
      : 'Run the smallest relevant validation for this work package and record the result.';
}

function buildOpenSpecContextMarkdown(change: OpenSpecChangeSource, language?: string): string {
  if (isChineseLanguage(language)) {
    return [
      `# OpenSpec 上下文：${change.changeId}`,
      '',
      '此精简上下文供下游 Autocode 执行使用。只有需要精确措辞时，才打开完整 OpenSpec 文档。',
      '',
      '## 来源文件',
      ...listOpenSpecSourcePaths(change).map((path) => `- ${path}`),
      '',
      '## 提案摘要',
      summarizeMarkdownArtifact(change.proposal?.content, 1400, language),
      '',
      '## 设计摘要',
      summarizeMarkdownArtifact(change.design?.content, 1800, language),
      '',
      '## 规格增量摘要',
      change.specDeltas.length > 0
        ? change.specDeltas.map((delta) => `### ${delta.capability}\n${summarizeMarkdownArtifact(delta.content, 1200, language)}`).join('\n\n')
        : '无。',
      '',
      '## 任务摘要',
      summarizeOpenSpecTasks(change.tasks?.content, language),
      '',
    ].join('\n');
  }

  return [
    `# OpenSpec Context: ${change.changeId}`,
    '',
    'This compact context is for downstream Autocode execution. Open full OpenSpec artifacts only when exact wording is needed.',
    '',
    '## Source Files',
    ...listOpenSpecSourcePaths(change).map((path) => `- ${path}`),
    '',
    '## Proposal Summary',
    summarizeMarkdownArtifact(change.proposal?.content, 1400, language),
    '',
    '## Design Summary',
    summarizeMarkdownArtifact(change.design?.content, 1800, language),
    '',
    '## Spec Delta Summary',
    change.specDeltas.length > 0
      ? change.specDeltas.map((delta) => `### ${delta.capability}\n${summarizeMarkdownArtifact(delta.content, 1200, language)}`).join('\n\n')
      : 'None.',
    '',
    '## Task Summary',
    summarizeOpenSpecTasks(change.tasks?.content, language),
    '',
  ].join('\n');
}

function summarizeMarkdownArtifact(content: string | undefined, maxLength: number, language?: string): string {
  if (!content?.trim()) {
    return isChineseLanguage(language) ? '无。' : 'None.';
  }
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('<!--'));
  const important = lines.filter((line) => /^#{1,4}\s+/.test(line) || /^[-*]\s+/.test(line) || /^WHEN|^THEN|^\-\s+\*\*/i.test(line));
  const summary = (important.length > 0 ? important : lines).join('\n');
  return summary.length > maxLength ? `${summary.slice(0, maxLength).trimEnd()}\n...[truncated]` : summary;
}

function summarizeOpenSpecTasks(content: string | undefined, language?: string): string {
  if (!content?.trim()) {
    return isChineseLanguage(language) ? '无。' : 'None.';
  }
  const taskLines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\[[ xX/!\-]\]\s+/.test(line) || /^-\s+_/.test(line));
  const summary = taskLines.join('\n');
  return summary.length > 2600 ? `${summary.slice(0, 2600).trimEnd()}\n...[truncated]` : summary;
}

function listOpenSpecSourcePaths(change: OpenSpecChangeSource): string[] {
  return [
    change.proposal?.relativePath,
    change.design?.relativePath,
    change.tasks?.relativePath,
    ...change.specDeltas.map((delta) => delta.relativePath),
  ].filter((path): path is string => Boolean(path));
}

function readOpenSpecArtifact(
  projectRoot: string,
  changeDir: string,
  fileName: string,
): OpenSpecArtifact | undefined {
  const absolutePath = join(changeDir, fileName);
  if (!existsSync(absolutePath)) {
    return undefined;
  }
  return {
    fileName,
    relativePath: toProjectRelativePath(projectRoot, absolutePath),
    absolutePath,
    content: readFileSync(absolutePath, 'utf8'),
  };
}

function collectOpenSpecSpecDeltas(projectRoot: string, changeDir: string): OpenSpecSpecDelta[] {
  const specsDir = join(changeDir, OPENSPEC_SPECS_DIR_NAME);
  if (!existsSync(specsDir)) {
    return [];
  }

  return listMarkdownFiles(specsDir)
    .map((absolutePath) => {
      const relativePath = toProjectRelativePath(projectRoot, absolutePath);
      const relativeToSpecs = relative(specsDir, absolutePath).replace(/\\/g, '/');
      const capability = relativeToSpecs.split('/')[0] || 'unknown';
      return {
        fileName: basename(absolutePath),
        relativePath,
        absolutePath,
        content: readFileSync(absolutePath, 'utf8'),
        capability,
      };
    })
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function listMarkdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listMarkdownFiles(fullPath);
    }
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [fullPath] : [];
  });
}

function resolveOpenSpecChangeDir(projectRoot: string, input: OpenSpecChangeSourceInput): string {
  if (input.changeDir?.trim()) {
    const rawChangeDir = input.changeDir.trim();
    const absoluteChangeDir = resolve(projectRoot, rawChangeDir);
    assertPathWithinProject(projectRoot, absoluteChangeDir, 'changeDir');
    return absoluteChangeDir;
  }

  const changeId = requireNonEmpty(input.changeId ?? '', 'changeId');
  return getOpenSpecChangeDir(projectRoot, changeId);
}

function scaffoldOpenSpecChange(
  adapter: OpenSpecCliAdapter | false | undefined,
  input: OpenSpecCreateChangeCliInput,
): OpenSpecCliCommandResult | undefined {
  if (adapter === false) {
    return undefined;
  }

  const cli = adapter ?? createProcessOpenSpecCliAdapter();
  return cli.createChange(input);
}

function formatOpenSpecCliInvocation(result: OpenSpecCliCommandResult): string {
  return [result.command, ...result.args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(' ');
}

function runProcessOpenSpecCommand(
  openSpecArgs: string[],
  cwd: string,
  options: ProcessOpenSpecCliAdapterOptions,
): OpenSpecCliCommandResult {
  const env = { ...process.env, ...options.env };
  const invocation = resolveOpenSpecCliInvocation(options.command, env);
  const commandArgs = [...invocation.argsPrefix, ...openSpecArgs];
  const result = spawnSync(invocation.command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env,
    timeout: options.timeoutMs ?? 30_000,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  if (result.error) {
    throw new Error(`Failed to run OpenSpec CLI (${invocation.displayCommand}): ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${result.status}`;
    throw new Error(`OpenSpec CLI failed: ${detail}`);
  }

  return {
    command: invocation.displayCommand,
    args: openSpecArgs,
    cwd,
    status: result.status,
    stdout,
    stderr,
  };
}

function parseOpenSpecJson<T>(result: OpenSpecCliCommandResult, label: string): T {
  const raw = result.stdout.trim();
  const objectStart = raw.indexOf('{');
  const arrayStart = raw.indexOf('[');
  const startCandidates = [objectStart, arrayStart].filter((index) => index >= 0);
  const start = startCandidates.length > 0 ? Math.min(...startCandidates) : -1;
  const end = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (start < 0 || end < start) {
    throw new Error(`${label} did not return JSON.`);
  }

  try {
    return JSON.parse(raw.slice(start, end + 1)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} returned invalid JSON: ${message}`);
  }
}

interface OpenSpecCliInvocation {
  command: string;
  argsPrefix: string[];
  displayCommand: string;
}

function resolveOpenSpecCliInvocation(
  command = 'openspec',
  env: NodeJS.ProcessEnv = process.env,
): OpenSpecCliInvocation {
  if (process.platform !== 'win32') {
    return { command, argsPrefix: [], displayCommand: command };
  }

  const resolved = resolveWindowsOpenSpecCommand(command, env);
  if (!resolved) {
    return { command, argsPrefix: [], displayCommand: command };
  }

  const lower = resolved.toLowerCase();
  if (lower.endsWith('.ps1')) {
    return {
      command: 'powershell.exe',
      argsPrefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolved],
      displayCommand: resolved,
    };
  }

  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return {
      command: 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', resolved],
      displayCommand: resolved,
    };
  }

  return { command: resolved, argsPrefix: [], displayCommand: resolved };
}

function resolveWindowsOpenSpecCommand(command: string, env: NodeJS.ProcessEnv): string | null {
  if (/[\\/]/.test(command)) {
    return existsSync(command) ? command : null;
  }

  const names = command.includes('.') ? [command] : [`${command}.ps1`, `${command}.cmd`, `${command}.exe`, command];
  for (const dir of windowsOpenSpecSearchDirs(env)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

function windowsOpenSpecSearchDirs(env: NodeJS.ProcessEnv): string[] {
  const dirs = new Set<string>();
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim()) {
      dirs.add(dir.trim());
    }
  }

  const appData = env.APPDATA || (env.USERPROFILE ? join(env.USERPROFILE, 'AppData', 'Roaming') : '');
  if (appData) {
    dirs.add(join(appData, 'npm'));
  }

  return [...dirs];
}

function assertPathWithinProject(projectRoot: string, targetPath: string, name: string): void {
  const relativePath = relative(projectRoot, targetPath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.includes(`..\\`) && !relativePath.includes('../'))) {
    return;
  }
  throw new Error(`${name} must be inside the project root.`);
}

function inferOpenSpecChangeTitle(
  changeId: string,
  proposal: OpenSpecArtifact | undefined,
  design: OpenSpecArtifact | undefined,
  specDeltas: OpenSpecSpecDelta[],
): string {
  return firstMarkdownHeading(proposal?.content)
    || firstMarkdownHeading(design?.content)
    || firstMarkdownHeading(specDeltas[0]?.content)
    || titleFromChangeId(changeId);
}

function firstMarkdownHeading(content: string | undefined): string {
  if (!content) {
    return '';
  }
  const match = /^#\s+(.+?)\s*$/m.exec(content);
  return cleanMarkdownTitle(match?.[1] ?? '');
}

function firstMarkdownParagraph(content: string | undefined): string {
  if (!content) {
    return '';
  }
  const lines = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('- [') && !line.startsWith('```'));
  return lines[0] ?? '';
}

function cleanMarkdownTitle(title: string): string {
  return title
    .replace(/^(proposal|design|specification|spec|change)\s*:\s*/i, '')
    .replace(/`/g, '')
    .trim();
}

function titleFromChangeId(changeId: string): string {
  return changeId
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim();
}

function inferOpenSpecChangeComplexity(change: OpenSpecChangeSource): 'small' | 'medium' | 'large' | 'complex' {
  const subtaskCount = change.tasks?.content
    ? countTaskCheckboxes(change.tasks.content)
    : 0;
  const deltaCount = change.specDeltas.length;
  if (subtaskCount >= 12 || deltaCount >= 4) return 'complex';
  if (subtaskCount >= 7 || deltaCount >= 2) return 'large';
  if (subtaskCount >= 3 || deltaCount >= 1 || change.design) return 'medium';
  return 'small';
}

function countTaskCheckboxes(content: string): number {
  return content.split(/\r?\n/).filter((line) => /^\s*-\s+\[[ xX]\]\s+/.test(line)).length;
}

function assertValidOpenSpecChangeId(changeId: string): void {
  if (!isOpenSpecChangeId(changeId)) {
    throw new Error(`Invalid OpenSpec change id: ${changeId}`);
  }
}

function isOpenSpecChangeId(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9._-]*$/.test(value) && value !== '.' && value !== '..';
}

function requireNonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}

function toProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return relative(projectRoot, absolutePath).replace(/\\/g, '/');
}

function nextOpenSpecChangeId(projectRoot: string, baseId: string): string {
  const normalizedBase = normalizeOpenSpecChangeId(baseId);
  const changesDir = getOpenSpecChangesDir(projectRoot);
  let candidate = normalizedBase;
  let suffix = 2;
  while (existsSync(join(changesDir, candidate))) {
    candidate = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function normalizeOpenSpecChangeId(value: string | undefined, fallback = 'change'): string {
  const fallbackValue = fallback.trim() || 'change';
  let normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .replace(/[._-]{2,}/g, '-')
    .slice(0, 80) ?? '';

  if (!normalized) {
    normalized = fallbackValue
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[._-]+|[._-]+$/g, '')
      .replace(/[._-]{2,}/g, '-')
      .slice(0, 80) || 'change';
  }

  if (!/^[a-z]/.test(normalized)) {
    normalized = `change-${normalized}`;
  }

  return normalized
    .replace(/[._-]+$/g, '')
    .slice(0, 80) || 'change';
}

function normalizeOpenSpecCapability(value: string | undefined): string {
  const normalized = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) ?? '';
  return normalized || '';
}

function mergeRequirementList(existing: unknown, fallback: string[]): string[] {
  const merged = [...toStringArray(existing), ...fallback];
  return [...new Set(merged.map((item) => singleLine(item)).filter(Boolean))];
}

function markdownList(items: string[]): string[] {
  const values = items.map((item) => singleLine(item)).filter(Boolean);
  return values.length > 0 ? values.map((item) => `- ${item}`) : ['- None'];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => stringFrom(item)).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => singleLine(item)).filter(Boolean))];
}

function stringifyVerification(value: unknown): string {
  if (typeof value === 'string') {
    return singleLine(value);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return singleLine(stringFrom(record.run) || stringFrom(record.command) || stringFrom(record.scenario) || stringFrom(record.description));
  }
  return '';
}

function toReferencedFilePaths(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (item && typeof item === 'object') {
        const record = item as Record<string, unknown>;
        return stringFrom(record.path) || stringFrom(record.name);
      }
      return stringFrom(item);
    })
    .filter(Boolean);
}

function resolveOpenSpecLanguage(language: unknown, metadata?: AutocodeTaskMetadata): string | undefined {
  return stringFrom(language) || stringFrom(metadata?.language);
}

function isChineseLanguage(language: unknown): boolean {
  const normalized = stringFrom(language).toLowerCase().replace(/_/g, '-');
  return normalized === 'zh' || normalized.startsWith('zh-') || normalized.includes('chinese');
}

function stringFrom(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateTitle(description: string): string {
  return description.split(/\r?\n/)[0]?.trim().slice(0, 80) || 'OpenSpec change';
}

function scenarioTitle(value: string, index: number): string {
  const title = singleLine(value).replace(/[.:;!?]+$/g, '').slice(0, 72);
  return title || `Acceptance ${index + 1}`;
}
