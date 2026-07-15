export type AutocodeSpecComplexityTier = 'simple' | 'standard' | 'complex';

export type AutocodeSpecPhase =
  | 'discovery'
  | 'requirements'
  | 'complexity_assessment'
  | 'historical_context'
  | 'research'
  | 'context'
  | 'spec_writing'
  | 'self_critique'
  | 'planning'
  | 'requirement_model'
  | 'domain_model'
  | 'design'
  | 'design_model'
  | 'implementation_model'
  | 'design_review'
  | 'validation';

export interface AutocodeSpecWorkflowConfigLike {
  optimizationLevel?: string;
  specCreationMode?: string;
  qualityChecks?: {
    enableSelfCritique?: boolean;
  };
}

export interface AutocodeComplexityAssessmentLike {
  complexity?: AutocodeSpecComplexityTier | string;
  confidence?: number;
  reasoning?: string;
  needs_research?: boolean;
  needs_self_critique?: boolean;
}

export interface AutocodeFallbackComplexityAssessment {
  complexity: AutocodeSpecComplexityTier;
  confidence: number;
  reasoning: string;
  needs_research: boolean;
  needs_self_critique: boolean;
}

export const AUTOCODE_SPEC_COMPLEXITY_PHASES: Record<AutocodeSpecComplexityTier, AutocodeSpecPhase[]> = {
  simple: ['requirements', 'spec_writing', 'requirement_model', 'domain_model', 'design', 'design_model', 'implementation_model', 'design_review', 'planning', 'validation'],
  standard: ['discovery', 'requirements', 'spec_writing', 'requirement_model', 'domain_model', 'design', 'design_model', 'implementation_model', 'design_review', 'planning', 'validation'],
  complex: [
    'discovery',
    'requirements',
    'research',
    'context',
    'spec_writing',
    'self_critique',
    'requirement_model',
    'domain_model',
    'design',
    'design_model',
    'implementation_model',
    'design_review',
    'planning',
    'validation',
  ],
};

export function normalizeAutocodeSpecTaskDescription(taskDescription: string | undefined): string {
  return (taskDescription ?? '').trim();
}

