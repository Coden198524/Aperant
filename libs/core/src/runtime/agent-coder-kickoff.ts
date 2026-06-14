import { AUTOCODE_TASK_ARTIFACTS } from '../tasks/artifacts.js';
import { formatAutocodeIgnoredDirNamesForPrompt } from '../workspace/ignore-rules.js';

interface AutocodePlanLike {
  phases?: unknown[];
  workflow_type?: unknown;
  project_type?: unknown;
  documentation_profile?: unknown;
  documentation_focus?: unknown;
}

interface AutocodeVerificationLike {
  type?: unknown;
  run?: unknown;
  command?: unknown;
  scenario?: unknown;
  instructions?: unknown;
  expected?: unknown;
  url?: unknown;
  checks?: unknown;
}

export interface AutocodeCoderKickoffSubtaskContext {
  id: string;
  workflowType?: string;
  title?: string;
  description?: string;
  phaseName?: string;
  filesToCreate: string[];
  filesToModify: string[];
  patternFiles: string[];
  evidence?: string;
  verification?: string | AutocodeVerificationLike;
  workPackage?: boolean;
  upstreamTaskIds?: string[];
  upstreamSource?: string;
  completedSummaries?: Array<{ id: string; title?: string; summary: string }>;
  projectType?: string;
  documentationProfile?: string;
  documentationFocus?: string[];
}

export interface BuildAutocodeFocusedCoderKickoffMessageInput {
  specDir: string;
  projectDir: string;
  subtaskId: string;
  context: AutocodeCoderKickoffSubtaskContext | null;
}

export function findAutocodeSubtaskKickoffContext(
  plan: unknown,
  subtaskId: string,
): AutocodeCoderKickoffSubtaskContext | null {
  if (!plan || typeof plan !== 'object') {
    return null;
  }

  const phases = (plan as AutocodePlanLike).phases;
  if (!Array.isArray(phases)) {
    return null;
  }

  for (const phase of phases) {
    if (!phase || typeof phase !== 'object') {
      continue;
    }

    const phaseRecord = phase as {
      name?: unknown;
      subtasks?: unknown[];
    };
    const phaseName = typeof phaseRecord.name === 'string' ? phaseRecord.name : undefined;
    const subtasks = Array.isArray(phaseRecord.subtasks) ? phaseRecord.subtasks : [];
    const completedSummaries = subtasks
      .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .map((item) => ({
        id: typeof item.id === 'string' ? item.id : '',
        title: typeof item.title === 'string' ? item.title : undefined,
        summary: typeof item.completion_summary === 'string'
          ? shortenForPrompt(item.completion_summary, 500)
          : '',
      }))
      .filter((item) => item.id !== subtaskId && item.id.length > 0 && item.summary.length > 0)
      .slice(-5);

    for (const subtask of subtasks) {
      if (!subtask || typeof subtask !== 'object') {
        continue;
      }

      const subtaskRecord = subtask as {
        id?: unknown;
        title?: unknown;
        description?: unknown;
        files_to_create?: unknown;
        files_to_modify?: unknown;
        pattern_files?: unknown;
        evidence?: unknown;
        verification?: unknown;
        work_package?: unknown;
        upstream_task_ids?: unknown;
        upstream_source?: unknown;
      };
      if (subtaskRecord.id !== subtaskId) {
        continue;
      }

      const workflowType = (plan as AutocodePlanLike).workflow_type;
      const projectType = (plan as AutocodePlanLike).project_type;
      const documentationProfile = (plan as AutocodePlanLike).documentation_profile;

      return {
        id: subtaskId,
        workflowType: typeof workflowType === 'string'
          ? workflowType
          : undefined,
        projectType: typeof projectType === 'string' ? projectType : undefined,
        documentationProfile: typeof documentationProfile === 'string' ? documentationProfile : undefined,
        documentationFocus: toStringArray((plan as AutocodePlanLike).documentation_focus),
        title: typeof subtaskRecord.title === 'string' ? subtaskRecord.title : undefined,
        description: typeof subtaskRecord.description === 'string' ? subtaskRecord.description : undefined,
        phaseName,
        filesToCreate: toStringArray(subtaskRecord.files_to_create),
        filesToModify: toStringArray(subtaskRecord.files_to_modify),
        patternFiles: toStringArray(subtaskRecord.pattern_files),
        evidence: typeof subtaskRecord.evidence === 'string' ? subtaskRecord.evidence : undefined,
        verification: typeof subtaskRecord.verification === 'string'
          || (subtaskRecord.verification && typeof subtaskRecord.verification === 'object')
          ? subtaskRecord.verification as string | AutocodeVerificationLike
          : undefined,
        workPackage: subtaskRecord.work_package === true,
        upstreamTaskIds: toStringArray(subtaskRecord.upstream_task_ids),
        upstreamSource: typeof subtaskRecord.upstream_source === 'string' ? subtaskRecord.upstream_source : undefined,
        completedSummaries,
      };
    }
  }

  return null;
}

