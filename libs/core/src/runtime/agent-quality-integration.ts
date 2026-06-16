export interface AutocodeQualityConfig {
  enablePreQASmokeTests?: boolean;
  enableIncrementalValidation?: boolean;
  enablePatternInjection?: boolean;
  enablePreImplementationChecklist?: boolean;
  enableSelfCritique?: boolean;
  enableContextAwareRecovery?: boolean;
  enableActiveMemoryLearning?: boolean;
  enableTieredQualityStandards?: boolean;
  enableDocumentationQualityGate?: boolean;
  projectType?: string;
}

export interface AutocodeDocumentationOutputs {
  finalMarkdown: string;
  outline: string;
  evidenceIndex: string;
  base: 'spec' | 'project';
}

export interface AutocodeQualitySubtask {
  description: string;
  filesToCreate?: string[];
  filesToModify?: string[];
}

export type AutocodeQaReportStatus = 'passed' | 'failed' | 'unknown';

export interface AutocodeQaReportQualityOptions {
  isGameMmo?: boolean;
}

export const AUTOCODE_DEFAULT_QUALITY_CONFIG: Required<Omit<AutocodeQualityConfig, 'projectType'>> = {
  enablePreQASmokeTests: false,
  enableIncrementalValidation: true,
  enablePatternInjection: false,
  enablePreImplementationChecklist: true,
  enableSelfCritique: true,
  enableContextAwareRecovery: true,
  enableActiveMemoryLearning: true,
  enableTieredQualityStandards: true,
  enableDocumentationQualityGate: true,
};

const MIN_DOCUMENTATION_SOURCE_REFERENCES = 3;
const MIN_MMO_DOCUMENTATION_SOURCE_REFERENCES = 6;
const MIN_QA_SOURCE_REFERENCES = 1;
const MIN_MMO_QA_SOURCE_REFERENCES = 3;

const SOURCE_PATH_REFERENCE_PATTERN =
  /\b(?:(?:\.{0,2}[/\\])?(?:src|app|apps|lib|libs|packages|server|client|shared|engine|game|games|assets|scripts|source|content|config|tests|e2e|resources|public|include|runtime|editor|tool|tools|gm)[/\\][A-Za-z0-9_./\\()[\]@+\-]+\.[A-Za-z0-9]+|(?:package|tsconfig|vite|vitest|webpack|rollup|biome|eslint|cargo|go|pyproject|requirements|cmakelists)\.[A-Za-z0-9.]+)\b/gi;

export function getDefaultAutocodeQualityConfig(): AutocodeQualityConfig {
  return { ...AUTOCODE_DEFAULT_QUALITY_CONFIG };
}

export function createAutocodeQualityConfig(overrides: Partial<AutocodeQualityConfig>): AutocodeQualityConfig {
  return { ...AUTOCODE_DEFAULT_QUALITY_CONFIG, ...overrides };
}

export function hasAutocodeQualityFeaturesEnabled(config: AutocodeQualityConfig): boolean {
  return Object.values(config).some((value) => value === true);
}

