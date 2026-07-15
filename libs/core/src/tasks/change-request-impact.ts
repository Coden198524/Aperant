export type AutocodeChangeRequestScope = 'planning' | 'implementation';

export type AutocodeChangeRequestImpact =
  | 'requirements'
  | 'design'
  | 'tasks'
  | 'implementation'
  | 'validation';

export type AutocodeChangeRequestDesignOwnerStage =
  | 'requirement_model'
  | 'domain_model'
  | 'design'
  | 'design_model'
  | 'implementation_model';

const REQUIREMENTS_FEEDBACK_PATTERN =
  /\b(requirement|acceptance|behavior|flow|rule|must|support|feature|scenario|logic)\b/i;
const REQUIREMENTS_FEEDBACK_ZH_PATTERN =
  /\u9700\u6c42|\u9a8c\u6536|\u884c\u4e3a|\u6d41\u7a0b|\u89c4\u5219|\u5fc5\u987b|\u65b0\u589e|\u652f\u6301|\u529f\u80fd|\u573a\u666f|\u903b\u8f91/u;

const DESIGN_FEEDBACK_PATTERN =
  /\b(design|architecture|api|schema|protocol|state machine|interface|contract|data model|data structure)\b/i;
const DESIGN_FEEDBACK_ZH_PATTERN =
  /\u8bbe\u8ba1|\u67b6\u6784|\u63a5\u53e3|\u534f\u8bae|\u72b6\u6001\u673a|\u6570\u636e\u7ed3\u6784|\u6570\u636e\u6a21\u578b|\u5951\u7ea6/u;

const TASKS_FEEDBACK_PATTERN =
  /\b(plan|task|subtask|work package|split|separate|checklist|milestone)\b/i;
const TASKS_FEEDBACK_ZH_PATTERN =
  /\u8ba1\u5212|\u4efb\u52a1|\u5b50\u4efb\u52a1|\u5de5\u4f5c\u5305|\u62c6\u5206|\u91cc\u7a0b\u7891|\u6e05\u5355/u;

const VALIDATION_FEEDBACK_PATTERN =
  /\b(test|tests|verify|validation|build|compile|typecheck|lint|qa|package)\b/i;
const VALIDATION_FEEDBACK_ZH_PATTERN =
  /\u6d4b\u8bd5|\u9a8c\u8bc1|\u6784\u5efa|\u7f16\u8bd1|\u7c7b\u578b\u68c0\u67e5|\u6821\u9a8c|\u5ba1\u6838|\u6253\u5305/u;

const IMPLEMENTATION_FAILURE_FEEDBACK_PATTERNS: readonly RegExp[] = [
  /\bcompile (?:failed|failure|error|errors)\b/i,
  /\bcompilation (?:failed|failure|error|errors)\b/i,
  /\bbuild (?:failed|failure|error|errors)\b/i,
  /\bpackage (?:failed|failure|error|errors)\b/i,
  /\btype(?:script)? (?:error|errors|failed|failure)\b/i,
  /\btypecheck\b/i,
  /\btsc\b/i,
  /\blint(?:ing)? (?:error|errors|failed|failure)\b/i,
  /\beslint\b/i,
  /\btest(?:s)? (?:failed|failure|error|errors)\b/i,
  /\bunit test(?:s)? (?:failed|failure)\b/i,
  /\bexit code\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bmodule not found\b/i,
  /\bcannot find module\b/i,
  /\u7f16\u8bd1\u5931\u8d25|\u7f16\u8bd1\u62a5\u9519|\u6784\u5efa\u5931\u8d25|\u6784\u5efa\u62a5\u9519|\u6253\u5305\u5931\u8d25|\u6253\u5305\u62a5\u9519|\u8fd0\u884c\u5931\u8d25|\u542f\u52a8\u5931\u8d25|\u7c7b\u578b\u9519\u8bef|\u7c7b\u578b\u68c0\u67e5\u5931\u8d25|\u6d4b\u8bd5\u5931\u8d25|\u5355\u6d4b\u5931\u8d25|\u6821\u9a8c\u5931\u8d25|\u8bed\u6cd5\u9519\u8bef|\u6a21\u5757\u672a\u627e\u5230/u,
];

const IMPACT_ORDER: readonly AutocodeChangeRequestImpact[] = [
  'requirements',
  'design',
  'tasks',
  'implementation',
  'validation',
];

const REQUIREMENT_MODEL_FEEDBACK_PATTERN =
  /\b(requirement model|use case|scenario|actor|goal|5w1h|normal flow|failure flow|acceptance behavior)\b|\u9700\u6c42\u6a21\u578b|\u7528\u4f8b|\u573a\u666f|\u53c2\u4e0e\u8005|\u6b63\u5e38\u6d41\u7a0b|\u5f02\u5e38\u6d41\u7a0b/iu;