export function buildAutocodeFocusedCoderKickoffMessageFromContext(
  input: BuildAutocodeFocusedCoderKickoffMessageInput,
): string {
  const { specDir, projectDir, subtaskId, context } = input;
  const promptSpecDir = formatPathForPrompt(specDir);
  const promptProjectDir = formatPathForPrompt(projectDir);
  const documentationOnly = isDocumentationContext(context);
  const gameMmoDocumentation = isGameMmoDocumentationContext(context);
  const gameMmoImplementation = isGameMmoImplementationContext(context);
  const workLabel = context?.workPackage ? 'work package' : 'subtask';
  const workHeading = context?.workPackage ? '## Current Work Package' : '## Current Work Item';
  const lines: string[] = [
    `Implement ${workLabel} "${subtaskId}" only.`,
    `Project root: ${promptProjectDir}.`,
    `Plan file for final status update: ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`,
  ];
  if (/^[A-Za-z]:\//.test(promptProjectDir)) {
    lines.push(`Windows command path: use \`cd /d ${promptProjectDir.replace(/\//g, '\\')}\` for Bash commands; do not convert it to Unix-style paths such as \`/e/...\`.`);
  }

  if (context) {
    lines.push('');
    lines.push(workHeading);
    if (context.workflowType) {
      lines.push(`- Workflow: ${context.workflowType}`);
    }
    if (context.phaseName) {
      lines.push(`- Phase: ${context.phaseName}`);
    }
    if (context.title) {
      lines.push(`- Title: ${context.title}`);
    }
    if (context.description) {
      lines.push(`- Description: ${context.description}`);
    }
    if (context.upstreamTaskIds?.length) {
      lines.push(`- Source task IDs: ${context.upstreamTaskIds.join(', ')}`);
    }
    if (context.upstreamSource) {
      lines.push(`- Upstream source: ${context.upstreamSource}`);
    }
    if (context.evidence) {
      lines.push(`- Evidence: ${context.evidence}`);
    }
  } else {
    lines.push('');
    lines.push(`Read ${promptSpecDir}/${AUTOCODE_TASK_ARTIFACTS.implementationPlan}, locate work item "${subtaskId}", and implement only that item.`);
  }

  if (context?.completedSummaries?.length) {
    lines.push('');
    lines.push('## Prior Completed Work In This Phase');
    lines.push('Use this as context instead of rereading completed subtask files unless the current edit requires exact local lines:');
    for (const item of context.completedSummaries) {
      const label = item.title ? `${item.id} ${item.title}` : item.id;
      lines.push(`- ${label}: ${item.summary}`);
    }
  }

  if (context?.evidence) {
    lines.push('');
    lines.push('## Evidence References');
    lines.push('- Use these references to decide what to read next; do not read the full spec unless an evidence reference points there.');
    for (const item of splitEvidenceReferences(context.evidence)) {
      lines.push(`- ${item}`);
    }
  }

  lines.push('');
  lines.push('## File Focus');

  const readFirst = [
    ...(context?.patternFiles ?? []),
    ...(context?.filesToModify ?? []),
  ];
  if (readFirst.length > 0) {
    lines.push('Read only these files first:');
    lines.push(formatBulletList(readFirst));
    if (documentationOnly) {
      lines.push('For documentation analysis, treat glob-like hints as the maximum scope. Do not expand to a full repository listing.');
    }
  } else if (context?.filesToCreate.length) {
    if (documentationOnly) {
      lines.push('Create or overwrite/update the listed documentation output after reading only the smallest source set needed to explain the requested subject.');
    } else {
      lines.push('No existing file read is required. Create or overwrite/update the listed output files directly unless the task is ambiguous.');
    }
  } else if (context) {
    lines.push('No file focus was provided by the plan. If the request clearly creates new output, choose conventional target files directly. If it modifies existing code, do at most one narrow root-file check before editing. Do not run repeated globs or broad scans.');
  } else {
    lines.push('No file list is provided. Do one minimal target discovery only: check obvious root files by name or a narrow glob, then edit the best match. Avoid broad repo scans.');
  }

  if (context?.filesToCreate.length) {
    lines.push('');
    lines.push('Create or overwrite/update these outputs if needed:');
    lines.push(formatBulletList(context.filesToCreate));
  }

  const verification = formatVerification(context?.verification);
  if (verification) {
    lines.push('');
    lines.push('## Required Verification');
    lines.push(verification);
  }

  lines.push('');
  lines.push('## Execution Rules');
  if (context) {
    lines.push(`- The Current Work Item section above is already loaded from the plan. Do not read spec.md or ${AUTOCODE_TASK_ARTIFACTS.implementationPlan} before implementation.`);
    lines.push('- If you need more detail, read only the file or artifact paths named in Evidence References and File Focus, with narrow line ranges where possible.');
  }
  if (documentationOnly) {
    lines.push('- Documentation-only workflow: do not edit product source files and do not run builds, tests, or AI QA.');
    lines.push('- Do not call `Glob` with `**/*` or any all-repository recursive pattern. Use targeted source-directory or extension patterns and exclude generated/dependency directories.');
    lines.push(`- Ignore generated or dependency directories such as ${formatAutocodeIgnoredDirNamesForPrompt()}.`);
    lines.push('- Quality comes first: read enough relevant source files to support traceable conclusions. For small projects, reading all product source files is acceptable after excluding generated directories.');
    lines.push('- Start with listed hints, manifests, entry files, and public interfaces, then expand through imports/includes/build manifests until the architecture, main behavior, data/state flow, and important boundaries are covered.');
    lines.push('- First write `doc_outline.md` with document type, target audience, sections, questions each section answers, and planned source references.');
    lines.push('- Then write `evidence_index.md` with files read, evidence-backed claims, inferred claims, risks, and open questions. Every major conclusion in the final document should map to evidence or be marked as inference.');
    lines.push('- Then write the final Markdown document from the outline and evidence index.');
    lines.push('- The final Markdown must include overview, scope, key files/modules, core flows, data/state flow, boundaries/risks, and open questions. Use file paths for important claims.');
    if (gameMmoDocumentation) {
      lines.push('- Game project documentation profile: write for large-online-game/MMO engineering, not a generic source summary.');
      lines.push('- Cover these dimensions when evidence exists: gameplay systems, progression/economy/quests/items/combat, client runtime, engine/rendering/animation/assets/world streaming, server authority, network sync/protocol, data/config/persistence, GM/editor tools, build/release, performance, security/anti-cheat, telemetry, and live operations.');
      lines.push('- For each important game system, identify source entry points, runtime owner, authoritative side, key data/config files, state transitions, cross-end protocol or sync boundary, production tool path, risks, and open questions.');
      lines.push('- Prefer system matrices, cross-end sequence flows, data lifecycle sections, state-machine notes, protocol/config evidence tables, and performance/security callouts.');
    }
    lines.push('- Avoid duplicate whole-file reads. Summarize relationships instead of copying source, and only include short code excerpts when they materially improve the document.');
    lines.push('- For documentation outputs, call Write directly for `doc_outline.md`, `evidence_index.md`, and the target Markdown file. Do not pre-create the parent directory with Bash unless Write fails because the directory is missing.');
    lines.push('- After Write succeeds, do not read generated files back. Treat successful Write results as verification; use at most one simple existence check only if a tool result is ambiguous.');
    lines.push('- Write structured Markdown with tables, layered headings, flow lists, and small Mermaid diagrams where useful. Avoid long prose and avoid embedding large code excerpts.');
  }
  if (gameMmoImplementation) {
    lines.push('- MMO implementation quality: identify the touched domain before editing: client-only, server-authoritative, network/protocol, persistence/economy, engine/runtime, content pipeline/tools, performance, security, or liveops.');
    lines.push('- Preserve runtime owner boundaries, authoritative-side decisions, trust boundaries, data/config sources, protocol/save/tooling contracts, and patch compatibility.');
    lines.push('- For gameplay state, irreversible rewards, economy, inventory, progression, combat, movement, or account data, treat the server as authoritative and the client as intent only.');
    lines.push('- For networked changes, consider replication, prediction, reconciliation, interest management, ordering, bandwidth, protocol versioning, and latency tolerance.');
    lines.push('- For engine/runtime changes, protect initialization order, update/teardown behavior, memory ownership, threading, frame-time, IO, streaming, and platform/build configuration.');
    lines.push('- For data or content changes, preserve schema/content compatibility, migration/rollback behavior, validation, cooking/import paths, GM/editor workflows, and recovery paths.');
    lines.push('- In the completion summary, state verification run and residual MMO risks for relevant domains: server authority, network sync, persistence/data, performance, security, tools/content pipeline, and liveops/release.');
  }
  lines.push(`- Focus on this one ${workLabel} until it is done.`);
  lines.push('- Do not re-plan completed work or scan unrelated directories unless the listed files force you to.');
  lines.push(`- Prefer the smallest code change that satisfies the ${workLabel}.`);
  lines.push('- Prefer one broad Write for new files or a few grouped Edits for existing files. Do not perform many tiny adjacent Edit calls when one replacement can cover the block.');
  lines.push('- Before editing an existing file, read the current narrow context and patch only against exact current lines; if an edit misses, reread only the surrounding lines once before retrying.');
  lines.push('- Treat legacy or non-UTF-8 files as encoding-sensitive: do not use apply_patch or UTF-8 rewrites on them. Use an encoding-preserving script/tool and keep the original file encoding.');
  lines.push('- In legacy Windows game projects, assume files with Chinese comments or mojibake may be non-UTF-8; verify or preserve encoding before editing.');
  lines.push('- After reading a file once, do not reread the whole file. If an edit misses, read only the narrow surrounding lines needed to repair that edit.');
  lines.push('- If a listed file was just written successfully, do not read it back unless verification fails or the next edit needs exact local context.');
  lines.push('- Run at most one listed verification before finishing.');
  lines.push('- If the listed verification tool is unavailable, discover one compatible alternative at most, then run the best available targeted check. Do not try multiple equivalent checks.');
  lines.push('- For simple create-only file tasks, a single existence/key-content check is enough; do not add separate dir/type/findstr checks after a successful write.');
  lines.push('- For pure documentation, answer, or manual-check tasks, Read or simple file existence is enough; avoid python/node one-liners with non-ASCII quoting.');
  lines.push('- On Windows, avoid nested cmd/powershell quoting for smoke checks. Prefer one simple command such as Test-Path, Get-Content -Raw, or dir on the target path.');
  lines.push('- Never use Bash here-documents such as `python - <<EOF` on Windows. Avoid Python -c or Node -e checks containing non-ASCII text.');
  lines.push('- On Node 24+, never mix CommonJS `require(...)` with top-level `await` in `node -e`, stdin, or eval scripts. Use an async IIFE around CommonJS code, or use ESM `import` with `node --input-type=module`.');
  lines.push('- Avoid brittle smoke assertions against initial or transient task status; retries and resume can advance state. Verify final behavior or durable files unless the task explicitly changes state-machine code.');
  lines.push('- If verification fails because of shell quoting, encoding, or path syntax rather than product code, do not keep rewriting commands. Record the limitation and continue if the file/output exists.');
  lines.push('- Keep failed verification output compact; include only the first 3-5 relevant error lines needed to fix the issue.');
  lines.push('- When verification passes, immediately call update_subtask_status for this subtask before writing any final summary.');
  lines.push('- Do not write a long final response before the status update. After the update succeeds, provide only a compact review matrix.');

  return lines.join('\n');
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function formatBulletList(items: string[]): string {
  return items.map((item) => `- \`${formatPathForPrompt(item)}\``).join('\n');
}

function splitEvidenceReferences(evidence: string): string[] {
  return evidence
    .split(/\s*;\s*|\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 12);
}

function formatPathForPrompt(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function shortenForPrompt(value: string, maxLength = 700): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength).trimEnd()}...`;
}

function formatVerification(verification: string | AutocodeVerificationLike | undefined): string | null {
  if (!verification) {
    return null;
  }

  if (typeof verification === 'string') {
    return `- ${verification}`;
  }

  const lines: string[] = [];
  const type = typeof verification.type === 'string' ? verification.type : null;
  const run = typeof verification.run === 'string'
    ? verification.run
    : typeof verification.command === 'string'
      ? verification.command
      : null;
  const scenario = typeof verification.scenario === 'string' ? verification.scenario : null;
  const instructions = typeof verification.instructions === 'string' ? verification.instructions : null;
  const expected = typeof verification.expected === 'string' ? verification.expected : null;
  const url = typeof verification.url === 'string' ? verification.url : null;
  const checks = Array.isArray(verification.checks)
    ? verification.checks.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];

  if (type) {
    lines.push(`- Type: ${type}`);
  }
  if (run) {
    lines.push(`- Run: ${run}`);
  }
  if (scenario) {
    lines.push(`- Scenario: ${scenario}`);
  }
  if (instructions) {
    lines.push(`- Instructions: ${instructions}`);
  }
  if (expected) {
    lines.push(`- Expected: ${expected}`);
  }
  if (url) {
    lines.push(`- URL: ${url}`);
  }
  if (checks.length > 0) {
    lines.push(`- Checks: ${checks.join('; ')}`);
  }

  return lines.length > 0
    ? lines.join('\n')
    : `- Follow the verification instructions recorded in ${AUTOCODE_TASK_ARTIFACTS.implementationPlan}.`;
}

function isDocumentationContext(context: AutocodeCoderKickoffSubtaskContext | null): boolean {
  const workflowType = context?.workflowType?.toLowerCase().trim();
  if (workflowType === 'documentation') {
    return true;
  }

  const text = [
    context?.title,
    context?.description,
    context?.phaseName,
    ...(context?.filesToCreate ?? []),
    ...(context?.filesToModify ?? []),
  ].filter(Boolean).join(' ').toLowerCase();

  return /\b(documentation|document|docs|source analysis|code analysis)\b/.test(text);
}

function isGameMmoDocumentationContext(context: AutocodeCoderKickoffSubtaskContext | null): boolean {
  return isDocumentationContext(context) && (
    context?.projectType === 'game-mmo' ||
    context?.documentationProfile === 'game-mmo-source' ||
    context?.documentationFocus?.some((item) => /\b(gameplay|client\/engine|server authority|network sync|anti-cheat|live operations)\b/i.test(item)) === true
  );
}

function isGameMmoImplementationContext(context: AutocodeCoderKickoffSubtaskContext | null): boolean {
  return !isDocumentationContext(context) && context?.projectType === 'game-mmo';
}