export function getAutocodeEnabledQualityFeatures(config: AutocodeQualityConfig): string[] {
  const appliedConfig = { ...AUTOCODE_DEFAULT_QUALITY_CONFIG, ...config };
  const features: string[] = [];

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

export function getAutocodeDocumentationOutputs(plan: Record<string, unknown>): AutocodeDocumentationOutputs {
  const outputs = plan.document_outputs && typeof plan.document_outputs === 'object'
    ? plan.document_outputs as Record<string, unknown>
    : {};
  const phases = Array.isArray(plan.phases) ? plan.phases : [];
  const firstSubtask = phases
    .flatMap((phase) => phase && typeof phase === 'object' && Array.isArray((phase as Record<string, unknown>).subtasks)
      ? (phase as Record<string, unknown>).subtasks as unknown[]
      : [])
    .find((subtask) => subtask && typeof subtask === 'object') as Record<string, unknown> | undefined;
  const filesToCreate = toAutocodeStringArray(firstSubtask?.files_to_create);
  const markdownFromPlan = typeof outputs.final_markdown === 'string'
    ? outputs.final_markdown
    : filesToCreate.find((file) => file.toLowerCase().endsWith('.md'));

  return {
    finalMarkdown: markdownFromPlan || 'docs/analysis.md',
    outline: typeof outputs.outline === 'string' ? outputs.outline : 'doc_outline.md',
    evidenceIndex: typeof outputs.evidence_index === 'string' ? outputs.evidence_index : 'evidence_index.md',
    base: outputs.base === 'project' ? 'project' : 'spec',
  };
}

export function validateAutocodeMarkdownSupportDocument(
  content: string | null,
  filePath: string,
  requiredTerms: readonly RegExp[],
): string[] {
  if (!content?.trim()) {
    return [`documentation: ${filePath} is missing or empty`];
  }

  const issues: string[] = [];
  if (!/^#\s+/m.test(content) && !/^##\s+/m.test(content)) {
    issues.push(`documentation: ${filePath} needs Markdown headings`);
  }
  for (const term of requiredTerms) {
    if (!term.test(content)) {
      issues.push(`documentation: ${filePath} is missing expected topic ${term.source}`);
    }
  }
  return issues;
}

export function isAutocodeGameMmoDocumentationPlan(plan: Record<string, unknown>): boolean {
  return plan.project_type === 'game-mmo' ||
    plan.documentation_profile === 'game-mmo-source' ||
    toAutocodeStringArray(plan.documentation_focus).some((item) => (
      /\b(gameplay|client\/engine|server authority|network sync|anti-cheat|live operations)\b/i.test(item)
    ));
}

export function validateAutocodeGameMmoDocumentationSupportContent(
  outline: string | null,
  evidence: string | null,
  outputPath: string,
): string[] {
  const issues: string[] = [];
  const outlineText = (outline ?? '').toLowerCase();
  const evidenceText = (evidence ?? '').toLowerCase();

  const outlineChecks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'system matrix or system inventory section',
      terms: [
        /\bsystem matrix\b/i,
        /\bsystem inventory\b/i,
        /\u7cfb\u7edf\u77e9\u9635/,
        /\u7cfb\u7edf\u6e05\u5355/,
      ],
    },
    {
      label: 'cross-end flow, protocol, or sequence section',
      terms: [
        /\bcross[-\s]?end\b/i,
        /\bprotocol\b/i,
        /\bsequence\b/i,
        /\bclient.*server\b/i,
        /\u8de8\u7aef/,
        /\u534f\u8bae/,
        /\u65f6\u5e8f/,
      ],
    },
    {
      label: 'data lifecycle, persistence, config, or content pipeline section',
      terms: [
        /\bdata lifecycle\b/i,
        /\bpersist/i,
        /\bconfig/i,
        /\bcontent pipeline\b/i,
        /\u6570\u636e\u751f\u547d\u5468\u671f/,
        /\u6301\u4e45\u5316/,
        /\u914d\u7f6e/,
        /\u5185\u5bb9\u7ba1\u7ebf/,
      ],
    },
    {
      label: 'risk review section covering performance/security/liveops',
      terms: [
        /\brisks?\b/i,
        /\bperformance\b/i,
        /\bsecurity\b/i,
        /\bliveops\b/i,
        /\u98ce\u9669/,
        /\u6027\u80fd/,
        /\u5b89\u5168/,
        /\u8fd0\u8425/,
      ],
    },
  ];

  for (const check of outlineChecks) {
    if (!hasAnyAutocodeTerm(outlineText, check.terms)) {
      issues.push(`documentation: ${outputPath} outline should include MMO ${check.label}`);
    }
  }

  const evidenceChecks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'client or engine evidence',
      terms: [
        /\bclient\b/i,
        /\bengine\b/i,
        /\brender/i,
        /\banimation\b/i,
        /\basset\b/i,
        /\u5ba2\u6237\u7aef/,
        /\u5f15\u64ce/,
        /\u6e32\u67d3/,
      ],
    },
    {
      label: 'server authority or network evidence',
      terms: [
        /\bserver\b/i,
        /\bauthorit/i,
        /\bnetwork\b/i,
        /\bprotocol\b/i,
        /\bsync\b/i,
        /\u670d\u52a1\u7aef/,
        /\u6743\u5a01/,
        /\u7f51\u7edc/,
        /\u534f\u8bae/,
      ],
    },
    {
      label: 'data/config/persistence/tooling evidence',
      terms: [
        /\bdata\b/i,
        /\bconfig/i,
        /\bpersist/i,
        /\bsave\b/i,
        /\btool/i,
        /\bgm\b/i,
        /\u914d\u7f6e/,
        /\u6570\u636e/,
        /\u6301\u4e45\u5316/,
        /\u5de5\u5177/,
      ],
    },
  ];

  for (const check of evidenceChecks) {
    if (!hasAnyAutocodeTerm(evidenceText, check.terms)) {
      issues.push(`documentation: ${outputPath} evidence index should include MMO ${check.label}`);
    }
  }
  if (countAutocodeSourcePathReferences(evidence ?? '') < MIN_MMO_DOCUMENTATION_SOURCE_REFERENCES) {
    issues.push(`documentation: ${outputPath} evidence index should cite concrete MMO source/config files for the major systems analyzed`);
  }

  return issues;
}

