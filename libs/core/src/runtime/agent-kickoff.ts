import type { AgentType } from '../config/agent-configs.js';
import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import {
  appendAutocodeLanguageRequirement,
  getAutocodeImplementationPlanLanguageRequirement,
  type AutocodeOutputLanguage,
} from './agent-language.js';

const PRIOR_PHASE_CONTEXT_TOTAL_MAX_CHARS = 10_000;
const PRIOR_PHASE_CONTEXT_FILE_MAX_CHARS = 2_800;
const PRIOR_PHASE_CONTEXT_LINE_MAX_CHARS = 220;
const PRIOR_PHASE_CONTEXT_HEADING_LIMIT = 10;
const PRIOR_PHASE_CONTEXT_BULLET_LIMIT = 18;
const PRIOR_PHASE_CONTEXT_PARAGRAPH_LIMIT = 4;
const PRIOR_PHASE_CONTEXT_EXCERPT_MAX_CHARS = 900;
const PROJECT_DOCS_REFERENCE_MAX_CHARS = 6_000;
const PROJECT_DOCS_REFERENCE_EXCERPT_MAX_CHARS = 1_200;
const PROJECT_DOCS_REFERENCE_HEADING_LIMIT = 8;
const PROJECT_DOCS_REFERENCE_BULLET_LIMIT = 16;
const PROJECT_DOCS_REFERENCE_PARAGRAPH_LIMIT = 4;
export const AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS = 4_000;
const TASK_DESCRIPTION_COMPACTION_NOTICE =
  '\n\n...[task description middle omitted for prompt budget; preserve visible requirements and inspect the source task if exact omitted detail is required]...\n\n';

export interface BuildAutocodeSpecKickoffMessageInput {
  agentType: AgentType | string;
  specDir: string;
  projectDir: string;
  taskDescription: string;
  priorPhaseOutputs?: Record<string, string>;
  /** Generated project documentation reference text from project-docs/index.md and related docs. */
  projectDocsReference?: string;
  /** @deprecated Use projectDocsReference. */
  projectIndex?: string;
  specPhase?: string;
  language?: AutocodeOutputLanguage;
}

export interface BuildAutocodeAgentKickoffMessageInput {
  agentType: AgentType | string;
  specDir: string;
  projectDir: string;
  subtaskId?: string;
  language?: AutocodeOutputLanguage;
  forcePlanning?: boolean;
  focusedCoderKickoff?: string;
}

export interface BuildAutocodeFallbackPromptInput {
  agentType: AgentType | string;
  specDir: string;
  projectDir: string;
}

