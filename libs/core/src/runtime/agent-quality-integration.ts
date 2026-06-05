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
    outline: typeof outputs.outline === 'string' ? outputs.outline : 'doc_outline.json',
    evidenceIndex: typeof outputs.evidence_index === 'string' ? outputs.evidence_index : 'evidence_index.json',
    base: outputs.base === 'project' ? 'project' : 'spec',
  };
}

export function validateAutocodeJsonDocumentObject(
  parsed: Record<string, unknown> | null,
  filePath: string,
  requiredKeys: readonly string[],
): string[] {
  if (!parsed) {
    return [`documentation: ${filePath} is missing or invalid JSON`];
  }

  const issues: string[] = [];
  for (const key of requiredKeys) {
    if (!(key in parsed)) {
      issues.push(`documentation: ${filePath} is missing "${key}"`);
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
  outline: Record<string, unknown> | null,
  evidence: Record<string, unknown> | null,
  outputPath: string,
): string[] {
  const issues: string[] = [];
  const outlineText = toLowerJsonText(outline);
  const evidenceText = toLowerJsonText(evidence);

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

function toLowerJsonText(value: unknown): string {
  return JSON.stringify(value ?? '').toLowerCase();
}