export function validateAutocodeDocumentationEvidenceIndex(
  content: string | null,
  filePath: string,
  options: { isGameMmoDocumentation?: boolean } = {},
): string[] {
  const issues = validateAutocodeMarkdownSupportDocument(content, filePath, [
    /files? read|source|evidence/i,
    /claims?|conclusion/i,
    /open questions?|risk|inferred|inference|unverified/i,
  ]);
  if (!content?.trim()) {
    return issues;
  }

  const sourceRefCount = countAutocodeSourcePathReferences(content);
  const minSourceRefs = options.isGameMmoDocumentation
    ? MIN_MMO_DOCUMENTATION_SOURCE_REFERENCES
    : MIN_DOCUMENTATION_SOURCE_REFERENCES;
  if (sourceRefCount < minSourceRefs) {
    issues.push(`documentation: ${filePath} should cite at least ${minSourceRefs} concrete source/config file paths in the evidence index`);
  }
  if (!/\b(proven|inferred|confidence|confidence level|unverified|assumption)\b|\u63a8\u65ad|\u7f6e\u4fe1|\u672a\u9a8c\u8bc1|\u5047\u8bbe/i.test(content)) {
    issues.push(`documentation: ${filePath} should distinguish proven source-backed claims from inferred or unverified claims`);
  }

  return issues;
}

export function validateAutocodeDocumentationMarkdown(
  markdown: string,
  outputPath: string,
  options: { isGameMmoDocumentation?: boolean } = {},
): string[] {
  const issues: string[] = [];
  const trimmed = markdown.trim();

  if (trimmed.length < 800) {
    issues.push(`documentation: ${outputPath} is too short for deep source documentation`);
  }
  if (!/^##\s+/m.test(markdown)) {
    issues.push(`documentation: ${outputPath} needs structured section headings`);
  }
  if (!/evidence|source|file|\u6765\u6e90|\u8bc1\u636e|\u6587\u4ef6/i.test(markdown)) {
    issues.push(`documentation: ${outputPath} must cite source/evidence files`);
  }
  const minSourceRefs = options.isGameMmoDocumentation
    ? MIN_MMO_DOCUMENTATION_SOURCE_REFERENCES
    : MIN_DOCUMENTATION_SOURCE_REFERENCES;
  if (countAutocodeSourcePathReferences(markdown) < minSourceRefs) {
    issues.push(`documentation: ${outputPath} should cite at least ${minSourceRefs} concrete source/config file paths, not just generic source references`);
  }
  if (!/\b(entry points?|module boundaries|runtime owners?|public interfaces?|apis?|schemas?|configuration|dependency direction|call flow|data flow|state flow|ownership)\b|\u5165\u53e3|\u6a21\u5757\u8fb9\u754c|\u8fd0\u884c\u65f6|\u63a5\u53e3|\u914d\u7f6e|\u4f9d\u8d56|\u8c03\u7528\u6d41|\u6570\u636e\u6d41|\u72b6\u6001/i.test(markdown)) {
    issues.push(`documentation: ${outputPath} should analyze concrete source architecture such as entry points, module boundaries, runtime owners, APIs, configs, or state/data flow`);
  }
  if (!/flow|data flow|state|sequence|mermaid|\u6d41\u7a0b|\u6570\u636e\u6d41|\u72b6\u6001|\u65f6\u5e8f/i.test(markdown)) {
    issues.push(`documentation: ${outputPath} should describe core flow, data flow, state flow, or sequence`);
  }
  if (!/risk|open question|unknown|unverified|\u98ce\u9669|\u672a\u786e\u8ba4|\u672a\u77e5|\u5f85\u786e\u8ba4/i.test(markdown)) {
    issues.push(`documentation: ${outputPath} should include risks or open questions`);
  }

  if (options.isGameMmoDocumentation) {
    issues.push(...validateAutocodeGameMmoDocumentationMarkdown(markdown, outputPath));
  }

  return issues;
}