export function formatAutocodePathForPrompt(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

export function resolveAutocodePromptNameForAgent(agentType: AgentType | string): string {
  if (agentType.startsWith('mmo_')) {
    return agentType;
  }
  return agentType === 'coder' ? 'coder' : agentType;
}

export function buildAutocodeSpecKickoffMessage(
  input: BuildAutocodeSpecKickoffMessageInput,
): string {
  const promptSpecDir = formatAutocodePathForPrompt(input.specDir);
  const promptProjectDir = formatAutocodePathForPrompt(input.projectDir);
  const taskDescription = compactAutocodeKickoffTaskDescription(input.taskDescription);
  let baseMessage: string;

  if (input.specPhase === 'complexity_assessment') {
    baseMessage = `Assess task complexity and return the complete complexity_assessment.json object for ${promptSpecDir}/complexity_assessment.json. Task: ${taskDescription}. Project root: ${promptProjectDir}. Classify as SIMPLE, STANDARD, or COMPLEX from task scope and project structure only. This is the first spec phase; spec.md and later spec files do not exist yet.`;
  } else {
    switch (input.agentType) {
      case 'spec_discovery':
        baseMessage = `Analyze ${promptProjectDir} for architecture, stack, conventions, source evidence, and verification commands relevant to: ${taskDescription}. Use the Write tool to create ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.context} as concise Markdown. spec.md does not exist yet. Use the project documentation reference first, run targeted discovery tools only for files or standards that directly affect the task, and omit transcripts, copied source, long analysis, and large optional sections. Include sections for Task, Scoped Services, Architecture Summary, Files To Modify, Files To Reference, Design Patterns, Implementation Notes, Risks, Verification Suggestions, Assumptions, and Evidence Sources. Evidence Sources must be bullets with path, optional symbol/lines, what it proves, and confidence.`;
        break;
      case 'spec_gatherer':
        baseMessage = `Gather evidence-backed requirements for: ${taskDescription}. Project root: ${promptProjectDir}. Return one compact JSON object for requirements.md; the orchestrator writes ${promptSpecDir}/requirements.md. spec.md does not exist yet. Derive requirements from the user request, provided context, targeted source evidence, and verified standards only; put missing details in assumptions. Include evidence_sources, standards_references, and assumptions. No prose or markdown fence outside the JSON.`;
        break;
      case 'spec_researcher':
        baseMessage = `Research external dependencies, APIs, SDKs, platform rules, security/accessibility requirements, or integration constraints for: ${taskDescription}. Use task context, prior outputs, and project documentation reference first; read code in ${promptProjectDir} only when needed. Prefer official documentation, standards bodies, vendor docs, or project-local documentation. Use the Write tool to create ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.research} as concise Markdown. If no research is needed, still write ${AUTOCODE_TASK_ARTIFACTS.research} with "None required" and concise recommendations.`;
        break;
      case 'spec_writer':
        baseMessage = `Write an evidence-backed spec.md for: ${taskDescription}. Target: ${promptSpecDir}/spec.md. Project root: ${promptProjectDir}. Use provided phase context as source of truth; read prior files only if missing. Keep spec.md as a compact decision index, not a full analysis dump. Include proposal, requirements, design notes, touched files, acceptance checks, evidence, standards/references, assumptions, and risks.`;
        break;
      case 'planner':
        baseMessage = [
          `Create ${promptSpecDir}/tasks.md for: ${taskDescription}.`,
          'Use provided phase context first; read only relevant spec.md sections if needed.',
          `Use Autocode Standard planning: update ${promptSpecDir}/spec.md with proposal/requirements/design/acceptance/risk sections when missing or stale.`,
          'Output concrete Autocode Markdown checklist tasks with source-backed guidance, dependencies, requirement links, evidence notes, and verification commands.',
          `Do not write ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}; the runtime derives it.`,
          `Project root: ${promptProjectDir}.`,
        ].join(' ');
        break;
      case 'spec_critic':
        baseMessage = `Review and critique the specification at ${promptSpecDir}/spec.md for completeness, clarity, and technical feasibility. Write your critique findings back to ${promptSpecDir}/spec.md with improvements.`;
        break;
      case 'spec_context':
        baseMessage = `Gather project context for: ${taskDescription}. Use the Write tool to create ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.context} as concise Markdown. spec.md does not exist yet. Use narrow reads and omit transcripts, copied source, and long analysis. Include an Evidence Sources section with file/project-doc/standard citations.`;
        break;
      case 'spec_validation':
        baseMessage = `Validate that ${promptSpecDir}/spec.md and ${promptSpecDir}/implementation_plan.md are complete, consistent, and ready for implementation. Use targeted reads with limits; do not read entire large files unless required. Fix only blocking issues. If ${promptSpecDir}/spec.md already exists and needs corrections, use Edit for the smallest affected section instead of rewriting the whole file.`;
        break;
      default:
        baseMessage = `Complete the Autocode Standard planning task described in your system prompt. Task: ${taskDescription}. Spec directory: ${promptSpecDir}. Project directory: ${promptProjectDir}`;
    }
  }

  const contextSections: string[] = [baseMessage];
  if (shouldAddStandardPlanningEvidenceContract(input.agentType, input.specPhase)) {
    contextSections.push(buildAutocodeStandardPlanningEvidenceContract(promptProjectDir, promptSpecDir));
  }
  const projectDocsReferenceInput = input.projectDocsReference ?? input.projectIndex;
  if (projectDocsReferenceInput) {
    contextSections.push(`\n\n${buildProjectDocsReferenceSection(projectDocsReferenceInput)}`);
  }

  const planLanguageRequirement = (input.agentType === 'planner' || input.specPhase === 'quick_spec')
    ? getAutocodeImplementationPlanLanguageRequirement(input.language)
    : null;
  if (planLanguageRequirement) {
    contextSections.push(`\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n\n${planLanguageRequirement}`);
  }

  if (input.priorPhaseOutputs && Object.keys(input.priorPhaseOutputs).length > 0) {
    contextSections.push('\n\n## CONTEXT FROM PRIOR PHASES\n\nThe following outputs from earlier spec phases are provided to avoid re-reading files:');
    contextSections.push(buildPriorPhaseOutputsSection(input.priorPhaseOutputs));
    contextSections.push('\nUse these outputs as your primary source of context. Only read additional project files if you need specific code patterns not covered above.');
  }

  return appendAutocodeLanguageRequirement(contextSections.join(''), input.language);
}

function buildProjectDocsReferenceSection(projectDocsReferenceInput: string): string {
  const normalized = normalizePriorPhaseOutput(projectDocsReferenceInput);
  const reference = hasProjectDocsReferenceHeading(normalized)
    ? normalized
    : `## Project Documentation Reference\n\n${normalized}`;
  if (reference.length <= PROJECT_DOCS_REFERENCE_MAX_CHARS) {
    return reference;
  }

  return compactProjectDocsReference(reference, PROJECT_DOCS_REFERENCE_MAX_CHARS);
}

function hasProjectDocsReferenceHeading(value: string): boolean {
  return /^##\s+(?:Project Documentation Reference|项目文档参考)\b/i.test(value.trimStart());
}

function compactProjectDocsReference(content: string, maxChars: number): string {
  const headings: string[] = [];
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let inFence = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,4}\s+\S/.test(line)) {
      pushCompactUnique(headings, line.replace(/^#{1,4}\s+/, ''), PROJECT_DOCS_REFERENCE_HEADING_LIMIT);
      continue;
    }
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      pushCompactUnique(bullets, line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''), PROJECT_DOCS_REFERENCE_BULLET_LIMIT);
      continue;
    }
    if (line.length >= 28) {
      pushCompactUnique(paragraphs, line, PROJECT_DOCS_REFERENCE_PARAGRAPH_LIMIT);
    }
  }

  const lines = [
    '## Project Documentation Reference',
    '',
    '> Compact excerpt; generated project documentation exceeded the kickoff budget. Read `.autocode/project-docs/index.md` or the referenced Markdown files for exact detail.',
    '',
    'Reference excerpt:',
    limitPromptText(
      content,
      Math.min(PROJECT_DOCS_REFERENCE_EXCERPT_MAX_CHARS, Math.max(0, maxChars - 320)),
      '\n...[project docs reference middle omitted; read project-docs/index.md if needed]...\n',
    ),
    '',
  ];
  appendCompactSection(lines, 'Key headings', headings.filter((heading) => heading !== 'Project Documentation Reference'));
  appendCompactSection(lines, 'Selected bullets', bullets);
  appendCompactSection(lines, 'Selected notes', paragraphs);

  if (headings.length === 0 && bullets.length === 0 && paragraphs.length === 0) {
    lines.push(limitPromptText(content, Math.max(0, maxChars - 120), '\n...[project docs reference truncated; read project-docs/index.md if needed]'));
  }

  return limitPromptText(
    lines.join('\n').trimEnd(),
    maxChars,
    '\n...[compact project docs reference truncated; read project-docs/index.md if needed]',
  );
}