const DOMAIN_MODEL_FEEDBACK_PATTERN =
  /\b(domain model|domain rule|entity|value object|aggregate|invariant|business rule|lifecycle|mutation authority)\b|\u9886\u57df\u6a21\u578b|\u5b9e\u4f53|\u503c\u5bf9\u8c61|\u805a\u5408|\u4e0d\u53d8\u91cf|\u4e1a\u52a1\u89c4\u5219|\u751f\u547d\u5468\u671f|\u53d8\u66f4\u6743\u9650/iu;
const ARCHITECTURE_FEEDBACK_PATTERN =
  /\b(architecture|architectural|adr|boundary|layer|module split|dependency direction|design budget|deployment shape)\b|\u67b6\u6784|\u8fb9\u754c|\u5206\u5c42|\u6a21\u5757\u62c6\u5206|\u4f9d\u8d56\u65b9\u5411|\u8bbe\u8ba1\u9884\u7b97/iu;
const DESIGN_MODEL_FEEDBACK_PATTERN =
  /\b(design model|responsibilit(?:y|ies)|collaborat(?:ion|or)|state owner|flow|contract|interface|design pattern|class design|component design|crc)\b|\u8bbe\u8ba1\u6a21\u578b|\u804c\u8d23|\u534f\u4f5c|\u72b6\u6001\u5f52\u5c5e|\u6d41\u7a0b|\u5951\u7ea6|\u63a5\u53e3|\u8bbe\u8ba1\u6a21\u5f0f|\u7c7b\u8bbe\u8ba1|\u7ec4\u4ef6\u8bbe\u8ba1/iu;
const IMPLEMENTATION_MODEL_FEEDBACK_PATTERN =
  /\b(implementation model|file mapping|symbol mapping|source mapping|integration order|migration mapping|test seam|exact file|exact symbol)\b|\u5b9e\u73b0\u6a21\u578b|\u6587\u4ef6\u6620\u5c04|\u7b26\u53f7\u6620\u5c04|\u6e90\u7801\u6620\u5c04|\u96c6\u6210\u987a\u5e8f|\u8fc1\u79fb\u6620\u5c04|\u6d4b\u8bd5\u7f1d/iu;

export function isAutocodeImplementationFailureFeedback(feedback: string): boolean {
  const normalized = feedback.trim();
  return normalized.length > 0 &&
    IMPLEMENTATION_FAILURE_FEEDBACK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function classifyAutocodeChangeRequestImpact(input: {
  feedback: string;
  scope: AutocodeChangeRequestScope;
}): AutocodeChangeRequestImpact[] {
  const impacts = new Set<AutocodeChangeRequestImpact>();
  const feedback = input.feedback.trim();

  if (input.scope === 'planning') {
    impacts.add('tasks');
    impacts.add('validation');
  } else {
    impacts.add('implementation');
  }

  if (
    REQUIREMENTS_FEEDBACK_PATTERN.test(feedback) ||
    REQUIREMENTS_FEEDBACK_ZH_PATTERN.test(feedback)
  ) {
    impacts.add('requirements');
  }
  if (DESIGN_FEEDBACK_PATTERN.test(feedback) || DESIGN_FEEDBACK_ZH_PATTERN.test(feedback)) {
    impacts.add('design');
  }
  if (TASKS_FEEDBACK_PATTERN.test(feedback) || TASKS_FEEDBACK_ZH_PATTERN.test(feedback)) {
    impacts.add('tasks');
  }
  if (isAutocodeImplementationFailureFeedback(feedback)) {
    impacts.add('implementation');
    impacts.add('validation');
  }
  if (
    VALIDATION_FEEDBACK_PATTERN.test(feedback) ||
    VALIDATION_FEEDBACK_ZH_PATTERN.test(feedback)
  ) {
    impacts.add('validation');
  }

  return IMPACT_ORDER.filter((impact) => impacts.has(impact));
}

export function selectAutocodeChangeRequestDesignOwnerStage(input: {
  feedback: string;
  impacts: readonly AutocodeChangeRequestImpact[];
}): AutocodeChangeRequestDesignOwnerStage | undefined {
  if (input.impacts.includes('requirements')) {
    return 'requirement_model';
  }
  if (!input.impacts.includes('design')) {
    return undefined;
  }

  const feedback = input.feedback.trim();
  if (REQUIREMENT_MODEL_FEEDBACK_PATTERN.test(feedback)) return 'requirement_model';
  if (DOMAIN_MODEL_FEEDBACK_PATTERN.test(feedback)) return 'domain_model';
  if (ARCHITECTURE_FEEDBACK_PATTERN.test(feedback)) return 'design';
  if (DESIGN_MODEL_FEEDBACK_PATTERN.test(feedback)) return 'design_model';
  if (IMPLEMENTATION_MODEL_FEEDBACK_PATTERN.test(feedback)) return 'implementation_model';
  return 'design';
}