export function validateAutocodeCodingSummary(
  subtask: AutocodeQualitySubtask,
  summary: string,
): string[] {
  if (isAutocodeDocumentationSubtask(subtask) || !isAutocodeCodingSubtask(subtask)) {
    return [];
  }

  const trimmed = summary.trim();
  if (!trimmed) {
    return ['code-quality: completion summary is missing implementation quality details'];
  }

  const lower = trimmed.toLowerCase();
  const issues: string[] = [];
  const expectedFiles = [
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ];
  const hasChanged = /\b(what changed|changed|implemented|updated|fixed|added|modified|created|wired|refactored)\b|\u53d8\u66f4|\u4fee\u6539|\u5b9e\u73b0|\u4fee\u590d|\u65b0\u589e|\u66f4\u65b0/.test(lower);
  const hasVerification = /\b(verification|verified|test|tests|typecheck|lint|build|smoke|manual|not run|skipped|unable|limitation)\b|\u9a8c\u8bc1|\u6d4b\u8bd5|\u6784\u5efa|\u68c0\u67e5|\u672a\u8fd0\u884c|\u8df3\u8fc7|\u65e0\u6cd5/.test(lower);
  const hasReviewNotes = /\b(review notes?|risk|risks|residual|edge cases?|contract|boundary|limitation|not verified|open questions?|follow[-\s]?up|no residual)\b|\u98ce\u9669|\u8fb9\u754c|\u5951\u7ea6|\u672a\u9a8c\u8bc1|\u9650\u5236|\u5f85\u786e\u8ba4|\u65e0\u6b8b\u7559/.test(lower);

  if (!hasChanged) {
    issues.push('code-quality: completion summary should state the concrete implementation change');
  }
  if (expectedFiles.length > 0 && !summaryReferencesExpectedFile(trimmed, expectedFiles)) {
    issues.push('code-quality: completion summary should name touched files or changed contracts');
  }
  if (!hasVerification) {
    issues.push('code-quality: completion summary should state verification run or exact verification limitation');
  }
  if (!hasReviewNotes) {
    issues.push('code-quality: completion summary should include review notes, residual risks, edge cases, or contract/boundary impact');
  }

  return issues;
}