function buildPriorPhaseOutputsSection(priorPhaseOutputs: Record<string, string>): string {
  const sections: string[] = [];
  let remaining = PRIOR_PHASE_CONTEXT_TOTAL_MAX_CHARS;
  let omitted = 0;

  for (const [fileName, content] of Object.entries(priorPhaseOutputs)) {
    const normalized = normalizePriorPhaseOutput(content);
    if (!normalized) {
      continue;
    }

    const sectionBudget = Math.min(PRIOR_PHASE_CONTEXT_FILE_MAX_CHARS, Math.max(0, remaining));
    if (sectionBudget <= 240) {
      omitted += 1;
      continue;
    }

    const compact = compactPriorPhaseOutput(fileName, normalized, sectionBudget);
    const ext = fileName.endsWith('.json') ? 'json' : 'markdown';
    const section = `\n### ${fileName}\n\n\`\`\`${ext}\n${compact}\n\`\`\``;
    sections.push(section);
    remaining -= section.length;
  }

  if (omitted > 0) {
    sections.push(`\n${omitted} prior output file(s) omitted from kickoff to stay within context budget. Read the exact artifact only if needed.`);
  }

  return sections.join('');
}

function compactPriorPhaseOutput(fileName: string, content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  if (fileName.endsWith('.json')) {
    const jsonSummary = summarizePriorPhaseJson(content, maxChars);
    if (jsonSummary) {
      return jsonSummary;
    }
  }

  const headings: string[] = [];
  const bullets: string[] = [];
  const paragraphs: string[] = [];
  let inFence = false;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (/^#{1,4}\s+\S/.test(line)) {
      pushCompactUnique(headings, line.replace(/^#{1,4}\s+/, ''), PRIOR_PHASE_CONTEXT_HEADING_LIMIT);
      continue;
    }
    if (/^(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      pushCompactUnique(bullets, line.replace(/^(?:[-*+]|\d+[.)])\s+/, ''), PRIOR_PHASE_CONTEXT_BULLET_LIMIT);
      continue;
    }
    if (line.length >= 28) {
      pushCompactUnique(paragraphs, line, PRIOR_PHASE_CONTEXT_PARAGRAPH_LIMIT);
    }
  }

  const lines = [
    `Compact excerpt of ${fileName}. Read the artifact directly for exact wording or omitted detail.`,
    '',
    'Content excerpt:',
    limitPromptText(
      content,
      Math.min(PRIOR_PHASE_CONTEXT_EXCERPT_MAX_CHARS, Math.max(0, maxChars - 320)),
      '\n...[prior output middle omitted; read artifact if needed]...\n',
    ),
    '',
  ];
  appendCompactSection(lines, 'Key headings', headings);
  appendCompactSection(lines, 'Selected bullets', bullets);
  appendCompactSection(lines, 'Selected notes', paragraphs);

  if (headings.length === 0 && bullets.length === 0 && paragraphs.length === 0) {
    lines.push(limitPromptText(content, Math.max(0, maxChars - 96), '\n...[truncated; read artifact if needed]'));
  }

  return limitPromptText(lines.join('\n').trimEnd(), maxChars, '\n...[compact prior output truncated; read artifact if needed]');
}

function summarizePriorPhaseJson(content: string, maxChars: number): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    const summary = summarizeJsonValue(parsed);
    return limitPromptText(
      `Compact JSON summary. Read the artifact directly for exact values.\n${JSON.stringify(summary, null, 2)}`,
      maxChars,
      '\n...[compact JSON summary truncated; read artifact if needed]',
    );
  } catch {
    return null;
  }
}

function summarizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.slice(0, 8).map(summarizeJsonValue);
    return value.length > items.length
      ? [...items, `... ${value.length - items.length} more item(s)`]
      : items;
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string'
      ? limitPromptText(value, PRIOR_PHASE_CONTEXT_LINE_MAX_CHARS, '...')
      : value;
  }

  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record).slice(0, 24)) {
    result[key] = summarizeJsonValue(item);
  }
  const omitted = Object.keys(record).length - Object.keys(result).length;
  if (omitted > 0) {
    result.__omitted_keys = omitted;
  }
  return result;
}

function normalizePriorPhaseOutput(content: string): string {
  return String(content ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function appendCompactSection(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) {
    return;
  }
  lines.push(`${title}:`);
  for (const item of items) {
    lines.push(`- ${limitPromptText(item, PRIOR_PHASE_CONTEXT_LINE_MAX_CHARS, '...')}`);
  }
  lines.push('');
}

function pushCompactUnique(items: string[], value: string, limit: number): void {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || items.includes(normalized) || items.length >= limit) {
    return;
  }
  items.push(normalized);
}

function compactAutocodeKickoffTaskDescription(value: string): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (normalized.length <= AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS) {
    return normalized;
  }

  const budget = Math.max(
    0,
    AUTOCODE_SPEC_KICKOFF_TASK_DESCRIPTION_MAX_CHARS - TASK_DESCRIPTION_COMPACTION_NOTICE.length,
  );
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    normalized.slice(0, headBudget).trimEnd(),
    TASK_DESCRIPTION_COMPACTION_NOTICE,
    normalized.slice(-tailBudget).trimStart(),
  ].join('');
}

function limitPromptText(value: string, maxChars: number, suffix: string): string {
  if (maxChars <= 0) {
    return '';
  }
  if (value.length <= maxChars) {
    return value;
  }
  const budget = Math.max(0, maxChars - suffix.length);
  if (budget <= 0) {
    return value.slice(0, maxChars);
  }
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return `${value.slice(0, headBudget).trimEnd()}${suffix}${value.slice(-tailBudget).trimStart()}`;
}

function shouldAddStandardPlanningEvidenceContract(
  agentType: AgentType | string,
  specPhase?: string,
): boolean {
  return [
    'discovery',
    'requirements',
    'research',
    'context',
    'spec_writing',
    'planning',
    'validation',
  ].includes(specPhase ?? '') || [
    'spec_discovery',
    'spec_gatherer',
    'spec_researcher',
    'spec_context',
    'spec_writer',
    'spec_critic',
    'spec_validation',
    'planner',
    'mmo_system_designer',
  ].includes(agentType);
}

function buildAutocodeStandardPlanningEvidenceContract(
  promptProjectDir: string,
  promptSpecDir: string,
): string {
  return [
    '',
    '',
    '## STANDARD PLANNING EVIDENCE CONTRACT',
    '',
    `- Ground requirements, design notes, and tasks in ${promptProjectDir} source files, generated project docs, existing specs/tasks, package/config files, or verified official/industry references.`,
    '- Do not invent framework behavior, APIs, product flows, file ownership, or acceptance criteria from general model knowledge.',
    '- If an external API, SDK, security rule, accessibility rule, protocol, game-networking pattern, or platform behavior matters, use verified official documentation or explicitly mark it as an assumption.',
    `- Record evidence in ${promptSpecDir}/requirements.md as evidence_sources, standards_references, and assumptions when those files are generated.`,
    `- In ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.context}, keep project context as concise Markdown and include Evidence Sources bullets with path, optional symbol/lines, what the evidence proves, and confidence.`,
    '- In spec.md, include Evidence, Standards / References, and Assumptions sections when the task is not trivial; keep it compact as a decision index.',
    '- In tasks.md, each executable task should cite a source path, project pattern, requirement ID, or standards reference in its guidance or metadata.',
    '- If evidence is missing after targeted inspection, write an open question or assumption and plan a validation task; never fill the gap with a confident guess.',
  ].join('\n');
}

