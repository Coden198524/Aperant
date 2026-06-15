export interface AutocodePromptContext {
  specDir: string;
  projectDir: string;
  projectInstructions?: string | null;
  baseBranch?: string;
  humanInput?: string | null;
  recoveryContext?: string | null;
  autoPushToRemote?: boolean;
}

export interface AutocodeProjectCapabilities {
  is_electron: boolean;
  is_tauri: boolean;
  is_expo: boolean;
  is_react_native: boolean;
  is_web_frontend: boolean;
  is_nextjs: boolean;
  is_nuxt: boolean;
  has_api: boolean;
  has_database: boolean;
}

export const AUTOCODE_PROMPT_RECOVERY_CONTEXT_MAX_CHARS = 6_000;
export const AUTOCODE_PROMPT_HUMAN_INPUT_MAX_CHARS = 6_000;
export const AUTOCODE_PROMPT_PROJECT_INSTRUCTIONS_MAX_CHARS = 8_000;
export const AUTOCODE_PROMPT_REPEATED_LINE_MIN_CHARS = 24;

const PROMPT_RECOVERY_CONTEXT_COMPACTION_NOTICE =
  '\n\n...[recovery context middle omitted for prompt budget; inspect recovery artifacts or logs for exact omitted detail]...\n\n';
const PROMPT_HUMAN_INPUT_COMPACTION_NOTICE =
  '\n\n...[human input middle omitted for prompt budget; read HUMAN_INPUT.md for exact omitted detail before making risky decisions]...\n\n';
const PROMPT_PROJECT_INSTRUCTIONS_COMPACTION_NOTICE =
  '\n\n...[project instructions middle omitted for prompt budget; read the project instruction file for exact omitted detail]...\n\n';

function formatAutocodePromptPath(filePath: string | undefined): string | undefined {
  return filePath?.replace(/\\/g, '/');
}

export function buildAutocodeSpecLocationHeader(context: AutocodePromptContext): string {
  if (!context.specDir) return '';

  const specDir = formatAutocodePromptPath(context.specDir);
  const projectDir = formatAutocodePromptPath(context.projectDir);

  return (
    `## SPEC LOCATION\n\n` +
    `Your spec and progress files are located at:\n` +
    `- Spec: \`${specDir}/spec.md\`\n` +
    `- Implementation plan: \`${specDir}/implementation_plan.md\`\n` +
    `- Progress notes: \`${specDir}/build-progress.txt\`\n` +
    `- QA report output: \`${specDir}/qa_report.md\`\n` +
    `- Fix request output: \`${specDir}/QA_FIX_REQUEST.md\`\n\n` +
    `The project root is: \`${projectDir}\`\n\n` +
    `---\n\n`
  );
}

export function buildAutocodeDomainGuidanceHeader(domain = 'general'): string {
  const normalizedDomain = domain.trim().toLowerCase();
  if (!normalizedDomain || normalizedDomain === 'none') return '';

  return (
    `## DOMAIN FOCUS: GENERAL SOFTWARE DEVELOPMENT\n\n` +
    `Treat this as a general software-development project unless the task, project instructions, or project profile indicate a more specific domain.\n\n` +
    `Prioritize:\n` +
    `- Correctness against requirements and acceptance criteria\n` +
    `- Fit with existing architecture, module boundaries, and local conventions\n` +
    `- Security, privacy, permissions, and data integrity where relevant\n` +
    `- Maintainability, readability, and minimizing unnecessary churn\n` +
    `- Performance and resource usage appropriate to the affected paths\n` +
    `- Reliability, error handling, observability, and safe rollback for production changes\n` +
    `- Accessibility and usability for user-facing UI changes\n` +
    `- Compatibility with supported runtimes, platforms, browsers, and dependency versions\n\n` +
    `When proposing plans or verification, include concrete project-specific checks such as targeted tests, typecheck, lint, build, smoke tests, or manual verification.\n\n` +
    `---\n\n`
  );
}

export function buildAutocodeGitPushPolicyHeader(autoPushToRemote: boolean): string {
  if (autoPushToRemote) {
    return (
      `## GIT PUSH POLICY\n\n` +
      `After committing changes, run \`git push\` to push your commits to the remote repository.\n\n` +
      `---\n\n`
    );
  }

  return (
    `## GIT PUSH POLICY\n\n` +
    `Keep work local; do not run \`git push\` until the user reviews and approves.\n` +
    `The user will push to remote after reviewing your changes.\n\n` +
    `---\n\n`
  );
}

export function injectAutocodePromptContext(
  promptTemplate: string,
  context: AutocodePromptContext,
  options: { domain?: string } = {},
): string {
  const sections: string[] = [];

  const specContext = buildAutocodeSpecLocationHeader(context);
  if (specContext) {
    sections.push(specContext);
  }

  const recoveryContext = compactAutocodePromptContextSection(
    context.recoveryContext,
    AUTOCODE_PROMPT_RECOVERY_CONTEXT_MAX_CHARS,
    PROMPT_RECOVERY_CONTEXT_COMPACTION_NOTICE,
  );
  if (recoveryContext) {
    sections.push(recoveryContext);
  }

  const humanInput = compactAutocodePromptContextSection(
    context.humanInput,
    AUTOCODE_PROMPT_HUMAN_INPUT_MAX_CHARS,
    PROMPT_HUMAN_INPUT_COMPACTION_NOTICE,
  );
  if (humanInput) {
    sections.push(
      `## HUMAN INPUT (READ THIS FIRST!)\n\n` +
      `The human has left you instructions. READ AND FOLLOW THESE CAREFULLY:\n\n` +
      `${humanInput}\n\n` +
      `After addressing this input, you may delete or clear the HUMAN_INPUT.md file.\n\n` +
      `---\n\n`,
    );
  }

  const projectInstructions = compactAutocodePromptContextSection(
    context.projectInstructions,
    AUTOCODE_PROMPT_PROJECT_INSTRUCTIONS_MAX_CHARS,
    PROMPT_PROJECT_INSTRUCTIONS_COMPACTION_NOTICE,
  );
  if (projectInstructions) {
    sections.push(
      `## PROJECT INSTRUCTIONS\n\n` +
      `${projectInstructions}\n\n` +
      `---\n\n`,
    );
  }

  const domainGuidance = buildAutocodeDomainGuidanceHeader(options.domain ?? 'general');
  if (domainGuidance) {
    sections.push(domainGuidance);
  }

  if (context.autoPushToRemote !== undefined) {
    const gitPushPolicy = buildAutocodeGitPushPolicyHeader(context.autoPushToRemote);
    if (gitPushPolicy) {
      sections.push(gitPushPolicy);
    }
  }

  sections.push(promptTemplate);
  return sections.join('');
}