export function validateAutocodeGameMmoCodingSummary(
  subtask: AutocodeQualitySubtask,
  summary: string,
): string[] {
  if (isAutocodeDocumentationSubtask(subtask) || !isAutocodeGameMmoRiskRelevantSubtask(subtask)) {
    return [];
  }

  if (!summary.trim()) {
    return ['mmo-quality: completion summary is missing MMO risk and verification details'];
  }

  const lower = summary.toLowerCase();
  const issues: string[] = [];
  const hasVerification = /\bverification\b|\bverified\b|\btest\b|\bbuild\b|\btypecheck\b|\bsmoke\b|\bmanual\b|\u9a8c\u8bc1|\u6d4b\u8bd5|\u6784\u5efa|\u68c0\u67e5/.test(lower);
  const hasMmoRiskLanguage = /\bserver authority\b|\bnetwork sync\b|\bpersistence\b|\bdata safety\b|\bperformance\b|\bsecurity\b|\banti[-\s]?cheat\b|\bliveops\b|\btooling\b|\bcontent pipeline\b|\u670d\u52a1\u7aef|\u6743\u5a01|\u7f51\u7edc|\u540c\u6b65|\u6301\u4e45\u5316|\u6570\u636e|\u6027\u80fd|\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u8fd0\u8425|\u5de5\u5177/.test(lower);
  const hasBoundaryLanguage = /\bclient\b|\bserver\b|\bauthoritative\b|\btrust boundary\b|\bprotocol\b|\bconfig\b|\bsave\b|\bruntime owner\b|\u5ba2\u6237\u7aef|\u670d\u52a1\u7aef|\u6743\u5a01|\u8fb9\u754c|\u534f\u8bae|\u914d\u7f6e|\u5b58\u6863|\u8fd0\u884c\u65f6/.test(lower);

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

export function getAutocodeQaReportStatus(content: string | null): AutocodeQaReportStatus {
  if (!content?.trim()) {
    return 'unknown';
  }

  const statusMatch = content.match(/^Status:\s*([A-Z _-]+)\s*$/im);
  const normalizedStatus = statusMatch?.[1]?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalizedStatus === 'passed' || normalizedStatus === 'approved' || normalizedStatus === 'pass') {
    return 'passed';
  }
  if (
    normalizedStatus === 'failed' ||
    normalizedStatus === 'rejected' ||
    normalizedStatus === 'fail' ||
    normalizedStatus === 'needs_changes' ||
    normalizedStatus === 'needs_change'
  ) {
    return 'failed';
  }

  const lower = content.toLowerCase();
  if (/\bstatus:\s*(passed|approved|pass)\b/i.test(lower)) {
    return 'passed';
  }
  if (/\bstatus:\s*(failed|rejected|fail|needs changes|needs_changes)\b/i.test(lower)) {
    return 'failed';
  }
  return 'unknown';
}