export function buildAutocodeMmoAgentRole(agentType: AgentType | string): string | null {
  switch (agentType) {
    case 'mmo_spec_orchestrator':
      return 'MMO spec orchestrator: translate product intent into shippable requirements, architecture notes, implementation phases, QA gates, rollout risks, and specialist handoffs for a large online game.';
    case 'mmo_build_orchestrator':
      return 'MMO build orchestrator: coordinate system design, engine implementation, online gameplay, QA, performance, security, tools, and release work for a large online game task.';
    case 'mmo_system_designer':
      return 'MMO systems designer: define gameplay systems, progression, economy, quests, content loops, constraints, and acceptance criteria that scale to a live online world.';
    case 'mmo_engine_architect':
      return 'MMO engine architect: design runtime boundaries, core engine integration, threading, memory, platform abstractions, data flow, and long-term maintainability.';
    case 'mmo_engine_programmer':
      return 'MMO engine programmer: implement core engine and runtime code with attention to determinism, memory ownership, threading, platform constraints, and integration boundaries.';
    case 'mmo_rendering_engineer':
      return 'MMO rendering engineer: implement rendering, shaders, lighting, visibility, GPU resource, and frame-time sensitive changes.';
    case 'mmo_animation_engineer':
      return 'MMO animation engineer: implement animation graphs, character state, movement, blending, replication hooks, and runtime animation performance work.';
    case 'mmo_asset_pipeline_engineer':
      return 'MMO asset pipeline engineer: implement import, validation, cooking, dependency tracking, compression, versioning, and content production workflows.';
    case 'mmo_world_streaming_engineer':
      return 'MMO world streaming engineer: implement world partitioning, streaming, loading, terrain, scene handoff, shard/zone boundaries, and memory budgets.';
    case 'mmo_tools_engineer':
      return 'MMO tools engineer: implement editor, content authoring, GM, debugging, build farm, and production support tools.';
    case 'mmo_build_release_engineer':
      return 'MMO build and release engineer: implement build, packaging, patching, deployment, rollback, compatibility, and release automation.';
    case 'mmo_engine_performance_engineer':
      return 'MMO engine performance engineer: diagnose and fix CPU, GPU, memory, IO, threading, loading, and network performance issues with measurable budgets.';
    case 'mmo_server_authority_engineer':
      return 'MMO server authority engineer: implement authoritative simulation, combat validation, anti-exploit rules, persistence boundaries, and server-side correctness.';
    case 'mmo_network_sync_engineer':
      return 'MMO network sync engineer: implement replication, prediction, reconciliation, interest management, protocol compatibility, bandwidth budgets, and latency tolerance.';
    case 'mmo_client_gameplay_engineer':
      return 'MMO client gameplay engineer: implement client gameplay, UI, combat feel, quest flow, presentation, and integration with authoritative server behavior.';
    case 'mmo_data_persistence_engineer':
      return 'MMO data persistence engineer: implement schema, migrations, save/load, economy/account/inventory data, consistency, and recovery behavior.';
    case 'mmo_security_anticheat_engineer':
      return 'MMO security and anti-cheat engineer: evaluate trust boundaries, exploit paths, validation gaps, abuse resistance, telemetry, and secure operational controls.';
    case 'mmo_liveops_engineer':
      return 'MMO live operations engineer: implement telemetry, feature flags, events, operational dashboards, staged rollout, observability, and incident-ready controls.';
    case 'mmo_qa_reviewer':
      return 'MMO QA reviewer: validate correctness, server authority, client/server sync, performance budgets, streaming, content pipeline, tools, data safety, security, and release risks.';
    case 'mmo_qa_fixer':
      return 'MMO QA fixer: fix QA findings while preserving game correctness, server authority, performance budgets, data safety, and release stability.';
    default:
      return null;
  }
}

export function buildAutocodeMmoSpecialistList(): string {
  return [
    'Use MMO specialists when the work touches their domain:',
    '- mmo_engine_architect for engine boundaries and runtime architecture.',
    '- mmo_engine_programmer for core engine/runtime implementation.',
    '- mmo_rendering_engineer for renderer, shaders, lighting, visibility, and GPU budgets.',
    '- mmo_animation_engineer for animation, movement state, and character runtime.',
    '- mmo_asset_pipeline_engineer for import, cooking, validation, and content pipeline.',
    '- mmo_world_streaming_engineer for streaming, terrain, zones, shards, and loading.',
    '- mmo_tools_engineer for editor, content, GM, and debugging tools.',
    '- mmo_build_release_engineer for build, patching, deployment, and rollback.',
    '- mmo_engine_performance_engineer for CPU, GPU, memory, IO, loading, and network budgets.',
    '- mmo_server_authority_engineer for authoritative gameplay and server validation.',
    '- mmo_network_sync_engineer for replication, prediction, reconciliation, and interest management.',
    '- mmo_client_gameplay_engineer for client gameplay, combat feel, quests, and UI integration.',
    '- mmo_data_persistence_engineer for database, save, migration, economy, and account data.',
    '- mmo_security_anticheat_engineer for exploits, trust boundaries, abuse prevention, and anti-cheat.',
    '- mmo_liveops_engineer for telemetry, feature flags, events, observability, and rollout safety.',
  ].join('\n');
}