export function compactAutocodePromptContextSection(
  value: string | null | undefined,
  maxChars: number,
  notice: string,
): string {
  const normalized = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!normalized) {
    return normalized;
  }
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const folded = foldRepeatedAutocodePromptLines(normalized);
  if (folded.length <= maxChars) {
    return folded;
  }

  const budget = Math.max(0, maxChars - notice.length);
  const headBudget = Math.ceil(budget * 0.65);
  const tailBudget = Math.max(0, budget - headBudget);
  return [
    folded.slice(0, headBudget).trimEnd(),
    notice,
    folded.slice(-tailBudget).trimStart(),
  ].join('');
}

export function foldRepeatedAutocodePromptLines(value: string): string {
  const lines = value.split('\n');
  const folded: string[] = [];
  let previousKey = '';
  let repeatedCount = 0;

  const flushRepeatedMarker = (): void => {
    if (repeatedCount <= 0) {
      return;
    }
    folded.push(formatAutocodePromptRepeatedLineMarker(repeatedCount));
    repeatedCount = 0;
  };

  for (const line of lines) {
    const key = line.trim().replace(/\s+/g, ' ');
    if (
      key.length >= AUTOCODE_PROMPT_REPEATED_LINE_MIN_CHARS &&
      key === previousKey
    ) {
      repeatedCount += 1;
      continue;
    }

    flushRepeatedMarker();
    folded.push(line);
    previousKey = key;
  }

  flushRepeatedMarker();
  return folded.join('\n');
}

function formatAutocodePromptRepeatedLineMarker(repeatedCount: number): string {
  return `[... ${repeatedCount} repeated line(s) omitted for prompt budget ...]`;
}

export function detectAutocodeProjectCapabilities(
  projectIndex: Record<string, unknown>,
): AutocodeProjectCapabilities {
  const capabilities: AutocodeProjectCapabilities = {
    is_electron: false,
    is_tauri: false,
    is_expo: false,
    is_react_native: false,
    is_web_frontend: false,
    is_nextjs: false,
    is_nuxt: false,
    has_api: false,
    has_database: false,
  };

  const services = projectIndex.services;
  let serviceList: unknown[] = [];

  if (typeof services === 'object' && services !== null) {
    if (Array.isArray(services)) {
      serviceList = services;
    } else {
      serviceList = Object.values(services as Record<string, unknown>);
    }
  }

  for (const svc of serviceList) {
    if (!svc || typeof svc !== 'object') continue;
    const service = svc as Record<string, unknown>;

    const deps = new Set<string>();
    for (const dep of ((service.dependencies as string[]) ?? [])) {
      if (typeof dep === 'string') deps.add(dep.toLowerCase());
    }
    for (const dep of ((service.dev_dependencies as string[]) ?? [])) {
      if (typeof dep === 'string') deps.add(dep.toLowerCase());
    }

    const framework = String(service.framework ?? '').toLowerCase();

    if (deps.has('electron') || [...deps].some((dep) => dep.startsWith('@electron'))) {
      capabilities.is_electron = true;
    }
    if (deps.has('@tauri-apps/api') || deps.has('tauri')) {
      capabilities.is_tauri = true;
    }

    if (deps.has('expo')) capabilities.is_expo = true;
    if (deps.has('react-native')) capabilities.is_react_native = true;

    const webFrameworks = new Set(['react', 'vue', 'svelte', 'angular', 'solid']);
    if (webFrameworks.has(framework)) capabilities.is_web_frontend = true;

    if (['nextjs', 'next.js', 'next'].includes(framework) || deps.has('next')) {
      capabilities.is_nextjs = true;
      capabilities.is_web_frontend = true;
    }
    if (['nuxt', 'nuxt.js'].includes(framework) || deps.has('nuxt')) {
      capabilities.is_nuxt = true;
      capabilities.is_web_frontend = true;
    }
    if (deps.has('vite') && !capabilities.is_electron) {
      capabilities.is_web_frontend = true;
    }

    const apiInfo = service.api as { routes?: unknown } | null | undefined;
    if (apiInfo && typeof apiInfo === 'object' && apiInfo.routes) {
      capabilities.has_api = true;
    }

    if (service.database) capabilities.has_database = true;
    const dbDeps = new Set([
      'prisma',
      'drizzle-orm',
      'typeorm',
      'sequelize',
      'mongoose',
      'sqlalchemy',
      'alembic',
      'django',
      'peewee',
    ]);
    for (const dep of deps) {
      if (dbDeps.has(dep)) {
        capabilities.has_database = true;
        break;
      }
    }
  }

  return capabilities;
}