export function validateAutocodeQaReportQuality(
  content: string | null,
  filePath = 'qa_report.md',
  options: AutocodeQaReportQualityOptions = {},
): string[] {
  if (!content?.trim()) {
    return [`qa-quality: ${filePath} is missing or empty`];
  }

  const issues: string[] = [];
  const trimmed = content.trim();
  const status = getAutocodeQaReportStatus(content);
  const exactStatusMatch = /^Status:\s*(PASSED|FAILED)\s*$/im.test(content);
  if (!exactStatusMatch) {
    issues.push(`qa-quality: ${filePath} must include an exact "Status: PASSED" or "Status: FAILED" line`);
  }
  if (status === 'unknown') {
    issues.push(`qa-quality: ${filePath} has no recognizable QA verdict`);
  }

  const sourceRefCount = countAutocodeSourcePathReferences(content);
  const minSourceRefs = options.isGameMmo ? MIN_MMO_QA_SOURCE_REFERENCES : MIN_QA_SOURCE_REFERENCES;
  if (sourceRefCount < minSourceRefs) {
    issues.push(`qa-quality: ${filePath} should cite at least ${minSourceRefs} concrete changed source/config file path${minSourceRefs === 1 ? '' : 's'}`);
  }

  const requiredSections: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'scope reviewed',
      terms: [/scope reviewed/i, /review scope/i, /files reviewed/i, /\u5ba1\u67e5\u8303\u56f4/],
    },
    {
      label: 'changed files/contracts',
      terms: [/changed files?/i, /files changed/i, /changed contracts?/i, /contract/i, /boundary/i, /api/i, /schema/i, /config/i, /data flow/i, /\u5951\u7ea6|\u8fb9\u754c|\u63a5\u53e3|\u914d\u7f6e/],
    },
    {
      label: 'acceptance or requirements matrix',
      terms: [/acceptance matrix/i, /acceptance criteria/i, /requirements? matrix/i, /\brequirement\b/i, /\u9a8c\u6536|\u9700\u6c42/],
    },
    {
      label: 'verification/checks run',
      terms: [/verification/i, /checks? run/i, /\btest\b/i, /\btypecheck\b/i, /\blint\b/i, /\bbuild\b/i, /\bmanual\b/i, /not run|skipped|unable/i, /\u9a8c\u8bc1|\u6d4b\u8bd5|\u68c0\u67e5/],
    },
    {
      label: 'findings or no blocking issues',
      terms: [/findings?/i, /issues?/i, /no blocking/i, /no open blocker/i, /\u95ee\u9898|\u7f3a\u9677|\u65e0\u963b\u585e/],
    },
    {
      label: 'residual risks or limitations',
      terms: [/risks?/i, /residual/i, /limitations?/i, /open questions?/i, /not verified|unverified/i, /no residual/i, /\u98ce\u9669|\u9650\u5236|\u672a\u9a8c\u8bc1/],
    },
  ];

  for (const section of requiredSections) {
    if (!hasAnyAutocodeTerm(content, section.terms)) {
      issues.push(`qa-quality: ${filePath} should include ${section.label}`);
    }
  }

  if (status === 'passed') {
    if (trimmed.length < 500) {
      issues.push(`qa-quality: ${filePath} is too short for an approval-grade QA report`);
    }
    if (!/\b(no blocking|no open blocker|no remaining blocker|0 blocking|none found|passed)\b|\u65e0\u963b\u585e|\u901a\u8fc7/i.test(content)) {
      issues.push(`qa-quality: ${filePath} should explicitly state that no blocking issues remain before passing`);
    }
  }

  if (status === 'failed') {
    const failedReportFields: Array<{ label: string; terms: RegExp[] }> = [
      { label: 'issue title', terms: [/\btitle\b/i, /^#{2,4}\s+\S/m, /\u6807\u9898/] },
      { label: 'issue location', terms: [/\blocation\b/i, /\bfile\b/i, /\bline\b/i, /\u4f4d\u7f6e|\u6587\u4ef6|\u884c/] },
      { label: 'issue evidence', terms: [/\bevidence\b/i, /\bobserved\b/i, /\brepro/i, /\u8bc1\u636e|\u590d\u73b0/] },
      { label: 'impacted requirement or contract', terms: [/impacted/i, /\brequirement\b/i, /\bcontract\b/i, /\bboundary\b/i, /\u5f71\u54cd|\u9700\u6c42|\u5951\u7ea6|\u8fb9\u754c/] },
      { label: 'required fix', terms: [/required fix/i, /fix required/i, /\bfix\b/i, /\u5fc5\u8981\u4fee\u590d|\u4fee\u590d/] },
      { label: 're-verification command or check', terms: [/re[-\s]?verification/i, /verification expected/i, /rerun/i, /\bcommand\b/i, /\u590d\u9a8c|\u91cd\u65b0\u9a8c\u8bc1/] },
    ];
    for (const field of failedReportFields) {
      if (!hasAnyAutocodeTerm(content, field.terms)) {
        issues.push(`qa-quality: ${filePath} failed report should include ${field.label}`);
      }
    }
  }

  if (options.isGameMmo) {
    issues.push(...validateAutocodeGameMmoQaReportQuality(content, filePath));
  }

  return issues;
}

function validateAutocodeGameMmoQaReportQuality(content: string, filePath: string): string[] {
  const issues: string[] = [];
  const checks: Array<{ label: string; terms: RegExp[] }> = [
    { label: 'MMO domain matrix', terms: [/mmo domain matrix/i, /domain matrix/i, /system matrix/i, /\u9886\u57df\u77e9\u9635|\u7cfb\u7edf\u77e9\u9635/] },
    { label: 'server authority or trust boundary review', terms: [/server authority/i, /\bauthoritative\b/i, /trust boundary/i, /\u670d\u52a1\u7aef|\u6743\u5a01|\u4fe1\u4efb\u8fb9\u754c/] },
    { label: 'network sync/protocol review', terms: [/network sync/i, /\bprotocol\b/i, /\breplication\b/i, /prediction|reconciliation/i, /\u7f51\u7edc|\u540c\u6b65|\u534f\u8bae/] },
    { label: 'persistence/data/config review', terms: [/persistence/i, /\bdata\b/i, /\bconfig/i, /\bsave\b/i, /\u6301\u4e45\u5316|\u6570\u636e|\u914d\u7f6e|\u5b58\u6863/] },
    { label: 'performance budget review', terms: [/performance/i, /latency|frame|bandwidth|memory|io/i, /\u6027\u80fd|\u5ef6\u8fdf|\u5e27|\u5e26\u5bbd|\u5185\u5b58/] },
    { label: 'security/anti-cheat review', terms: [/security/i, /anti[-\s]?cheat/i, /exploit/i, /\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u5229\u7528/] },
    { label: 'liveops/release/tooling review', terms: [/liveops/i, /\brelease\b/i, /rollout|telemetry|tooling|content pipeline/i, /\u8fd0\u8425|\u53d1\u5e03|\u5de5\u5177|\u57cb\u70b9/] },
  ];

  for (const check of checks) {
    if (!hasAnyAutocodeTerm(content, check.terms)) {
      issues.push(`qa-quality: ${filePath} should include ${check.label}`);
    }
  }

  return issues;
}

function validateAutocodeGameMmoDocumentationMarkdown(markdown: string, outputPath: string): string[] {
  const issues: string[] = [];
  const checks: Array<{ label: string; terms: RegExp[] }> = [
    {
      label: 'gameplay systems/progression/combat/quests/economy',
      terms: [
        /\bgameplay\b/i,
        /\bcombat\b/i,
        /\bquest\b/i,
        /\bprogression\b/i,
        /\beconomy\b/i,
        /\u73a9\u6cd5|\u6218\u6597|\u4efb\u52a1|\u6210\u957f|\u7ecf\u6d4e|\u88c5\u5907|\u7269\u54c1/,
      ],
    },
    {
      label: 'client, engine, rendering, animation, assets, or world streaming',
      terms: [
        /\bclient\b/i,
        /\bengine\b/i,
        /\brender/i,
        /\banimation\b/i,
        /\basset\b/i,
        /\bstreaming\b/i,
        /\u5ba2\u6237\u7aef|\u5f15\u64ce|\u6e32\u67d3|\u52a8\u753b|\u8d44\u6e90|\u573a\u666f|\u5730\u56fe|\u4e16\u754c/,
      ],
    },
    {
      label: 'server authority, network sync, replication, protocol, prediction, or reconciliation',
      terms: [
        /\bserver\b/i,
        /\bauthorit/i,
        /\bnetwork\b/i,
        /\bsync\b/i,
        /\breplication\b/i,
        /\bprotocol\b/i,
        /\bprediction\b/i,
        /\breconciliation\b/i,
        /\u670d\u52a1\u7aef|\u6743\u5a01|\u7f51\u7edc|\u540c\u6b65|\u534f\u8bae|\u5e7f\u64ad|\u9884\u6d4b|\u6821\u6b63/,
      ],
    },
    {
      label: 'data/config/content pipeline, persistence, save state, account, GM, editor, or tooling',
      terms: [
        /\bdata\b/i,
        /\bconfig/i,
        /\bcontent\b/i,
        /\bpersist/i,
        /\bsave\b/i,
        /\baccount\b/i,
        /\bGM\b/,
        /\beditor\b/i,
        /\btool/i,
        /\u914d\u7f6e|\u6570\u636e|\u6301\u4e45\u5316|\u5b58\u6863|\u8d26\u53f7|\u5de5\u5177|\u7f16\u8f91\u5668|\u540e\u53f0/,
      ],
    },
    {
      label: 'performance, security, anti-cheat, telemetry, live operations, or release risk',
      terms: [
        /\bperformance\b/i,
        /\bframe\b/i,
        /\blatency\b/i,
        /\bsecurity\b/i,
        /\banti[-\s]?cheat\b/i,
        /\btelemetry\b/i,
        /\bliveops\b/i,
        /\brelease\b/i,
        /\u6027\u80fd|\u5e27|\u5ef6\u8fdf|\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u57cb\u70b9|\u8fd0\u8425|\u53d1\u5e03/,
      ],
    },
  ];

  for (const check of checks) {
    if (!hasAnyAutocodeTerm(markdown, check.terms)) {
      issues.push(`documentation: ${outputPath} should cover MMO ${check.label}`);
    }
  }

  const hasProfessionalStructure = /\bmatrix\b|\bsequence\b|\blifecycle\b|\bstate machine\b|\bprotocol\b|\bdata lifecycle\b|\u7cfb\u7edf\u77e9\u9635|\u65f6\u5e8f|\u751f\u547d\u5468\u671f|\u72b6\u6001\u673a|\u534f\u8bae|\u6570\u636e\u6d41\u8f6c/i.test(markdown);
  if (!hasProfessionalStructure) {
    issues.push(`documentation: ${outputPath} should include MMO professional structures such as system matrices, sequence flows, state machines, protocol/config tables, or data lifecycles`);
  }

  if (markdown.trim().length < 1600) {
    issues.push(`documentation: ${outputPath} is too short for MMO source documentation`);
  }
  if (countAutocodeSourcePathReferences(markdown) < MIN_MMO_DOCUMENTATION_SOURCE_REFERENCES) {
    issues.push(`documentation: ${outputPath} should cite concrete MMO source/config paths across client, server/network, data/config, tools, and operations where present`);
  }

  return issues;
}

function isAutocodeDocumentationSubtask(subtask: AutocodeQualitySubtask): boolean {
  const text = [
    subtask.description,
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].join(' ').toLowerCase();

  return /\b(documentation|document|docs|markdown|source analysis)\b/.test(text) ||
    /\u6587\u6863|\u6e90\u7801\u5206\u6790|\u4ee3\u7801\u5206\u6790/.test(text);
}

function isAutocodeCodingSubtask(subtask: AutocodeQualitySubtask): boolean {
  const files = [
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ];
  if (files.some((file) => !/\.(?:md|mdx|txt|rst)$/i.test(file))) {
    return true;
  }

  const text = [
    subtask.description,
    ...files,
  ].join(' ').toLowerCase();
  return /\b(implement|fix|add|update|modify|create|wire|integrate|refactor|bug|feature|component|service|handler|schema|migration|test)\b/.test(text) ||
    /\u5b9e\u73b0|\u4fee\u590d|\u65b0\u589e|\u66f4\u65b0|\u4fee\u6539|\u91cd\u6784|\u63a5\u5165|\u96c6\u6210|\u7ec4\u4ef6|\u670d\u52a1|\u6d4b\u8bd5/.test(text);
}

function isAutocodeGameMmoRiskRelevantSubtask(subtask: AutocodeQualitySubtask): boolean {
  const text = [
    subtask.description,
    ...(subtask.filesToCreate ?? []),
    ...(subtask.filesToModify ?? []),
  ].join(' ').toLowerCase();

  return /\b(server|client|network|protocol|sync|replication|prediction|reconciliation|database|persistence|save|account|economy|inventory|combat|quest|skill|item|engine|render|animation|asset|streaming|performance|security|anti[-\s]?cheat|telemetry|liveops|gm|tool|editor|build|release)\b/i.test(text) ||
    /\u670d\u52a1\u7aef|\u5ba2\u6237\u7aef|\u7f51\u7edc|\u534f\u8bae|\u540c\u6b65|\u6570\u636e\u5e93|\u6301\u4e45\u5316|\u5b58\u6863|\u8d26\u53f7|\u7ecf\u6d4e|\u80cc\u5305|\u6218\u6597|\u4efb\u52a1|\u6280\u80fd|\u7269\u54c1|\u5f15\u64ce|\u6e32\u67d3|\u52a8\u753b|\u8d44\u6e90|\u6027\u80fd|\u5b89\u5168|\u53cd\u4f5c\u5f0a|\u8fd0\u8425|\u5de5\u5177|\u7f16\u8f91\u5668|\u6784\u5efa|\u53d1\u5e03/.test(text);
}

function toAutocodeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function hasAnyAutocodeTerm(text: string, terms: readonly RegExp[]): boolean {
  return terms.some((term) => term.test(text));
}

function countAutocodeSourcePathReferences(text: string): number {
  const matches = new Set<string>();
  for (const match of text.matchAll(SOURCE_PATH_REFERENCE_PATTERN)) {
    matches.add(match[0].replace(/\\/g, '/').toLowerCase());
  }
  return matches.size;
}

function summaryReferencesExpectedFile(summary: string, files: readonly string[]): boolean {
  const normalizedSummary = summary.replace(/\\/g, '/').toLowerCase();
  return files.some((file) => {
    const normalized = file.replace(/\\/g, '/').toLowerCase();
    if (!normalized) {
      return false;
    }
    const basename = normalized.split('/').pop() ?? normalized;
    return normalizedSummary.includes(normalized) || normalizedSummary.includes(basename);
  }) || /\b(touched files?|changed files?|files changed|changed contracts?|contract changes?)\b|\u53d8\u66f4\u6587\u4ef6|\u4fee\u6539\u6587\u4ef6|\u5951\u7ea6\u53d8\u66f4/i.test(summary);
}

function toLowerJsonText(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}