export function buildAutocodeMmoCodingQualityChecklist(): string {
  return [
    'MMO coding quality checklist:',
    '- Identify the touched domain before editing: client-only, server-authoritative, network/protocol, persistence/economy, engine/runtime, content pipeline/tools, performance, security, or liveops.',
    '- Preserve runtime owner boundaries, authoritative-side decisions, trust boundaries, data/config sources, protocol/save/tooling contracts, and patch compatibility.',
    '- For gameplay state, irreversible rewards, economy, inventory, progression, combat, movement, or account data, treat the server as authoritative and the client as intent only.',
    '- For networked changes, consider replication, prediction, reconciliation, interest management, ordering, bandwidth, protocol versioning, and latency tolerance.',
    '- For engine/runtime changes, protect initialization order, update/teardown behavior, memory ownership, threading, frame-time, IO, streaming, and platform/build configuration.',
    '- For data or content changes, preserve schema/content compatibility, migration/rollback behavior, validation, cooking/import paths, GM/editor workflows, and recovery paths.',
    '- For live-player impact, preserve observability, telemetry, feature flags, staged rollout, rollback, and operational diagnostics.',
    '- In completion summaries, explicitly state verification run and residual MMO risks for server authority, network sync, persistence/data, performance, security, tools/content pipeline, and liveops/release when relevant.',
  ].join('\n');
}