export function isAutocodeSourceDocumentationTask(taskDescription: string | undefined): boolean {
  const text = normalizeAutocodeSpecTaskDescription(taskDescription);
  if (!text) {
    return false;
  }

  const hasInvestigationIntent =
    /\b(analy[sz]e|investigate|inspect|review|understand|summari[sz]e|explain|map|audit|document)\b/i.test(text) ||
    /(\u5206\u6790|\u8c03\u67e5|\u68b3\u7406|\u9605\u8bfb|\u7406\u89e3|\u89e3\u91ca|\u6982\u8ff0|\u5ba1\u8ba1|\u6587\u6863)/.test(text);
  const hasImplementationIntent =
    /\b(implement|add|fix|change|modify|refactor|rewrite|migrate|port|delete|remove|replace|build|create|develop)\b/i.test(text) ||
    /(\u5b9e\u73b0|\u6dfb\u52a0|\u4fee\u590d|\u4fee\u6539|\u6539\u9020|\u91cd\u6784|\u8fc1\u79fb|\u79fb\u690d|\u5220\u9664|\u66ff\u6362|\u6784\u5efa|\u521b\u5efa|\u5f00\u53d1)/.test(text);
  const hasDocumentationOnlyConstraint =
    /\b(do not|don't|without)\b.*\b(modify|change|edit)\b/i.test(text) ||
    /\b(documentation|docs|markdown|report|analysis)\b.*\bonly\b/i.test(text) ||
    /(\u4e0d\u4fee\u6539|\u7981\u6b62\u4fee\u6539|\u4ec5|\u53ea).*(\u6587\u6863|\u5206\u6790|\u62a5\u544a|\u6e90\u7801|\u4ee3\u7801)/.test(text);

  return hasInvestigationIntent && (!hasImplementationIntent || hasDocumentationOnlyConstraint);
}

export function hasAutocodeTaskExternalResearchSignal(text: string): boolean {
  return /(\bapi\b|\bsdk\b|\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\bcloud\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\brest\b|\bplugin\b|\bextension\b|\bpackage\b|\blibrary\b|\bdependency\b|\bintegration\b|\bthird[-\s]?party\b|\bexternal\b|\bauth\b|\bdatabase\b|\bqueue\b|\bmessage broker\b|\bkafka\b|\brabbitmq\b|\u63a5\u53e3|\u96c6\u6210|\u7b2c\u4e09\u65b9|\u5916\u90e8|\u4f9d\u8d56|\u63d2\u4ef6|\u8ba4\u8bc1|\u6388\u6743|\u652f\u4ed8|\u4e91\u670d\u52a1|\u6570\u636e\u5e93|\u6d88\u606f\u961f\u5217)/i.test(text);
}

export function hasAutocodeProjectExternalResearchSignal(text: string): boolean {
  return /(\boauth\b|\bsso\b|\bwebhook\b|\bpayment\b|\bstripe\b|\baws\b|\bazure\b|\bgcp\b|\bfirebase\b|\bsupabase\b|\bpostgres\b|\bmysql\b|\bmongodb\b|\bredis\b|\bgraphql\b|\bgrpc\b|\bkafka\b|\brabbitmq\b|\bthird[-\s]?party\b|\bexternal api\b|\bapi client\b|\u7b2c\u4e09\u65b9|\u5916\u90e8\u63a5\u53e3|\u8ba4\u8bc1|\u6388\u6743|\u652f\u4ed8|\u4e91\u670d\u52a1|\u6570\u636e\u5e93|\u6d88\u606f\u961f\u5217)/i.test(text);
}

export function shouldRunAutocodeSpecResearchPhase(
  assessment: AutocodeComplexityAssessmentLike | null | undefined,
  taskDescription?: string,
  projectDocsReference?: string,
): boolean {
  if (assessment?.needs_research === true) {
    return true;
  }
  if (assessment?.needs_research === false) {
    return false;
  }

  const taskText = (taskDescription ?? '').toLowerCase();
  if (hasAutocodeTaskExternalResearchSignal(taskText)) {
    return true;
  }

  return hasAutocodeProjectExternalResearchSignal((projectDocsReference ?? '').toLowerCase());
}

export function selectAutocodeSpecPhases(input: {
  complexity: AutocodeSpecComplexityTier;
  assessment?: AutocodeComplexityAssessmentLike | null;
  taskDescription?: string;
  projectDocsReference?: string;
  /** @deprecated Use projectDocsReference. */
  projectIndex?: string;
  workflowConfig: AutocodeSpecWorkflowConfigLike;
}): AutocodeSpecPhase[] {
  const phases = [...AUTOCODE_SPEC_COMPLEXITY_PHASES[input.complexity]];

  const conservativeSpecFlow = input.workflowConfig.optimizationLevel === 'conservative' ||
    input.workflowConfig.specCreationMode === 'phased';
  if (input.complexity === 'standard' && !conservativeSpecFlow) {
    const discoveryIndex = phases.indexOf('discovery');
    if (discoveryIndex !== -1) {
      phases.splice(discoveryIndex, 1);
    }
  }

  if (input.complexity === 'simple' && isAutocodeSourceDocumentationTask(input.taskDescription)) {
    return ['requirements', 'spec_writing', 'requirement_model', 'domain_model', 'design', 'design_model', 'implementation_model', 'design_review', 'planning', 'validation'];
  }

  const needsResearch = shouldRunAutocodeSpecResearchPhase(
    input.assessment,
    input.taskDescription,
    input.projectDocsReference ?? input.projectIndex,
  );
  const needsSelfCritique = input.assessment?.needs_self_critique === true;

  if (input.complexity === 'standard' && !conservativeSpecFlow && !needsResearch && !needsSelfCritique) {
    return ['requirements', 'spec_writing', 'requirement_model', 'domain_model', 'design', 'design_model', 'implementation_model', 'design_review', 'planning', 'validation'];
  }

  const researchIndex = phases.indexOf('research');

  if (needsResearch && researchIndex === -1) {
    const insertBefore = phases.indexOf('context') !== -1
      ? phases.indexOf('context')
      : phases.indexOf('spec_writing');
    if (insertBefore !== -1) {
      phases.splice(insertBefore, 0, 'research');
    }
  } else if (!needsResearch && researchIndex !== -1) {
    phases.splice(researchIndex, 1);
  }

  if (input.assessment?.needs_self_critique && !phases.includes('self_critique')) {
    const insertBefore = phases.indexOf('requirement_model') !== -1
      ? phases.indexOf('requirement_model')
      : phases.indexOf('planning');
    if (insertBefore !== -1) {
      phases.splice(insertBefore, 0, 'self_critique');
    }
  }

  return phases;
}

export function shouldForceSplitAutocodeImplementationPlan(
  complexity: AutocodeSpecComplexityTier | undefined,
  workflowConfig: AutocodeSpecWorkflowConfigLike | undefined,
): boolean {
  if (complexity !== 'complex') {
    return false;
  }
  return workflowConfig?.optimizationLevel === 'conservative' ||
    workflowConfig?.specCreationMode === 'phased';
}

export function parseAutocodeProjectDocsReferenceSummary(projectDocsReference: string | undefined): {
  serviceCount: number;
  languageCount: number;
  infrastructureCount: number;
  hasLargeProjectSignal: boolean;
} {
  const summary = {
    serviceCount: 0,
    languageCount: 0,
    infrastructureCount: 0,
    hasLargeProjectSignal: false,
  };

  if (!projectDocsReference?.trim()) {
    return summary;
  }

  try {
    const parsed = JSON.parse(projectDocsReference) as Record<string, unknown>;
    const services = isRecord(parsed.services) ? parsed.services : {};
    summary.serviceCount = Object.keys(services).length;

    const languages = new Set<string>();
    for (const service of Object.values(services)) {
      if (isRecord(service)) {
        stringArrayFrom(service.languages, service.language).forEach((language) => languages.add(language.toLowerCase()));
        stringArrayFrom(service.frameworks, service.framework).forEach((framework) => languages.add(framework.toLowerCase()));
      }
    }

    const project = isRecord(parsed.project) ? parsed.project : {};
    const sourceSummary = isRecord(parsed.source_summary) ? parsed.source_summary : {};
    stringArrayFrom(project.languages).forEach((language) => languages.add(language.toLowerCase()));
    stringArrayFrom(sourceSummary.languages).forEach((language) => languages.add(language.toLowerCase()));
    summary.languageCount = languages.size;

    const infrastructure = isRecord(parsed.infrastructure) ? parsed.infrastructure : {};
    summary.infrastructureCount = Object.values(infrastructure)
      .filter((value) => Array.isArray(value) ? value.length > 0 : Boolean(value))
      .length;
    summary.infrastructureCount += stringArrayFrom(sourceSummary.build_files).length > 0 ? 1 : 0;
    summary.infrastructureCount += stringArrayFrom(sourceSummary.project_files).length > 0 ? 1 : 0;

    const sourceCount = Number(project.sourceFileCount ?? project.source_file_count ?? sourceSummary.source_file_count ?? parsed.sourceFileCount ?? parsed.source_file_count ?? 0);
    const totalCount = Number(project.totalFileCount ?? project.total_file_count ?? sourceSummary.total_file_count ?? parsed.totalFileCount ?? parsed.total_file_count ?? 0);
    summary.hasLargeProjectSignal = project.size === 'large' || sourceCount >= 250 || totalCount >= 1500;
  } catch {
    const text = projectDocsReference.toLowerCase();
    summary.hasLargeProjectSignal = /"size"\s*:\s*"large"|sourcefilecount"\s*:\s*[3-9]\d\d|source_file_count"\s*:\s*[3-9]\d\d|totalfilecount"\s*:\s*[2-9]\d{3,}|total_file_count"\s*:\s*[2-9]\d{3,}/.test(text);
    summary.infrastructureCount = (text.match(/ci_workflows|docker|workflow|pipeline|deployment/g) ?? []).length;
  }

  return summary;
}

/** @deprecated Use parseAutocodeProjectDocsReferenceSummary. */
export function parseAutocodeProjectIndexSummary(projectIndex: string | undefined): ReturnType<typeof parseAutocodeProjectDocsReferenceSummary> {
  return parseAutocodeProjectDocsReferenceSummary(projectIndex);
}

export function inferAutocodeSpecComplexityFallback(input: {
  taskDescription: string;
  projectDocsReference?: string;
  /** @deprecated Use projectDocsReference. */
  projectIndex?: string;
  workflowConfig: AutocodeSpecWorkflowConfigLike;
}): AutocodeFallbackComplexityAssessment {
  const taskText = normalizeAutocodeSpecTaskDescription(input.taskDescription).toLowerCase();
  const projectDocsReference = input.projectDocsReference ?? input.projectIndex;
  const projectText = (projectDocsReference ?? '').toLowerCase();
  const parsedProjectReference = parseAutocodeProjectDocsReferenceSummary(projectDocsReference);
  const needsExternalResearch = shouldRunAutocodeSpecResearchPhase(null, input.taskDescription, projectDocsReference);
  const signals: string[] = [];

  const hasBroadChangeIntent = /(\bmigrate|\bmigration|\bport\b|\bremove\b|\bdelete\b|\breplace\b|\brewrite\b|\brefactor\b|\brework\b|\bredesign\b|\brestructure\b|\bswitch\b|\bconvert\b|\bdeprecate\b|\bdrop\b|\bphase[-\s]?out\b|\u8fc1\u79fb|\u79fb\u9664|\u5220\u9664|\u66ff\u6362|\u91cd\u5199|\u91cd\u6784|\u6539\u9020|\u91cd\u65b0\u8bbe\u8ba1|\u5207\u6362|\u8f6c\u6362|\u5e9f\u5f03|\u4e0b\u7ebf)/i.test(taskText);
  if (hasBroadChangeIntent) {
    signals.push('broad change intent');
  }

  const affectedAreas = [
    /\bruntime\b|\u8fd0\u884c\u65f6/,
    /\beditor\b|\badmin\b|\bdashboard\b|\bui\b|\binterface\b|\u7f16\u8f91\u5668|\u540e\u53f0|\u754c\u9762/,
    /\bbuild\b|\bcompile\b|\bpackag(e|ing)\b|\bbundle\b|\btoolchain\b|\bgenerator\b|\bmakefile\b|\bcmake\b|\bgradle\b|\bmaven\b|\u6784\u5efa|\u7f16\u8bd1|\u6253\u5305|\u5de5\u5177\u94fe|\u9879\u76ee\u751f\u6210/,
    /\bci\b|\bworkflow\b|\bpipeline\b|\bdeploy\b|\brelease\b|\bpublish\b|\u6d41\u6c34\u7ebf|\u53d1\u5e03|\u90e8\u7f72/,
    /\basset\b|\bresource\b|\btemplate\b|\bexample\b|\bdocumentation\b|\bdocs\b|\u8d44\u4ea7|\u8d44\u6e90|\u6a21\u677f|\u793a\u4f8b|\u6587\u6863/,
    /\bapi\b|\bsdk\b|\bplugin\b|\bextension\b|\bmodule\b|\babi\b|\u63a5\u53e3|\u63d2\u4ef6|\u6269\u5c55|\u6a21\u5757/,
    /\bseriali[sz]ation\b|\bschema\b|\bmetadata\b|\breflection\b|\bcompatib/i,
    /\u5e8f\u5217\u5316|\u5143\u6570\u636e|\u53cd\u5c04|\u517c\u5bb9|\u56de\u6eda|\u8fc1\u79fb\u5de5\u5177/,
    /\bplatform\b|\bwindows\b|\blinux\b|\bmacos\b|\bandroid\b|\bios\b|\bcross[-\s]?platform\b|\u5e73\u53f0|\u8de8\u5e73\u53f0/,
    /\bsecurity\b|\bauth\b|\bpermission\b|\brole\b|\u5b89\u5168|\u8ba4\u8bc1|\u6743\u9650|\u89d2\u8272/,
  ];
  const affectedAreaCount = affectedAreas.reduce((count, pattern) =>
    count + (pattern.test(taskText) || pattern.test(projectText) ? 1 : 0), 0);
  if (affectedAreaCount >= 3) {
    signals.push(`${affectedAreaCount} affected areas`);
  }

  if (parsedProjectReference.serviceCount >= 3) signals.push(`${parsedProjectReference.serviceCount} services`);
  if (parsedProjectReference.languageCount >= 3) signals.push(`${parsedProjectReference.languageCount} languages`);
  if (parsedProjectReference.infrastructureCount >= 2) signals.push(`${parsedProjectReference.infrastructureCount} infrastructure signals`);
  if (parsedProjectReference.hasLargeProjectSignal) signals.push('large project profile');

  const isConservative = input.workflowConfig.optimizationLevel === 'conservative' ||
    input.workflowConfig.specCreationMode === 'phased' ||
    input.workflowConfig.qualityChecks?.enableSelfCritique === true;
  const hasLargeProjectContext = parsedProjectReference.hasLargeProjectSignal ||
    parsedProjectReference.serviceCount >= 3 ||
    parsedProjectReference.languageCount >= 3 ||
    parsedProjectReference.infrastructureCount >= 2 ||
    /\bmonorepo\b|\u5927\u578b|\u591a\u6a21\u5757|\u591a\u670d\u52a1|\u591a\u5e73\u53f0/.test(projectText);
  const hasComplexTaskShape = hasBroadChangeIntent && affectedAreaCount >= 3;
  const hasLargeMultiSubsystemProject = parsedProjectReference.hasLargeProjectSignal &&
    (parsedProjectReference.languageCount >= 3 || parsedProjectReference.infrastructureCount >= 2 || parsedProjectReference.serviceCount >= 2);
  const hasEngineOrPlatformSurface = /(\bengine\b|\brenderer\b|\bcompiler\b|\bshader\b|\bruntime\b|\bkernel\b|\bplatform\b|\bframework\b|\bsdk\b|\bplugin\b|\bcross[-\s]?platform\b)/i.test(taskText) ||
    /(\bengine\b|\brenderer\b|\bcompiler\b|\bshader\b|\bruntime\b|\bkernel\b|\bplatform\b|\bframework\b|\bsdk\b|\bplugin\b|\bcross[-\s]?platform\b)/i.test(projectText);

  if (
    isConservative &&
    hasBroadChangeIntent &&
    hasLargeMultiSubsystemProject &&
    (affectedAreaCount >= 2 || hasEngineOrPlatformSurface)
  ) {
    return {
      complexity: 'complex',
      confidence: 0.78,
      reasoning: `local fallback detected conservative broad change in large multi-subsystem project (${signals.join(', ')})`,
      needs_research: needsExternalResearch,
      needs_self_critique: true,
    };
  }

  if ((hasComplexTaskShape && hasLargeProjectContext) || (isConservative && hasComplexTaskShape && affectedAreaCount >= 4)) {
    return {
      complexity: 'complex',
      confidence: 0.75,
      reasoning: `local fallback detected ${signals.join(', ')}`,
      needs_research: needsExternalResearch,
      needs_self_critique: true,
    };
  }

  if (hasComplexTaskShape || (hasBroadChangeIntent && hasLargeProjectContext)) {
    return {
      complexity: 'standard',
      confidence: 0.65,
      reasoning: `local fallback detected ${signals.join(', ') || 'moderate scope'}`,
      needs_research: needsExternalResearch,
      needs_self_critique: isConservative,
    };
  }

  if (needsExternalResearch || isConservative || signals.length > 0 || hasBroadChangeIntent) {
    return {
      complexity: 'standard',
      confidence: needsExternalResearch || signals.length > 0 ? 0.58 : 0.52,
      reasoning: signals.length > 0
        ? `local fallback detected ${signals.join(', ')}`
        : needsExternalResearch
          ? 'local fallback detected external research signal'
          : 'local fallback kept conservative Standard routing',
      needs_research: needsExternalResearch,
      needs_self_critique: isConservative,
    };
  }

  return {
    complexity: 'simple',
    confidence: 0.62,
    reasoning: 'local fallback found no broad, cross-boundary, or high-risk signals; using the normal Standard specification flow',
    needs_research: needsExternalResearch,
    needs_self_critique: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArrayFrom(...values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          result.push(item.trim());
        }
      }
    } else if (typeof value === 'string' && value.trim()) {
      result.push(value.trim());
    }
  }
  return [...new Set(result)];
}