export function buildAutocodeAgentKickoffMessage(
  input: BuildAutocodeAgentKickoffMessageInput,
): string {
  const promptSpecDir = formatAutocodePathForPrompt(input.specDir);
  const promptProjectDir = formatAutocodePathForPrompt(input.projectDir);
  const mmoRole = buildAutocodeMmoAgentRole(input.agentType);
  let baseMessage: string;

  if (mmoRole) {
    if (input.agentType === 'mmo_system_designer') {
      baseMessage = `${mmoRole}\n\nRead the spec at ${promptSpecDir}/spec.md and create ${promptSpecDir}/tasks.md with concrete checklist phases and tasks. Do not write implementation_plan.md; the runtime derives it as work packages. Cover engine, server authority, networking, content pipeline, tools, performance, security, live operations, QA, and rollout risks. Project root: ${promptProjectDir}`;
    } else if (input.agentType === 'mmo_qa_reviewer') {
      baseMessage = `${mmoRole}\n\nReview the implementation in ${promptProjectDir}. Inspect ${promptSpecDir}/implementation_plan.md first, then run one focused project-appropriate verification when available. Write ${promptSpecDir}/qa_report.md with a clear "Status: PASSED" or "Status: FAILED" line.`;
    } else if (input.agentType === 'mmo_qa_fixer') {
      baseMessage = `${mmoRole}\n\nRead ${promptSpecDir}/qa_report.md, fix the reported issues in ${promptProjectDir}, and update ${promptSpecDir}/qa_report.md or implementation_plan.md to show fixes have been applied.`;
    } else if (input.subtaskId) {
      baseMessage = [
        mmoRole,
        '',
        input.focusedCoderKickoff ??
          `Read ${promptSpecDir}/implementation_plan.md and implement subtask ${input.subtaskId} in ${promptProjectDir}.`,
        '',
        'Preserve MMO runtime correctness, cross-end boundaries, performance budgets, security assumptions, and live operations safety.',
        '',
        buildAutocodeMmoCodingQualityChecklist(),
      ].join('\n');
    } else {
      baseMessage = `${mmoRole}\n\nRead ${promptSpecDir}/implementation_plan.md and implement the next pending subtask in ${promptProjectDir}. Mark its checkbox as completed when done.`;
    }
  } else {
    switch (input.agentType) {
      case 'planner':
        baseMessage = [
          `Read the Standard task spec at ${promptSpecDir}/spec.md.`,
          'Use the Autocode Standard workflow.',
          `First update ${promptSpecDir}/spec.md with Standard sections when missing or stale: Proposal/Goal, Requirements, Design Decisions, Acceptance Criteria, Risks/Open Questions.`,
          `Then create ${promptSpecDir}/tasks.md as a concrete Autocode Markdown checklist with executable tasks, dependencies, and verification notes.`,
          `Do not write ${promptSpecDir}/implementation_plan.md; the runtime derives it as work packages from tasks.md.`,
          `Project root: ${promptProjectDir}`,
        ].join(' ');
        break;
      case 'coder':
        baseMessage = input.subtaskId
          ? input.focusedCoderKickoff ??
            `Read ${promptSpecDir}/implementation_plan.md and implement subtask ${input.subtaskId}. Project root: ${promptProjectDir}.`
          : `Read ${promptSpecDir}/implementation_plan.md and implement the next pending subtask. Project root: ${promptProjectDir}. After completing the subtask, mark its checkbox as [x] and add a _Completion_ note in implementation_plan.md.`;
        break;
      case 'direct_task':
        baseMessage = `Complete this task directly. Project: ${promptProjectDir}. If no file change is required, do not call tools; answer directly. Use the initial request; do not read task metadata, requirements, plans, previous specs, broad listings, or candidate-file probes unless ambiguous. For simple docs, write the obvious target directly and verify once. End with a short markdown review table.`;
        break;
      case 'qa_reviewer':
        baseMessage = `Review the implementation in ${promptProjectDir} with the smallest deterministic check. First inspect ${promptSpecDir}/implementation_plan.md checkboxes, completion notes, file hints, and ${promptSpecDir}/tasks.md Evidence metadata when present. If all subtasks are completed, run one project-appropriate verification command when available; otherwise use one manual file-existence/static check. Verify changed behavior against Evidence-bound requirements before approving. Read source only when the check fails or the plan/evidence lacks enough completion evidence, and then read only the changed or hinted files with line ranges. Do not read the full spec, README, or the same source file unless needed for a specific failed check. Do not use broad recursive searches; if a search tool is unavailable, use at most one narrow shell fallback. Write ${promptSpecDir}/qa_report.md with a clear "Status: PASSED" or "Status: FAILED" line.`;
        break;
      case 'qa_fixer':
        baseMessage = `Read ${promptSpecDir}/qa_report.md for the issues found by QA review. Fix all issues in ${promptProjectDir}. After fixing, update ${promptSpecDir}/qa_report.md to indicate fixes have been applied.`;
        break;
      default:
        baseMessage = `Complete the task described in your system prompt. Spec directory: ${promptSpecDir}. Project directory: ${promptProjectDir}`;
        break;
    }
  }

  let kickoffMessage = appendAutocodeLanguageRequirement(baseMessage, input.language);
  if (input.agentType === 'planner' || input.agentType === 'mmo_system_designer') {
    const planLanguageRequirement = getAutocodeImplementationPlanLanguageRequirement(input.language);
    if (planLanguageRequirement) {
      kickoffMessage += `\n\n## IMPLEMENTATION PLAN LANGUAGE REQUIREMENT\n${planLanguageRequirement}`;
    }
    if (input.forcePlanning === true) {
      kickoffMessage += [
        '',
        '## PLAN REVIEW REGENERATION',
        `Read ${promptSpecDir}/HUMAN_INPUT.md and address the reviewer feedback.`,
        `If ${promptSpecDir}/change_requests.jsonl exists, use the latest entry as the active same-task iteration contract and keep the audit trail intact.`,
        `For Standard tasks, update ${promptSpecDir}/spec.md and ${promptSpecDir}/requirements.md when requirements, acceptance criteria, risks, constraints, or design decisions changed; then rewrite ${promptSpecDir}/tasks.md directly.`,
        `Use the Autocode Standard flow: proposal -> requirements -> design -> tasks -> implementation plan.`,
        `Do not edit ${promptSpecDir}/implementation_plan.md directly; the runtime derives it from the updated Standard artifacts.`,
        'Revise documents incrementally: only edit affected requirement IDs, design notes, risks, acceptance criteria, and task checklist items. Do not rewrite unaffected sections.',
        'Revise task lists incrementally: preserve completed work that remains valid, reset affected work to pending with needs_revision notes, add new pending subtasks, and mark obsolete upstream checklist items explicitly.',
        'Every new or revised requirement/design/task must carry Evidence; if evidence is missing, add an assumption/open question or validation task instead of guessing.',
        'Add focused verification metadata for every new or revised task so the next coding pass can test and keep the iteration commit-ready.',
        'This is a planning-only retry: do not implement code and do not mark subtasks completed.',
      ].join('\n');
    }
  }

  return kickoffMessage;
}

export function buildAutocodeFallbackPrompt(input: BuildAutocodeFallbackPromptInput): string {
  const promptSpecDir = formatAutocodePathForPrompt(input.specDir);
  const promptProjectDir = formatAutocodePathForPrompt(input.projectDir);
  const mmoRole = buildAutocodeMmoAgentRole(input.agentType);
  if (mmoRole) {
    const shared = [
      mmoRole,
      '',
      `Spec directory: ${promptSpecDir}`,
      `Project root: ${promptProjectDir}`,
      '',
      'MMO quality bar:',
      '- Preserve authoritative server behavior and explicit trust boundaries.',
      '- Consider client/server sync, rollback/reconciliation, latency, bandwidth, and determinism when relevant.',
      '- Respect frame-time, memory, IO, streaming, and build/release budgets.',
      '- Protect content pipeline, migration, save data, live operations, and rollout safety.',
      '- Prefer narrow reads and focused edits. Validate with targeted project checks when available.',
      '',
      buildAutocodeMmoCodingQualityChecklist(),
    ];
    if (input.agentType === 'mmo_spec_orchestrator' || input.agentType === 'mmo_build_orchestrator') {
      shared.push('', buildAutocodeMmoSpecialistList(), '', 'Use this roster as a coverage checklist for focused MMO review; work directly with the tools available in this session.');
    }
    if (input.agentType === 'mmo_system_designer') {
      shared.push('', 'Create tasks.md as an Autocode Markdown checklist with executable tasks. Do not write implementation_plan.md. Use [ ] for pending tasks and concise metadata bullets for files, dependencies, requirements, and verification.');
    }
    if (input.agentType === 'mmo_qa_reviewer') {
      shared.push('', `Write ${promptSpecDir}/qa_report.md with "Status: PASSED" or "Status: FAILED".`);
    }
    if (input.agentType === 'mmo_qa_fixer') {
      shared.push('', `Read ${promptSpecDir}/qa_report.md and fix the issues. Update qa_report.md or implementation_plan.md after fixes.`);
    }
    return shared.join('\n');
  }

  switch (input.agentType) {
    case 'planner':
      return [
        `Read ${promptSpecDir}/spec.md and use the Autocode Standard workflow.`,
        `Update ${promptSpecDir}/spec.md with Proposal/Goal, Requirements, Design Decisions, Acceptance Criteria, and Risks/Open Questions when needed.`,
        `Create ${promptSpecDir}/tasks.md as an Autocode Markdown checklist. Do not write implementation_plan.md; the runtime derives it as work packages.`,
        'Status markers: [ ] pending, [/] in progress, [x] completed, [-] blocked, [!] failed. Localize user-facing planning text when an app language is set.',
      ].join(' ');
    case 'coder':
      return `Implement the current pending subtask from ${promptSpecDir}/implementation_plan.md in ${promptProjectDir}. Mark it [x] and add a _Completion_ note when done.`;
    case 'direct_task':
      return `Complete the user's task in one concise coding session for ${promptProjectDir}. If no file change is required, do not call tools; answer directly. Use the initial request as source. Avoid staged spec/plan/QA/subagents, prior specs, broad listings, candidate-file probes, and repeated validations. For simple docs, write the obvious target directly. End with a markdown table: What changed, Verification, Review notes.`;
    case 'qa_reviewer':
      return `Review with minimal verification: inspect ${promptSpecDir}/implementation_plan.md, run one targeted check if available, and read only changed or hinted files when evidence is insufficient or a check fails. Write ${promptSpecDir}/qa_report.md with "Status: PASSED" or "Status: FAILED".`;
    case 'qa_fixer':
      return `Read ${promptSpecDir}/qa_report.md, fix reported issues in ${promptProjectDir}, and update ${promptSpecDir}/implementation_plan.md to show fixes were applied.`;
    default:
      return `Complete the task in ${promptSpecDir}/spec.md for ${promptProjectDir}.`;
  }
}

export function buildAutocodeAgenticSpecOrchestratorKickoffMessage(input: {
  taskDescription: string;
  specDir: string;
  projectDir: string;
  /** Generated project documentation reference text from project-docs/index.md and related docs. */
  projectDocsReference?: string;
  /** @deprecated Use projectDocsReference. */
  projectIndexContent?: string;
}): string {
  const promptSpecDir = formatAutocodePathForPrompt(input.specDir);
  const promptProjectDir = formatAutocodePathForPrompt(input.projectDir);
  const taskDescription = compactAutocodeKickoffTaskDescription(input.taskDescription);
  const parts = [
    `Create a complete specification for the following task:\n\n${taskDescription}\n`,
    `\nSpec directory: ${promptSpecDir}`,
    `\nProject directory: ${promptProjectDir}`,
  ];
  const projectDocsReferenceInput = input.projectDocsReference ?? input.projectIndexContent;
  if (projectDocsReferenceInput) {
    parts.push(`\n\n${buildProjectDocsReferenceSection(projectDocsReferenceInput)}`);
  }
  return parts.join('');
}
