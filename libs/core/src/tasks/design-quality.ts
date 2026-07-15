import { createHash } from 'node:crypto';
import { formatAutocodeRetryErrorLines } from '../text/compaction.js';
import {
  AUTOCODE_STANDARD_DESIGN_MODEL_ARTIFACTS,
  AUTOCODE_STANDARD_DESIGN_PACKAGE_ARTIFACTS,
  AUTOCODE_TASK_ARTIFACTS,
} from './artifacts.js';

export type AutocodeDesignDepth = 'local' | 'standard' | 'complex';
export type AutocodeDesignAnalysisDirection = 'forward-design' | 'reverse-engineering' | 'mixed';
export type AutocodeDesignReviewStatus = 'PASSED' | 'REVISE';
export type AutocodeDesignContractVersion = 3 | 4;
export type AutocodeDesignPackageStage =
  | 'requirement_model'
  | 'domain_model'
  | 'design'
  | 'design_model'
  | 'implementation_model'
  | 'design_review';

export const AUTOCODE_DESIGN_GENERATION_STAGE_ORDER = [
  'requirement_model',
  'domain_model',
  'design',
  'design_model',
  'implementation_model',
] as const satisfies readonly AutocodeDesignPackageStage[];

export function selectAutocodeDesignRevisionStages(
  errors: readonly string[],
): AutocodeDesignPackageStage[] {
  const text = errors.join(' ');
  const firstStage: AutocodeDesignPackageStage =
    /\bRM-[0-9]+\b|requirement_model\.md/i.test(text)
      ? 'requirement_model'
      : /\bDOM-[0-9]+\b|domain_model\.md/i.test(text)
        ? 'domain_model'
        : /\b(?:SYS|DES|FLOW|CONTRACT|PAT|REV)-[0-9]+\b|design_model\.md/i.test(text)
          ? 'design_model'
          : /\bIMP-[0-9]+\b|implementation_model\.md/i.test(text)
            ? 'implementation_model'
            : 'design';
  const startIndex = AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.indexOf(
    firstStage as (typeof AUTOCODE_DESIGN_GENERATION_STAGE_ORDER)[number],
  );
  return [...AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.slice(Math.max(0, startIndex))];
}

export interface AutocodeDesignSection {
  id: string;
  kind: 'ADR' | 'RM' | 'DOM' | 'SYS' | 'DES' | 'FLOW' | 'CONTRACT' | 'PAT' | 'REV' | 'IMP';
  title: string;
  markdown: string;
  startLine: number;
  endLine: number;
}

export interface ValidateAutocodeStandardDesignArtifactsInput {
  designMarkdown?: string | null;
  requirementModelMarkdown?: string | null;
  domainModelMarkdown?: string | null;
  designModelMarkdown?: string | null;
  implementationModelMarkdown?: string | null;
  designReviewMarkdown?: string | null;
  tasksMarkdown?: string | null;
  language?: string;
  requireReview?: boolean;
  requireTaskReferences?: boolean;
}

export interface AutocodeDesignQualityResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  depth?: AutocodeDesignDepth;
  analysisDirection?: AutocodeDesignAnalysisDirection;
  reviewStatus?: AutocodeDesignReviewStatus;
  contractVersion?: AutocodeDesignContractVersion;
  sections: AutocodeDesignSection[];
}

export interface AutocodeDesignPackageMarkdown {
  designMarkdown?: string | null;
  requirementModelMarkdown?: string | null;
  domainModelMarkdown?: string | null;
  designModelMarkdown?: string | null;
  implementationModelMarkdown?: string | null;
}

const REQUIRED_DESIGN_HEADINGS = [
  'Scope And Evidence',
  'Complexity Assessment',
  'Existing Architecture Fit',
  'Engineering Adaptation',
  'Design Budget',
  'Architecture Decision',
  'Requirement Model',
  'Domain Model',
  'System Responsibility Allocation',
  'Design Model',
  'Change And Pattern Analysis',
  'Implementation Model',
  'Applicable Design Principles',
  'Rejected Complexity',
  'Risks And Evolution',
  'Traceability',
] as const;

const REQUIRED_V4_DESIGN_ROOT_HEADINGS = [
  'Scope And Evidence',
  'Complexity Assessment',
  'Existing Architecture Fit',
  'Engineering Adaptation',
  'Design Budget',
  'Architecture Candidates',
  'Architecture Decision',
  'Model Package',
  'Change And Pattern Analysis',
  'Applicable Design Principles',
  'Rejected Complexity',
  'Risks And Evolution',
  'Traceability',
] as const;

const V4_MODEL_FILE_CONTRACTS = [
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.requirementModel,
    title: 'Requirement Model',
    modelKind: 'requirement',
    allowedKinds: ['RM'],
    requiredKinds: ['RM'],
  },
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.domainModel,
    title: 'Domain Model',
    modelKind: 'domain',
    allowedKinds: ['DOM'],
    requiredKinds: ['DOM'],
  },
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.designModel,
    title: 'Design Model',
    modelKind: 'design',
    allowedKinds: ['SYS', 'DES', 'FLOW', 'CONTRACT', 'PAT', 'REV'],
    requiredKinds: ['SYS', 'DES'],
  },
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.implementationModel,
    title: 'Implementation Model',
    modelKind: 'implementation',
    allowedKinds: ['IMP'],
    requiredKinds: ['IMP'],
  },
] as const;

const REQUIRED_DESIGN_ID_KINDS = ['ADR', 'RM', 'DOM', 'SYS', 'DES', 'IMP'] as const;
const DESIGN_HEADING_PATTERN = /^#{3,6}\s+((?:ADR|RM|DOM|SYS|DES|FLOW|CONTRACT|PAT|REV|IMP)-\d{3,})(?:\s+(.+?))?\s*$/i;
const DESIGN_ID_PATTERN = /\b(?:ADR|RM|DOM|SYS|DES|FLOW|CONTRACT|PAT|REV|IMP)-\d{3,}(?![A-Za-z0-9])/gi;
const NON_CANONICAL_DESIGN_HEADING_PATTERN = /^#{3,6}\s+((?:ADR|RM|DOM|SYS|DES|FLOW|CONTRACT|PAT|REV|IMP)-\d{1,2})(?!\d)(?:\s+|$)/gim;
const TASK_ITEM_PATTERN = /^(\s*)-\s+\[[ xX/!-]\]\s+([A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)\.?\s+(.+?)\s*$/;
const TASK_DESIGN_FIELD_PATTERN = /^\s*-\s+(?:[_*`]+)?\s*Design(?:\s+refs?)?\s*(?:[_*`]+)?\s*[:：]\s*(?:[_*`]+)?\s*(.*?)\s*(?:[_*`]+)?\s*$/iu;
const DESIGN_BUDGET_FORMAT_LINES = [
  '- Expected modules changed: <non-negative integer>',
  '- New modules allowed: <non-negative integer>',
  '- New public contracts allowed: <non-negative integer>',
  '- New dependencies allowed: <non-negative integer>',
  '- New architectural patterns: <none or PAT-* IDs>',
] as const;

const DOMAIN_CONCEPT_KIND_TOKENS = [
  'entity',
  'value-object',
  'domain-service',
  'policy',
  'event',
  'technical',
  'other',
] as const;
const SOFTWARE_MAPPING_TOKENS = ['existing', 'new', 'none'] as const;
const DESIGN_ELEMENT_TOKENS = [
  'module',
  'class',
  'component',
  'function',
  'store',
  'process',
  'data-structure',
  'other',
] as const;
const DESIGN_ROLE_STEREOTYPE_TOKENS = [
  'entity',
  'value-object',
  'controller',
  'application-service',
  'domain-service',
  'policy',
  'adapter',
  'repository',
  'view',
  'component',
  'system',
  'port',
  'module',
  'other',
] as const;

const SCOPE_AND_EVIDENCE_FIELDS = [
  'Analysis direction',
  'Primary source of truth',
  'Requirement evidence',
  'Project evidence',
  'Design inferences',
  'Unresolved evidence',
] as const;

const COMPLEXITY_ASSESSMENT_FIELDS = [
  'Primary complexity driver',
  'Business rules and state',
  'Boundary and contract impact',
  'Quality-attribute risks',
  'Depth rationale',
] as const;

const ENGINEERING_ADAPTATION_FIELDS = [
  'Delivery context',
  'System shape',
  'Project paradigm',
  'Paradigm rationale',
  'Object-model applicability',
  'Object-model rationale',
  'Existing boundaries to preserve',
  'Existing patterns to reuse',
  'Language/framework constraints',
  'Integration and test seams',
] as const;

const CHANGE_AND_PATTERN_FIELDS = [
  'Verified variation points',
  'Variation inventory',
  'Candidate patterns evaluated',
  'Simplest change mechanism',
  'Selected patterns',
] as const;

const APPLICABLE_DESIGN_PRINCIPLE_FIELDS = [
  'Cohesion decision',
  'Coupling and dependency decision',
  'Encapsulation decision',
  'SOLID trade-offs',
  'Underdesign checks',
] as const;

const ARCHITECTURE_CANDIDATE_FIELDS = [
  'Architecture baseline',
  'Candidate count',
  'Candidate comparison',
  'Selected architecture',
  'Selection rationale',
  'Rejected alternatives',
  'Evolution trigger',
] as const;

const MODEL_PACKAGE_FIELDS = [
  ['Requirement model', AUTOCODE_TASK_ARTIFACTS.requirementModel],
  ['Domain model', AUTOCODE_TASK_ARTIFACTS.domainModel],
  ['Design model', AUTOCODE_TASK_ARTIFACTS.designModel],
  ['Implementation model', AUTOCODE_TASK_ARTIFACTS.implementationModel],
] as const;

const MODEL_SECTION_FIELDS: Partial<Record<AutocodeDesignSection['kind'], readonly string[]>> = {
  ADR: [
    'Decision',
    'Status',
    'Decision drivers',
    'Alternatives considered',
    'Trade-offs',
    'Evidence basis',
  ],
  RM: [
    'Actor and goal',
    'Business context',
    'Trigger and preconditions',
    'Normal flow',
    'Alternate or failure flow',
    'Outcome',
    'Constraints',
    'Quality constraints',
    'Evidence basis',
  ],
  DOM: [
    'Concept kind',
    'Business meaning',
    'Identity and state',
    'Behavior',
    'Responsibilities',
    'Rules and invariants',
    'Ownership and lifecycle',
    'Relationships',
    'Software mapping',
    'Evidence basis',
  ],
  SYS: [
    'Subsystem or boundary',
    'Allocated requirements',
    'Owns',
    'Provides',
    'Requires',
    'Data and control boundary',
    'Failure ownership',
    'Evidence basis',
  ],
  DES: [
    'Element',
    'System allocation',
    'Role stereotype',
    'Owned state',
    'Public operations',
    'Responsibilities',
    'Collaborators',
    'Dependencies',
    'Encapsulation boundary',
    'Does not own',
    'Evidence basis',
  ],
  FLOW: ['Trigger', 'Participants', 'Steps', 'State changes', 'Failure paths', 'Evidence basis'],
  CONTRACT: ['Inputs and outputs', 'Compatibility', 'Errors', 'Lifecycle', 'Evidence basis'],
  PAT: [
    'Verified variation',
    'Evidence',
    'Expected horizon',
    'Stable boundary',
    'Encapsulated variation',
    'Participants and roles',
    'Application scope',
    'Simpler alternative',
    'Benefit',
    'Cost and failure modes',
  ],
  REV: [
    'External capability',
    'Domain concepts',
    'Responsibility path',
    'Runtime path',
    'Source symbols',
    'Contradiction checks',
    'Confidence',
  ],
  IMP: [
    'Project files and symbols',
    'Design mapping',
    'Integration constraints',
    'Verification',
    'Evidence basis',
  ],
};

export const AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT = [
  'Deterministic machine contract. Keep every field label, list marker, ASCII colon, enum token, ID, and provenance prefix in English exactly as shown. Localize only descriptive prose.',
  'Design package identity:',
  '- First line: # Design: <localized task title>',
  '- Design-Contract: 4',
  '- Design-Depth: local|standard|complex',
  '- Design-Revision: <non-negative integer>',
  '- design.md defines ADR-* only and references requirement_model.md, domain_model.md, design_model.md, and implementation_model.md.',
  '- Every model file declares Design-Contract: 4, the same Design-Revision, Design-Root: design.md, and its exact Model-Kind.',
  '- requirement_model.md owns RM-*; domain_model.md owns DOM-*; design_model.md owns SYS/DES/FLOW/CONTRACT/PAT/REV; implementation_model.md owns IMP-*.',
  '- Stable IDs use at least three digits: ADR-001, RM-001, DOM-001, SYS-001, DES-001, FLOW-001 or CONTRACT-001, optional PAT-001/REV-001, and IMP-001.',
  'Architecture candidate fields in design.md:',
  '- Architecture baseline: <observed current architecture or smallest viable baseline>',
  '- Candidate count: <integer; local=1, standard<=2, complex<=3>',
  '- Candidate comparison: <candidate | fit | benefits | costs | risks; repeat compactly>',
  '- Selected architecture: <candidate name>',
  '- Selection rationale: <evidence-backed trade-off>',
  '- Rejected alternatives: <candidate and concrete rejection reason>',
  '- Evolution trigger: <evidence that would justify a deeper architecture>',
  'Model package fields in design.md:',
  '- Requirement model: requirement_model.md',
  '- Domain model: domain_model.md',
  '- Design model: design_model.md',
  '- Implementation model: implementation_model.md',
  'Scope and engineering enum-only values:',
  '- Analysis direction: forward-design|reverse-engineering|mixed',
  '- Primary source of truth: requirement|source|mixed',
  '- Delivery context: greenfield|existing-system|new-subsystem|migration',
  '- System shape: local-utility|stateful-domain|interactive-simulation|data-flow|integration|mixed|other',
  '- Project paradigm: object-oriented|functional|data-oriented|procedural|mixed|other',
  '- Object-model applicability: high|medium|low',
  'Evidence provenance:',
  '- Requirement evidence: requirement - <source and claim> | none - <reason>',
  '- Project evidence: observed - <path, project document, repository evidence, or verified URL>',
  '- Design inferences: inferred - <rationale> | none - <reason>',
  '- Unresolved evidence: unresolved - <open question> | none',
  '- Every Evidence basis value uses one or more requirement - ..., observed - ..., inferred - ..., or unresolved - ... entries.',
  'Design Budget uses these exact bullet fields. Keep the English field names, list markers, and ASCII colons; do not use headings for these fields:',
  ...DESIGN_BUDGET_FORMAT_LINES,
  'Exact model fields and value formats:',
  '- ADR: Decision; Status=proposed|accepted|superseded|rejected; Decision drivers; Alternatives considered; Trade-offs; Evidence basis.',
  '- RM: Actor and goal; Business context; Trigger and preconditions; Normal flow; Alternate or failure flow; Outcome; Constraints; Quality constraints; Evidence basis.',
  '- Business context: Who=...; What=...; Why=...; When=...; Where=...; How=... using ASCII equals signs and semicolons.',
  '- Quality constraints: <ASCII Dimension>=<localized value>; <ASCII Dimension>=<localized value>, or none - <reason>. Dimension names are descriptive identifiers such as Correctness, Performance, Reliability, Compatibility, or Compliance.',
  '- DOM Concept kind: ' + DOMAIN_CONCEPT_KIND_TOKENS.join('|'),
  '- DOM Software mapping: ' + SOFTWARE_MAPPING_TOKENS.join('|') + ' - <localized concrete path/symbol mapping or reason>',
  '- DOM: Business meaning; Identity and state; Behavior; Responsibilities; Rules and invariants; Ownership and lifecycle; Relationships; Evidence basis.',
  '- SYS: Subsystem or boundary; Allocated requirements; Owns; Provides; Requires; Data and control boundary; Failure ownership; Evidence basis.',
  '- DES Element: ' + DESIGN_ELEMENT_TOKENS.join('|') + ' - <localized concrete element or symbol>',
  '- DES Role stereotype: ' + DESIGN_ROLE_STEREOTYPE_TOKENS.join('|'),
  '- DES: System allocation; Owned state; Public operations; Responsibilities; Collaborators; Dependencies; Encapsulation boundary; Does not own; Evidence basis.',
  '- FLOW: Trigger; Participants; Steps; State changes; Failure paths; Evidence basis. Steps name every DES participant in explicit order.',
  '- CONTRACT: Inputs and outputs; Compatibility; Errors; Lifecycle; Evidence basis.',
  '- Change analysis: Verified variation points; Variation inventory; Candidate patterns evaluated; Simplest change mechanism; Selected patterns.',
  '- REV when applicable: External capability; Domain concepts; Responsibility path; Runtime path; Source symbols; Contradiction checks=checked|conflict|unresolved - <evidence>; Confidence=high|medium|low - <rationale>.',
  '- IMP: Project files and symbols; Design mapping; Integration constraints; Verification; Evidence basis.',
  '- Applicable Design Principles: Cohesion decision; Coupling and dependency decision; Encapsulation decision; SOLID trade-offs; Underdesign checks.',
  'Allocation and traceability invariants:',
  '- Every RM is allocated by SYS. Every SYS has at least one DES implementation responsibility; represent a build/test/docs boundary with a concrete DES module/component or merge it into an implemented SYS.',
  '- Every DES maps to SYS and participates in FLOW or CONTRACT at Standard/Complex depth. Every IMP maps SYS, DES, and FLOW or CONTRACT.',
  '- Traceability includes every ADR and a directed path for every RM through DOM, SYS, DES, FLOW or CONTRACT, and IMP.',
].join('\n');

export const AUTOCODE_STANDARD_DESIGN_METHOD_PROMPT = `
You are the software designer for a staged Standard-mode design package. Write only the artifact named by
the current stage. Never collapse model bodies back into design.md and never edit source code or tasks.

Generate the package in this dependency order:
1. requirement_model.md derives independently verifiable RM-* scenarios from requirements and spec evidence.
2. domain_model.md derives DOM-* concepts, rule owners, invariants, identity, state, behavior, and lifecycle.
3. design.md compares bounded architecture candidates and records ADR-* decisions, budget, and package index.
4. design_model.md allocates RM-* to SYS-* and defines DES/FLOW/CONTRACT plus evidenced PAT/REV decisions.
5. implementation_model.md maps the approved model to exact project files, symbols, integration order, and tests.

Each stage reads the approved upstream artifacts. Do not pre-empt a downstream model with vague filler or
duplicate an upstream model in prose. Preserve stable IDs during Request Changes and revise only the
affected model plus its downstream dependants.

Choose the smallest project-consistent design that fully models the verified behavior. Reject both
overdesign and underdesign. Preserve proven existing boundaries and patterns, but do not treat the absence
of abstractions in a greenfield product or new subsystem as evidence for procedural design. Infer the
paradigm from the problem shape, lifecycle, state, behavior, quality constraints, framework ownership, and
credible variation. Apply the same reasoning across languages and platforms. A stateful interactive system
normally needs explicit behavior/state owners and ordered collaboration, implemented with the repository's
proven object, component, data-oriented, functional, procedural, or mixed model.

Select one analysis direction. Use forward-design for intended behavior, reverse-engineering for explaining
or preserving an existing implementation, and mixed only when a change first requires reconstructing an
uncertain source behavior. Mark claims as requirement, observed, inferred, or unresolved. Never promote an
inference to a source fact.

For forward design, derive connected models in order: relevant 5W1H and 8C constraints, independently
verifiable scenarios, domain concepts and invariants, system requirement allocation, detailed static and
dynamic design, then exact implementation mapping. For reverse engineering, work outside-in: external
capability and guarantees, domain concepts, subsystem responsibilities/interfaces, runtime collaborations,
then exact packages/classes/functions and contradiction checks. Do not read a large codebase linearly from
an entry point and call that architecture analysis.

Analyze relevant 5W1H business context and relevant quality constraints.
Discover domain concepts from scenario nouns; classify meaningful entities, value objects, policies,
events, and domain services; then add identity/state, behavior, relations, invariants, ownership, and
lifecycle. Derive operations from scenario verbs and assign decisions to their information owner. Use
CRC-style responsibility/collaborator reasoning, keep behavior with invariant owners, and make coordinators
coordinate rather than absorb domain behavior. Allocate every RM-* to a SYS-* boundary before detailed
DES-* elements. Define what each subsystem owns, provides, requires, and how it contains failures. Model
ordered collaboration, state changes, failures, contracts, ownership/lifetime, timing/concurrency where
relevant, and exact file/symbol/test integration.

Start with exactly "# Design: <localized task title>". Use stable headings with zero-padded IDs such as
ADR-001, RM-001, DOM-001, SYS-001, DES-001, FLOW-001/CONTRACT-001, optional PAT-001, optional REV-001,
and IMP-001. Every stable ID uses at least three digits; ADR-1 and DES-01 are invalid. REV-* is required only
for reverse-engineering or mixed analysis. Include an evidence ledger
and a Design Budget that limits changed/new modules, public contracts, dependencies, and architectural
patterns. Put these exact machine-readable bullet fields directly under
"## Design Budget" using an ASCII colon; do not turn the field names into Markdown headings:
${DESIGN_BUDGET_FORMAT_LINES.join('\n')}

Also use exact machine fields for Scope And Evidence, Complexity Assessment, Engineering Adaptation,
Architecture/Requirement/Domain/System/Design/Flow-or-Contract/Reverse/Implementation entries, and Change
And Pattern Analysis. Machine enum tokens and evidence prefixes are part of the contract: keep them in
English, unquoted, and without trailing prose. Localize only descriptive prose after a required " - " prefix
or in non-enum fields. Every model entry records an evidence basis. Adapt to the repository paradigm; do not
force classes or services into functional, data-oriented, procedural, or framework-owned code.

For a stateful interactive product, cover its principal lifecycle and frame/event flows rather than a token
model. Separate intent/input, domain or simulation rules, state transitions, collision/conflict resolution,
effects, persistence where present, and presentation according to proven boundaries. Make ownership,
mutation authority, resource lifetime, update order, and policy/state variation explicit. This rule is
based on system behavior, never on the implementation language.

Apply NOP and find verified variation before selecting its mechanism. NOP is not pattern avoidance:
evaluate applicable candidates for every concrete variation and reject both keyword-driven patterns and
growing state/type switches left in place merely to avoid a fitting pattern. Local selects no new pattern;
Standard selects at most two; Complex at most three. A PAT-* decision must record evidence, credible horizon,
stable boundary, participants/roles, limited application scope, simpler alternative, benefit, and costs.
Extending an established pattern inside its current boundary is engineering reuse, not a new PAT-* decision.

SOLID and named patterns are tools, not goals. Do not add an interface, service, layer, repository, event
bus, plugin system, framework, dependency, or extension point for a hypothetical future need. Also reject
God coordinators, anemic domain objects, implicit mutation/lifetime ownership, and scattered conditional
dispatch over multiple states/types/policies. Explicitly list rejected complexity and underdesign checks.

${AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT}
`.trim();

export const AUTOCODE_STANDARD_DESIGN_CRITIC_PROMPT = `
You are an independent senior designer reviewing the complete five-file design package. Write only
design_review.md. Start
with exactly "Status: PASSED" or "Status: REVISE". Check requirement fit, cited project evidence,
architecture fit, responsibility allocation, dependency direction, static/dynamic consistency,
implementation feasibility, testability, traceability, and the Design Budget. Reject both speculative
architecture and shallow procedural decomposition.

Verify the declared analysis direction and evidence status of every material claim. For forward design,
check relevant 5W1H/8C coverage, scenario completeness, domain noun filtering, identity/state/behavior,
system requirement allocation, rule/invariant ownership, responsibility assignment from scenario verbs,
and collaboration/state/failure behavior. For reverse engineering, verify the outside-in chain from
external capability through domain concepts, subsystem responsibilities, runtime flow, and exact source
symbols; reject contradictions with observed source and unsupported certainty.

Verify exact engineering fit to project files, symbols, paradigm, framework boundaries, and test seams.
Do not reject OO merely because a greenfield project has no existing classes, and do not force OO into a
proven component, data-oriented, functional, procedural, or framework-owned boundary. Stateful interactive
systems require explicit behavior/state owners and ordered collaboration regardless of language.

Reject both technically valid overdesign and technically executable underdesign. In particular, reject speculative interfaces, services, layers,
repositories, event buses, plugin systems, frameworks, dependencies, broad unrelated refactors, or named
patterns without a current or confirmed near-term variation, stable boundary, simpler alternative, concrete
benefit, participants/roles, limited application scope, and explicit cost. Apply NOP, but do not interpret
it as pattern avoidance when multiple behavior-changing states or independently varying policies already
exist. A local change selects no new pattern; Standard selects at most two and Complex at most three.
A direct mechanism wins only when it remains more cohesive and does not scatter variation.

Reject God coordinators, anemic domain objects, implicit ownership/lifetime/mutation authority, scattered
state/type/policy conditionals, detailed elements that bypass SYS-* allocation, static elements absent from
their runtime flows, object-oriented designs without meaningful operations and owned state, token
interactive models, source reconstructions without exact symbols/contradiction checks, and traceability
that merely lists IDs. When revising, list only blocking findings and recommend the smallest complete
correction. Do not rewrite design.md or approve unresolved assumptions that materially affect implementation.
`.trim();

export function getAutocodeDesignContractVersion(
  markdown: string | null | undefined,
): AutocodeDesignContractVersion | undefined {
  const match = /^Design-Contract:\s*(3|4)\s*$/im.exec(markdown ?? '');
  return match ? Number(match[1]) as AutocodeDesignContractVersion : undefined;
}

export function buildAutocodeDesignPackageMarkdown(
  input: AutocodeDesignPackageMarkdown,
): string {
  const artifacts: Array<[string, string | null | undefined]> = [
    [AUTOCODE_TASK_ARTIFACTS.design, input.designMarkdown],
    [AUTOCODE_TASK_ARTIFACTS.requirementModel, input.requirementModelMarkdown],
    [AUTOCODE_TASK_ARTIFACTS.domainModel, input.domainModelMarkdown],
    [AUTOCODE_TASK_ARTIFACTS.designModel, input.designModelMarkdown],
    [AUTOCODE_TASK_ARTIFACTS.implementationModel, input.implementationModelMarkdown],
  ];
  return artifacts
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0)
    .map(([fileName, markdown]) => `<!-- Design artifact: ${fileName} -->\n${markdown.trim()}`)
    .join('\n\n')
    .trim();
}

export function getAutocodeDesignPackageFingerprint(
  input: AutocodeDesignPackageMarkdown,
): string {
  return hashDesignContent(buildAutocodeDesignPackageMarkdown(input));
}

export function extractAutocodeDesignPackageReferenceExcerpt(
  input: AutocodeDesignPackageMarkdown,
  refs: readonly string[],
): string {
  return extractAutocodeDesignReferenceExcerpt(buildAutocodeDesignPackageMarkdown(input), refs);
}

function getV4ModelDocuments(input: AutocodeDesignPackageMarkdown) {
  return [
    { contract: V4_MODEL_FILE_CONTRACTS[0], markdown: input.requirementModelMarkdown },
    { contract: V4_MODEL_FILE_CONTRACTS[1], markdown: input.domainModelMarkdown },
    { contract: V4_MODEL_FILE_CONTRACTS[2], markdown: input.designModelMarkdown },
    { contract: V4_MODEL_FILE_CONTRACTS[3], markdown: input.implementationModelMarkdown },
  ] as const;
}

function validateStructuredModelSections(
  sections: readonly AutocodeDesignSection[],
  artifact: string,
): string[] {
  const errors: string[] = [];
  for (const section of sections) {
    const body = section.markdown.replace(/^#{3,6}\s+[^\n]+\s*/i, '').trim();
    if (body.length < 20 || /^(?:none|n\/a|not applicable|todo|tbd)\.?$/i.test(body)) {
      errors.push(`${artifact} ${section.id} must contain a substantive model entry.`);
    }
    const fields = MODEL_SECTION_FIELDS[section.kind];
    if (fields) {
      errors.push(...validateMachineReadableFields(section.markdown, `${artifact} ${section.id}`, fields));
    }
    const evidenceBasis = getMachineReadableField(section.markdown, 'Evidence basis');
    if (evidenceBasis) {
      errors.push(...validateEvidenceBasis(evidenceBasis, `${artifact} ${section.id} Evidence basis`));
    }
    if (section.kind === 'RM') {
      errors.push(...validateRequirementContext(section));
    }
  }
  return errors;
}

function validateV4ModelDocumentIdentity(
  markdown: string,
  contract: (typeof V4_MODEL_FILE_CONTRACTS)[number],
  expectedRevision?: string,
): string[] {
  const errors: string[] = [];
  if (markdown.length === 0) {
    errors.push(contract.artifact + ' is empty.');
  }
  const expectedTitle = '# ' + contract.title + ':';
  if (!markdown.startsWith(expectedTitle)) {
    errors.push(contract.artifact + ' must start with ' + expectedTitle + ' followed by a localized title.');
  }
  const identityLines = markdown.split(String.fromCharCode(10)).map((line) => line.trim());
  if (!identityLines.includes('Design-Contract: 4')) {
    errors.push(contract.artifact + ' must declare Design-Contract: 4.');
  }
  const revisionLine = identityLines.find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  if (!revision || !Number.isInteger(Number(revision)) || Number(revision) < 0) {
    errors.push(contract.artifact + ' must declare a numeric Design-Revision.');
  } else if (expectedRevision !== undefined && revision !== expectedRevision) {
    errors.push(contract.artifact + ' Design-Revision must match ' + AUTOCODE_TASK_ARTIFACTS.design + '.');
  }
  if (!identityLines.includes('Design-Root: ' + AUTOCODE_TASK_ARTIFACTS.design)) {
    errors.push(contract.artifact + ' must declare Design-Root: ' + AUTOCODE_TASK_ARTIFACTS.design + '.');
  }
  if (!identityLines.includes('Model-Kind: ' + contract.modelKind)) {
    errors.push(contract.artifact + ' must declare Model-Kind: ' + contract.modelKind + '.');
  }
  if (!hasMarkdownHeading(markdown, contract.title)) {
    errors.push(contract.artifact + ' is missing its level-two ' + contract.title + ' section.');
  }
  return errors;
}

function validateV4ModelDocument(
  markdownValue: string | null | undefined,
  contract: (typeof V4_MODEL_FILE_CONTRACTS)[number],
  expectedRevision?: string,
): string[] {
  const markdown = markdownValue?.trim() ?? '';
  if (!markdown) {
    return [contract.artifact + ' is missing from the Design-Contract: 4 package.'];
  }
  const errors = validateV4ModelDocumentIdentity(markdown, contract, expectedRevision);
  const sections = parseAutocodeDesignSections(markdown);
  const allowedKinds = new Set<string>(contract.allowedKinds);
  for (const section of sections) {
    if (!allowedKinds.has(section.kind)) {
      errors.push(contract.artifact + ' may not define ' + section.id + '; that ID belongs to another design artifact.');
    }
  }
  for (const requiredKind of contract.requiredKinds) {
    if (!sections.some((section) => section.kind === requiredKind)) {
      errors.push(contract.artifact + ' must define at least one ' + requiredKind + '-* section.');
    }
  }
  if (
    contract.artifact === AUTOCODE_TASK_ARTIFACTS.designModel &&
    !sections.some((section) => section.kind === 'FLOW' || section.kind === 'CONTRACT')
  ) {
    errors.push(contract.artifact + ' must define at least one FLOW-* or CONTRACT-* section.');
  }
  for (const invalidId of findNonCanonicalAutocodeDesignHeadingIds(markdown)) {
    errors.push(contract.artifact + ' heading ' + invalidId + ' is invalid; stable IDs require at least three digits.');
  }
  for (const duplicateId of findDuplicateAutocodeDesignIds(markdown)) {
    errors.push(contract.artifact + ' defines ' + duplicateId + ' more than once.');
  }
  errors.push(...validateStructuredModelSections(sections, contract.artifact));
  return errors;
}

function validateV4DesignRoot(
  designMarkdownValue: string | null | undefined,
): string[] {
  const errors: string[] = [];
  const designMarkdown = designMarkdownValue?.trim() ?? '';
  if (!designMarkdown) {
    return [AUTOCODE_TASK_ARTIFACTS.design + ' is missing.'];
  }
  if (!designMarkdown.startsWith('# Design:')) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must start with # Design: followed by a localized title.');
  }
  const identityLines = designMarkdown.split(String.fromCharCode(10)).map((line) => line.trim());
  if (!identityLines.includes('Design-Contract: 4')) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare Design-Contract: 4.');
  }
  if (!getAutocodeDesignDepth(designMarkdown)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare Design-Depth: local, standard, or complex.');
  }
  const revisionLine = identityLines.find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  if (!revision || !Number.isInteger(Number(revision)) || Number(revision) < 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare a numeric Design-Revision.');
  }
  for (const heading of REQUIRED_V4_DESIGN_ROOT_HEADINGS) {
    if (!hasMarkdownHeading(designMarkdown, heading)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' is missing level-two section ' + heading + '.');
    }
  }
  const rootSections = parseAutocodeDesignSections(designMarkdown);
  for (const section of rootSections) {
    if (section.kind !== 'ADR') {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' may not define ' + section.id + '; model IDs belong in referenced model files.');
    }
  }
  if (!rootSections.some((section) => section.kind === 'ADR')) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must define at least one ADR-* section.');
  }
  errors.push(...validateStructuredModelSections(rootSections, AUTOCODE_TASK_ARTIFACTS.design));
  const architectureCandidates = extractMarkdownSection(designMarkdown, 'Architecture Candidates');
  const depth = getAutocodeDesignDepth(designMarkdown);
  errors.push(...validateArchitectureCandidateDecision(architectureCandidates, depth));
  const modelPackage = extractMarkdownSection(designMarkdown, 'Model Package');
  for (const [field, fileName] of MODEL_PACKAGE_FIELDS) {
    const value = getMachineReadableField(modelPackage, field);
    if (value !== fileName) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Model Package must contain - ' + field + ': ' + fileName + '.');
    }
  }
  return errors;
}

function validateV4DesignPackage(
  input: ValidateAutocodeStandardDesignArtifactsInput,
  combinedMarkdown: string,
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
  analysisDirection: AutocodeDesignAnalysisDirection | undefined,
): string[] {
  const errors = validateV4DesignRoot(input.designMarkdown);
  const revisionLine = (input.designMarkdown ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  for (const document of getV4ModelDocuments(input)) {
    errors.push(...validateV4ModelDocument(document.markdown, document.contract, revision));
  }
  for (const heading of REQUIRED_DESIGN_HEADINGS) {
    if (!hasMarkdownHeading(combinedMarkdown, heading)) {
      errors.push('Design package is missing level-two section ' + heading + '.');
    }
  }
  for (const kind of REQUIRED_DESIGN_ID_KINDS) {
    if (!sections.some((section) => section.kind === kind)) {
      errors.push('Design package must define at least one ' + kind + '-* section.');
    }
  }
  if (!sections.some((section) => section.kind === 'FLOW' || section.kind === 'CONTRACT')) {
    errors.push('Design package must define at least one FLOW-* or CONTRACT-* section.');
  }
  for (const duplicateId of findDuplicateAutocodeDesignIds(combinedMarkdown)) {
    errors.push('Design package defines ' + duplicateId + ' more than once.');
  }
  errors.push(...validateDesignBudget(combinedMarkdown, depth, sections));
  errors.push(...validateStructuredDesignMethod(combinedMarkdown, sections, depth));
  errors.push(...validateSystemResponsibilityAllocation(sections));
  errors.push(...validateObjectModelDepth(combinedMarkdown, sections, depth));
  errors.push(...validateStaticDynamicConsistency(sections, depth));
  errors.push(...validateSourceReconstruction(combinedMarkdown, sections, analysisDirection));
  errors.push(...validateDesignTraceability(combinedMarkdown, sections));
  errors.push(...validateDesignEvidence(combinedMarkdown));
  errors.push(...validateRejectedComplexity(combinedMarkdown));
  errors.push(...validateLocalDesignComplexity(combinedMarkdown, depth));
  return errors;
}

export function validateAutocodeStandardDesignStageArtifacts(
  input: ValidateAutocodeStandardDesignArtifactsInput,
  stage: AutocodeDesignPackageStage,
): AutocodeDesignQualityResult {
  if (stage === 'implementation_model' || stage === 'design_review') {
    return validateAutocodeStandardDesignArtifacts({
      ...input,
      requireReview: stage === 'design_review',
      requireTaskReferences: false,
    });
  }
  const errors: string[] = [];
  const documents = getV4ModelDocuments(input);
  errors.push(...validateV4ModelDocument(documents[0].markdown, documents[0].contract));
  if (stage !== 'requirement_model') {
    errors.push(...validateV4ModelDocument(documents[1].markdown, documents[1].contract));
  }
  if (stage === 'design' || stage === 'design_model') {
    errors.push(...validateV4DesignRoot(input.designMarkdown));
  }
  if (stage === 'design_model') {
    const revisionLine = (input.designMarkdown ?? '')
      .split(String.fromCharCode(10))
      .map((line) => line.trim())
      .find((line) => line.startsWith('Design-Revision:'));
    const revision = revisionLine?.slice('Design-Revision:'.length).trim();
    errors.push(...validateV4ModelDocument(documents[2].markdown, documents[2].contract, revision));
  }
  const packageMarkdown = buildAutocodeDesignPackageMarkdown(input);
  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    depth: getAutocodeDesignDepth(input.designMarkdown ?? ''),
    analysisDirection: getAutocodeDesignAnalysisDirection(input.designMarkdown ?? ''),
    reviewStatus: getAutocodeDesignReviewStatus(input.designReviewMarkdown ?? ''),
    contractVersion: 4,
    sections: parseAutocodeDesignSections(packageMarkdown),
  };
}

export function validateAutocodeStandardDesignArtifacts(
  input: ValidateAutocodeStandardDesignArtifactsInput,
): AutocodeDesignQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const designMarkdown = input.designMarkdown?.trim() ?? '';
  const reviewMarkdown = input.designReviewMarkdown?.trim() ?? '';
  const contractVersion = getAutocodeDesignContractVersion(designMarkdown);
  const packageMarkdown = contractVersion === 4
    ? buildAutocodeDesignPackageMarkdown(input)
    : designMarkdown;
  const sections = parseAutocodeDesignSections(packageMarkdown);
  const depth = getAutocodeDesignDepth(designMarkdown);
  const analysisDirection = getAutocodeDesignAnalysisDirection(designMarkdown);
  const reviewStatus = getAutocodeDesignReviewStatus(reviewMarkdown);

  if (!designMarkdown) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} is missing.`);
  } else if (contractVersion === 4) {
    errors.push(...validateV4DesignPackage(
      input,
      packageMarkdown,
      sections,
      depth,
      analysisDirection,
    ));
  } else {
    if (!/^#\s+Design\s*:/im.test(designMarkdown)) {
      errors.push(
        `${AUTOCODE_TASK_ARTIFACTS.design} must start with the exact heading ` +
        '"# Design: <localized title>"; localize only the title after the ASCII colon.',
      );
    }
    if (!/^Design-Contract:\s*3\s*$/im.test(designMarkdown)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} must declare Design-Contract: 3.`);
    }
    if (!depth) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} must declare Design-Depth: local, standard, or complex.`);
    }
    if (!/^Design-Revision:\s*\d+\s*$/im.test(designMarkdown)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} must declare a numeric Design-Revision.`);
    }
    for (const heading of REQUIRED_DESIGN_HEADINGS) {
      if (!hasMarkdownHeading(designMarkdown, heading)) {
        errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} missing "## ${heading}" section.`);
      }
    }
    const nonCanonicalHeadingIds = findNonCanonicalAutocodeDesignHeadingIds(designMarkdown);
    for (const kind of REQUIRED_DESIGN_ID_KINDS) {
      if (!sections.some((section) => section.kind === kind)) {
        const invalidIds = nonCanonicalHeadingIds.filter((id) => id.startsWith(kind + '-'));
        errors.push(invalidIds.length > 0
          ? `${AUTOCODE_TASK_ARTIFACTS.design} heading ${invalidIds.join(', ')} is invalid; ` +
            `stable ${kind}-* IDs require at least three digits, for example ${kind}-001. ` +
            'Update the definition and every reference consistently.'
          : `${AUTOCODE_TASK_ARTIFACTS.design} must define at least one ${kind}-* section ` +
            `using at least three digits, for example ${kind}-001.`);
      }
    }
    if (!sections.some((section) => section.kind === 'FLOW' || section.kind === 'CONTRACT')) {
      const invalidIds = nonCanonicalHeadingIds.filter((id) => /^(?:FLOW|CONTRACT)-/.test(id));
      errors.push(invalidIds.length > 0
        ? `${AUTOCODE_TASK_ARTIFACTS.design} heading ${invalidIds.join(', ')} is invalid; ` +
          'FLOW-* and CONTRACT-* IDs require at least three digits, for example FLOW-001. ' +
          'Update the definition and every reference consistently.'
        : `${AUTOCODE_TASK_ARTIFACTS.design} must define at least one FLOW-* or CONTRACT-* section ` +
          'using at least three digits, for example FLOW-001.');
    }
    for (const duplicateId of findDuplicateAutocodeDesignIds(designMarkdown)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} defines ${duplicateId} more than once.`);
    }
    errors.push(...validateDesignBudget(designMarkdown, depth, sections));
    errors.push(...validateStructuredDesignMethod(designMarkdown, sections, depth));
    errors.push(...validateSystemResponsibilityAllocation(sections));
    errors.push(...validateObjectModelDepth(designMarkdown, sections, depth));
    errors.push(...validateStaticDynamicConsistency(sections, depth));
    errors.push(...validateSourceReconstruction(designMarkdown, sections, analysisDirection));
    errors.push(...validateDesignTraceability(designMarkdown, sections));
    errors.push(...validateDesignEvidence(designMarkdown));
    errors.push(...validateRejectedComplexity(designMarkdown));
    errors.push(...validateLocalDesignComplexity(designMarkdown, depth));
  }

  if (input.requireReview !== false) {
    if (!reviewMarkdown) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.designReview} is missing.`);
    } else if (!reviewStatus) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.designReview} must contain exactly Status: PASSED or Status: REVISE.`);
    } else if (reviewStatus !== 'PASSED') {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.designReview} has unresolved Status: REVISE findings.`);
    } else if (isChineseOutputLanguage(input.language) && !hasMeaningfulChineseReviewBody(reviewMarkdown)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designReview +
        ' review prose must use Simplified Chinese for language ' + input.language +
        '. Keep only the required Status token and technical identifiers in English.',
      );
    }
  }

  if (input.requireTaskReferences !== false && input.tasksMarkdown?.trim()) {
    errors.push(...validateAutocodeTaskDesignReferences(input.tasksMarkdown, packageMarkdown));
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    depth,
    analysisDirection,
    reviewStatus,
    contractVersion,
    sections,
  };
}

function isChineseOutputLanguage(language: string | undefined): boolean {
  return typeof language === 'string' &&
    language.trim().toLowerCase().replace(/_/g, '-').startsWith('zh');
}

function hasMeaningfulChineseReviewBody(reviewMarkdown: string): boolean {
  const body = reviewMarkdown.replace(/^\s*Status:\s*(?:PASSED|REVISE)\s*/i, '');
  return (body.match(/[\u3400-\u9FFF]/gu) ?? []).length >= 4;
}

export function validateAutocodeTaskDesignReferences(
  tasksMarkdown: string,
  designMarkdown: string,
): string[] {
  const errors: string[] = [];
  const knownIds = new Set(parseAutocodeDesignSections(designMarkdown).map((section) => section.id));
  const referencedSystemIds = new Set<string>();
  const referencedImplementationIds = new Set<string>();
  const referencedPatternIds = new Set<string>();
  const referencedReconstructionIds = new Set<string>();
  const lines = tasksMarkdown.replace(/\r\n/g, '\n').split('\n');

  for (let index = 0; index < lines.length; index++) {
    const item = TASK_ITEM_PATTERN.exec(lines[index]);
    if (!item || (item[1].length === 0 && !/[.-]/.test(item[2]))) {
      continue;
    }
    const taskId = item[2];
    const block: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const nextItem = TASK_ITEM_PATTERN.exec(lines[cursor]);
      if (nextItem && nextItem[1].length <= item[1].length) {
        break;
      }
      block.push(lines[cursor]);
    }
    const designLine = block.find((line) => TASK_DESIGN_FIELD_PATTERN.test(line));
    const refs = designLine ? extractAutocodeDesignIds(designLine) : [];
    if (refs.length === 0) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${taskId} missing _Design: ..._ metadata.`);
      continue;
    }
    if (refs.some((ref) => ref.startsWith('IMP-')) && !refs.some((ref) => ref.startsWith('SYS-'))) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.tasks + ' task ' + taskId +
        ' references implementation work but omits its SYS-* system allocation.',
      );
    }
    for (const ref of refs) {
      if (!knownIds.has(ref)) {
        errors.push(`${AUTOCODE_TASK_ARTIFACTS.tasks} task ${taskId} references unknown design ID ${ref}.`);
      }
      if (ref.startsWith('SYS-')) {
        referencedSystemIds.add(ref);
      }
      if (ref.startsWith('IMP-')) {
        referencedImplementationIds.add(ref);
      }
      if (ref.startsWith('PAT-')) {
        referencedPatternIds.add(ref);
      }
      if (ref.startsWith('REV-')) {
        referencedReconstructionIds.add(ref);
      }
    }
  }

  for (const section of parseAutocodeDesignSections(designMarkdown)) {
    if (section.kind === 'SYS' && !referencedSystemIds.has(section.id)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' system allocation ' + section.id +
        ' is not covered by any executable task.',
      );
    }
    if (section.kind === 'IMP' && !referencedImplementationIds.has(section.id)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} implementation unit ${section.id} is not covered by any executable task.`);
    }
    if (section.kind === 'PAT' && !referencedPatternIds.has(section.id)) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} selected pattern ${section.id} is not covered by any executable task.`);
    }
    if (section.kind === 'REV' && !referencedReconstructionIds.has(section.id)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' source reconstruction ' + section.id +
        ' is not covered by any executable task.',
      );
    }
  }
  return errors;
}

export function parseAutocodeDesignSections(markdown: string): AutocodeDesignSection[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const definitions: Array<{ id: string; kind: AutocodeDesignSection['kind']; title: string; start: number }> = [];
  for (let index = 0; index < lines.length; index++) {
    const match = DESIGN_HEADING_PATTERN.exec(lines[index].trimEnd());
    if (!match) {
      continue;
    }
    const id = match[1].toUpperCase();
    definitions.push({
      id,
      kind: id.slice(0, id.indexOf('-')) as AutocodeDesignSection['kind'],
      title: match[2]?.trim() ?? '',
      start: index,
    });
  }
  return definitions.map((definition, index) => {
    const nextDefinition = definitions[index + 1]?.start ?? lines.length;
    let nextParentSection = lines.length;
    for (let cursor = definition.start + 1; cursor < nextDefinition; cursor++) {
      if (/^##\s+/.test(lines[cursor])) {
        nextParentSection = cursor;
        break;
      }
    }
    const end = Math.min(nextDefinition, nextParentSection);
    return {
      id: definition.id,
      kind: definition.kind,
      title: definition.title,
      markdown: lines.slice(definition.start, end).join('\n').trim(),
      startLine: definition.start + 1,
      endLine: end,
    };
  });
}

export function extractAutocodeDesignReferenceExcerpt(markdown: string, refs: readonly string[]): string {
  const requested = new Set(refs.map((ref) => ref.trim().toUpperCase()).filter(Boolean));
  return parseAutocodeDesignSections(markdown)
    .filter((section) => requested.has(section.id))
    .map((section) => section.markdown)
    .join('\n\n')
    .trim();
}

export function getAutocodeDesignReferenceFingerprint(markdown: string, refs: readonly string[]): string {
  const normalizedRefs = [...new Set(refs.map((ref) => ref.trim().toUpperCase()).filter(Boolean))].sort();
  return hashDesignContent(`${normalizedRefs.join(',')}\n${extractAutocodeDesignReferenceExcerpt(markdown, normalizedRefs)}`);
}

export function getAutocodeDesignDocumentFingerprint(markdown: string): string {
  return hashDesignContent(markdown.replace(/\r\n/g, '\n').trim());
}

export function getAutocodeDesignDepth(markdown: string): AutocodeDesignDepth | undefined {
  const match = /^Design-Depth:\s*(local|standard|complex)\s*$/im.exec(markdown);
  return match?.[1].toLowerCase() as AutocodeDesignDepth | undefined;
}

export function getAutocodeDesignAnalysisDirection(
  markdown: string,
): AutocodeDesignAnalysisDirection | undefined {
  const scope = extractMarkdownSection(markdown, 'Scope And Evidence');
  const value = getMachineReadableField(scope, 'Analysis direction')?.toLowerCase();
  return /^(?:forward-design|reverse-engineering|mixed)$/.test(value ?? '')
    ? value as AutocodeDesignAnalysisDirection
    : undefined;
}

export function getAutocodeDesignReviewStatus(markdown: string): AutocodeDesignReviewStatus | undefined {
  const statuses = [...markdown.matchAll(/^Status:\s*(PASSED|REVISE)\s*$/gim)]
    .map((match) => match[1].toUpperCase() as AutocodeDesignReviewStatus);
  return statuses.length === 1 ? statuses[0] : undefined;
}

export function buildAutocodeDesignQualityRetryPrompt(errors: readonly string[]): string {
  const identityFormatGuidance = errors.some((error) =>
    error.includes('# Design:') ||
    error.includes('stable ') ||
    /must define at least one (?:ADR|RM|DOM|SYS|DES|FLOW|CONTRACT|IMP)-\*/.test(error)
  )
    ? [
        'Use the exact document title and stable-ID syntax below:',
        '```md',
        '# Design: <localized task title>',
        '### ADR-001 <localized decision title>',
        '### RM-001 <localized scenario title>',
        '### DOM-001 <localized concept title>',
        '### SYS-001 <localized boundary title>',
        '### DES-001 <localized element title>',
        '### FLOW-001 <localized flow title>',
        '### IMP-001 <localized implementation title>',
        '```',
        'Every stable ID uses at least three digits. ADR-1 and DES-01 are invalid. Update definitions, fields, and Traceability references consistently.',
      ].join('\n')
    : '';
  const contractGuidance = errors.some((error) => error.includes('Design-Contract'))
    ? 'New designs use Design-Contract: 4 across design.md and all four model files; keep one shared Design-Revision.'
    : '';
  const machineContractGuidance = errors.length > 0
    ? AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT
    : '';
  const depthGuidance = errors.some((error) =>
    error.includes('interactive') ||
    error.includes('high-applicability') ||
    error.includes('God coordinator') ||
    error.includes('pattern candidate') ||
    error.includes('directed path') ||
    error.includes('system allocation') ||
    error.includes('Source Reconstruction')
  )
    ? [
        'Repair model depth rather than adding filler.',
        'For stateful interactive work, separate cohesive rule/state owners, show ordered DES-* collaboration,',
        'inventory real variants, compare applicable patterns with the direct mechanism, and connect each RM-*',
        'through DOM/SYS/DES/FLOW-or-CONTRACT to IMP. Keep selected patterns limited to evidenced variation.',
        'For reverse or mixed work, reconstruct external capability to exact source symbols and record contradiction checks.',
      ].join('\n')
    : '';
  return [
    'The Standard design artifacts failed deterministic validation.',
    'Revise only the invalid design package artifacts. Keep valid evidence and stable IDs unchanged.',
    ...formatAutocodeRetryErrorLines(errors, { maxErrors: 80, maxCharsPerError: 400 }),
    identityFormatGuidance,
    contractGuidance,
    machineContractGuidance,
    depthGuidance,
  ].filter(Boolean).join('\n\n');
}

function findNonCanonicalAutocodeDesignHeadingIds(markdown: string): string[] {
  return [...new Set(
    [...markdown.matchAll(NON_CANONICAL_DESIGN_HEADING_PATTERN)]
      .map((match) => match[1].toUpperCase()),
  )];
}

function findDuplicateAutocodeDesignIds(markdown: string): string[] {
  const counts = new Map<string, number>();
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const match = DESIGN_HEADING_PATTERN.exec(line.trimEnd());
    if (!match) {
      continue;
    }
    const id = match[1].toUpperCase();
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);
}

function validateDesignBudget(
  markdown: string,
  depth: AutocodeDesignDepth | undefined,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const errors: string[] = [];
  const budget = extractMarkdownSection(markdown, 'Design Budget');
  const fields = [
    ['Expected modules changed', /^\s*-\s*Expected modules changed\s*:\s*(\d+)\s*$/im, DESIGN_BUDGET_FORMAT_LINES[0]],
    ['New modules allowed', /^\s*-\s*New modules allowed\s*:\s*(\d+)\s*$/im, DESIGN_BUDGET_FORMAT_LINES[1]],
    ['New public contracts allowed', /^\s*-\s*New public contracts allowed\s*:\s*(\d+)\s*$/im, DESIGN_BUDGET_FORMAT_LINES[2]],
    ['New dependencies allowed', /^\s*-\s*New dependencies allowed\s*:\s*(\d+)\s*$/im, DESIGN_BUDGET_FORMAT_LINES[3]],
    ['New architectural patterns', /^\s*-\s*New architectural patterns\s*:\s*(.+?)\s*$/im, DESIGN_BUDGET_FORMAT_LINES[4]],
  ] as const;
  for (const [name, pattern, expectedLine] of fields) {
    if (!pattern.test(budget)) {
      errors.push(
        `${AUTOCODE_TASK_ARTIFACTS.design} Design Budget must contain "${expectedLine}"; ` +
        `do not write "${name}" as a Markdown heading.`,
      );
    }
  }
  if (depth === 'local') {
    const dependencies = /^\s*-\s*New dependencies allowed\s*:\s*(\d+)\s*$/im.exec(budget);
    const patterns = /^\s*-\s*New architectural patterns\s*:\s*(.+?)\s*$/im.exec(budget);
    if (dependencies && Number(dependencies[1]) > 0) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} local design may not add a dependency without escalating its depth and evidence.`);
    }
    if (patterns && !/^(?:none|0|n\/a)$/i.test(patterns[1].trim())) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} local design must use no new architectural pattern unless complexity evidence justifies a deeper design.`);
    }
  }
  errors.push(...validatePatternBudget(markdown, depth, sections));
  return errors;
}

function validateMachineReadableFields(
  markdown: string,
  location: string,
  fields: readonly string[],
): string[] {
  const errors: string[] = [];
  for (const field of fields) {
    const value = getMachineReadableField(markdown, field);
    if (!value || /^(?:\.{3}|todo|tbd|<[^>]+>)$/i.test(value)) {
      errors.push(location + ' must contain machine field - ' + field + ': <value>.');
    }
  }
  return errors;
}

function validateArchitectureCandidateDecision(
  markdown: string,
  depth: AutocodeDesignDepth | undefined,
): string[] {
  const location = AUTOCODE_TASK_ARTIFACTS.design + ' Architecture Candidates';
  const errors = validateMachineReadableFields(
    markdown,
    location,
    ARCHITECTURE_CANDIDATE_FIELDS,
  );
  const candidateCountValue = getMachineReadableField(markdown, 'Candidate count');
  const candidateCount = candidateCountValue && /^[0-9]+$/.test(candidateCountValue)
    ? Number(candidateCountValue)
    : undefined;
  const candidateLimit = depth === 'complex' ? 3 : depth === 'standard' ? 2 : 1;
  if (candidateCount === undefined || candidateCount < 1 || candidateCount > candidateLimit) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design + ' Candidate count must be from 1 to ' +
      candidateLimit + ' for ' + (depth ?? 'local') + ' depth.',
    );
  }

  const comparisonValue = getMachineReadableField(markdown, 'Candidate comparison') ?? '';
  const comparisonEntries = comparisonValue
    .split(/\s*;\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (candidateCount !== undefined && comparisonEntries.length !== candidateCount) {
    errors.push(
      location + ' Candidate comparison must contain exactly ' + candidateCount +
      ' semicolon-separated candidate entr' + (candidateCount === 1 ? 'y' : 'ies') + '.',
    );
  }
  const candidateNames = new Set<string>();
  for (const [index, entry] of comparisonEntries.entries()) {
    const dimensions = entry.split('|').map((part) => part.trim());
    if (dimensions.length !== 5 || dimensions.some((part) => !isSubstantiveArchitectureText(part, 4))) {
      errors.push(
        location + ' Candidate comparison entry ' + (index + 1) +
        ' must use five substantive pipe-delimited values: candidate | fit | benefits | costs | risks.',
      );
      continue;
    }
    const normalizedName = normalizeArchitectureCandidateName(dimensions[0]);
    if (candidateNames.has(normalizedName)) {
      errors.push(location + ' Candidate comparison must not repeat candidate ' + dimensions[0] + '.');
    }
    candidateNames.add(normalizedName);
  }

  for (const [field, minimumLength] of [
    ['Architecture baseline', 12],
    ['Selected architecture', 4],
    ['Selection rationale', 16],
    ['Rejected alternatives', 16],
    ['Evolution trigger', 12],
  ] as const) {
    const value = getMachineReadableField(markdown, field) ?? '';
    if (!isSubstantiveArchitectureText(value, minimumLength)) {
      errors.push(location + ' ' + field + ' must be concrete and substantive.');
    }
  }
  const rejectedAlternatives = getMachineReadableField(markdown, 'Rejected alternatives') ?? '';
  if (
    isSubstantiveArchitectureText(rejectedAlternatives, 16) &&
    !/(?:because|due to|reject|cost|risk|adds?|violates?|worse|trade-?off|\u56e0\u4e3a|\u7531\u4e8e|\u62d2\u7edd|\u6210\u672c|\u98ce\u9669|\u589e\u52a0|\u8fdd\u53cd|\u53d6\u820d)/i.test(rejectedAlternatives)
  ) {
    errors.push(location + ' Rejected alternatives must state a concrete rejection reason.');
  }
  const evolutionTrigger = getMachineReadableField(markdown, 'Evolution trigger') ?? '';
  if (/^(?:as needed|if required|future needs?|future changes?|none|n\/a|\u6309\u9700|\u672a\u6765\u9700\u8981|\u5f85\u5b9a)\.?$/i.test(evolutionTrigger.trim())) {
    errors.push(location + ' Evolution trigger must name observable future evidence, not a generic placeholder.');
  }
  return errors;
}

function isSubstantiveArchitectureText(value: string, minimumLength: number): boolean {
  const normalized = value
    .replace(/[`*_#<>[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length >= minimumLength &&
    !/^(?:\.{3}|todo|tbd|none|n\/a|best|good|appropriate|current option|same as baseline|\u6700\u4f73|\u5408\u9002|\u5f53\u524d\u65b9\u6848|\u540c\u57fa\u7ebf)$/i.test(normalized);
}

function normalizeArchitectureCandidateName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function getMachineReadableField(markdown: string, field: string): string | undefined {
  const pattern = new RegExp(
    '^\\s*-\\s*' + escapeRegExp(field) + '\\s*:\\s*(.+?)\\s*$',
    'im',
  );
  return pattern.exec(markdown)?.[1].trim();
}

function isExactMachineToken(value: string, tokens: readonly string[]): boolean {
  const normalized = value.trim().toLowerCase();
  return tokens.some((token) => token === normalized);
}

function hasMachineTokenDescription(value: string, tokens: readonly string[]): boolean {
  const match = /^(\S+)\s+-\s+(\S(?:.*\S)?)$/u.exec(value.trim());
  return Boolean(match && tokens.some((token) => token === match[1].toLowerCase()));
}

function hasValidQualityConstraints(value: string): boolean {
  const normalized = value.trim();
  if (/^none\s+-\s+\S/u.test(normalized)) {
    return true;
  }
  const entries = normalized.split(';').map((entry) => entry.trim()).filter(Boolean);
  return entries.length > 0 && entries.every((entry) =>
    /^[A-Za-z][A-Za-z0-9-]*\s*=\s*\S(?:.*\S)?$/u.test(entry)
  );
}

function validateEvidenceBasis(value: string, location: string): string[] {
  const entries = value.split(/\s*;\s*/).filter(Boolean);
  if (
    entries.length === 0 ||
    entries.some((entry) => !/^(?:requirement|observed|inferred|unresolved)\s+-\s+\S/i.test(entry))
  ) {
    return [
      location +
      ' must use one or more tagged evidence entries with a source or rationale.',
    ];
  }
  return [];
}

function validateRequirementContext(section: AutocodeDesignSection): string[] {
  const errors: string[] = [];
  const businessContext = getMachineReadableField(section.markdown, 'Business context') ?? '';
  for (const dimension of ['Who', 'What', 'Why', 'When', 'Where', 'How']) {
    if (!new RegExp('(?:^|;)\\s*' + dimension + '\\s*=\\s*\\S', 'i').test(businessContext)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
        ' Business context must cover ' + dimension + '=...; use n/a with a reason when irrelevant.',
      );
    }
  }

  const qualityConstraints = getMachineReadableField(section.markdown, 'Quality constraints') ?? '';
  if (!hasValidQualityConstraints(qualityConstraints)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
      ' Quality constraints must use ASCII Dimension=value entries separated by semicolons, or none - <reason>.',
    );
  }
  return errors;
}

function getPatternIdsFromField(markdown: string, field: string): string[] {
  const value = getMachineReadableField(markdown, field);
  if (!value || isNoneValue(value)) {
    return [];
  }
  return extractAutocodeDesignIds(value).filter((id) => id.startsWith('PAT-'));
}

function isNoneValue(value: string): boolean {
  return /^(?:none|0|n\/a)$/i.test(value.trim());
}

function haveSameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function validatePatternBudget(
  markdown: string,
  depth: AutocodeDesignDepth | undefined,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const errors: string[] = [];
  const budget = extractMarkdownSection(markdown, 'Design Budget');
  const changeAnalysis = extractMarkdownSection(markdown, 'Change And Pattern Analysis');
  const budgetValue = getMachineReadableField(budget, 'New architectural patterns');
  const selectedValue = getMachineReadableField(changeAnalysis, 'Selected patterns');
  const budgetIds = getPatternIdsFromField(budget, 'New architectural patterns');
  const selectedIds = getPatternIdsFromField(changeAnalysis, 'Selected patterns');
  const definedIds = sections.filter((section) => section.kind === 'PAT').map((section) => section.id);

  if (budgetValue && !isNoneValue(budgetValue) && budgetIds.length === 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' New architectural patterns must be none or list PAT-* IDs.');
  }
  if (selectedValue && !isNoneValue(selectedValue) && selectedIds.length === 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Selected patterns must be none or list PAT-* IDs.');
  }
  if (!haveSameIds(budgetIds, selectedIds) || !haveSameIds(selectedIds, definedIds)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' pattern IDs must match across Design Budget, Selected patterns, and PAT-* sections.');
  }

  const limit = depth === 'complex' ? 3 : depth === 'standard' ? 2 : 0;
  if (definedIds.length > limit) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + (depth ?? 'local') + ' design exceeds its selected-pattern limit of ' + limit + '.');
  }

  return errors;
}

function validateStructuredDesignMethod(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
  _depth: AutocodeDesignDepth | undefined,
): string[] {
  const errors: string[] = [];
  const scope = extractMarkdownSection(markdown, 'Scope And Evidence');
  const complexity = extractMarkdownSection(markdown, 'Complexity Assessment');
  const engineering = extractMarkdownSection(markdown, 'Engineering Adaptation');
  const changeAnalysis = extractMarkdownSection(markdown, 'Change And Pattern Analysis');
  const principles = extractMarkdownSection(markdown, 'Applicable Design Principles');

  errors.push(...validateMachineReadableFields(
    scope,
    AUTOCODE_TASK_ARTIFACTS.design + ' Scope And Evidence',
    SCOPE_AND_EVIDENCE_FIELDS,
  ));
  errors.push(...validateMachineReadableFields(
    complexity,
    AUTOCODE_TASK_ARTIFACTS.design + ' Complexity Assessment',
    COMPLEXITY_ASSESSMENT_FIELDS,
  ));
  errors.push(...validateMachineReadableFields(
    engineering,
    AUTOCODE_TASK_ARTIFACTS.design + ' Engineering Adaptation',
    ENGINEERING_ADAPTATION_FIELDS,
  ));
  errors.push(...validateMachineReadableFields(
    changeAnalysis,
    AUTOCODE_TASK_ARTIFACTS.design + ' Change And Pattern Analysis',
    CHANGE_AND_PATTERN_FIELDS,
  ));
  errors.push(...validateMachineReadableFields(
    principles,
    AUTOCODE_TASK_ARTIFACTS.design + ' Applicable Design Principles',
    APPLICABLE_DESIGN_PRINCIPLE_FIELDS,
  ));

  for (const section of sections) {
    const body = section.markdown.replace(/^#{3,6}\s+[^\n]+\s*/i, '').trim();
    if (body.length < 20 || /^(?:none|n\/a|not applicable|todo|tbd)\.?$/i.test(body)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id + ' must contain a substantive design decision or model entry.');
    }
    const fields = MODEL_SECTION_FIELDS[section.kind];
    if (fields) {
      errors.push(...validateMachineReadableFields(
        section.markdown,
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id,
        fields,
      ));
    }
    const evidenceBasis = getMachineReadableField(section.markdown, 'Evidence basis');
    if (evidenceBasis) {
      errors.push(...validateEvidenceBasis(
        evidenceBasis,
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id + ' Evidence basis',
      ));
    }
  }

  const analysisDirection = getMachineReadableField(scope, 'Analysis direction');
  if (analysisDirection && !/^(?:forward-design|reverse-engineering|mixed)$/i.test(analysisDirection)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Analysis direction must be exactly one unquoted token with no trailing prose: ' +
      'forward-design, reverse-engineering, or mixed.',
    );
  }
  const sourceOfTruth = getMachineReadableField(scope, 'Primary source of truth');
  if (sourceOfTruth && !/^(?:requirement|source|mixed)$/i.test(sourceOfTruth)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Primary source of truth must be exactly one unquoted token with no trailing prose: ' +
      'requirement, source, or mixed.',
    );
  }
  if (/^forward-design$/i.test(analysisDirection ?? '') && /^source$/i.test(sourceOfTruth ?? '')) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' forward-design cannot declare source as its only primary source of truth.',
    );
  }
  if (/^reverse-engineering$/i.test(analysisDirection ?? '') && /^requirement$/i.test(sourceOfTruth ?? '')) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' reverse-engineering cannot declare requirement as its only primary source of truth.',
    );
  }
  if (/^mixed$/i.test(analysisDirection ?? '') && !/^mixed$/i.test(sourceOfTruth ?? '')) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' mixed analysis must declare mixed as its primary source of truth.');
  }

  const paradigm = getMachineReadableField(engineering, 'Project paradigm');
  if (paradigm && !/^(?:object-oriented|functional|data-oriented|procedural|mixed|other)$/i.test(paradigm)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Project paradigm must be exactly one unquoted token with no trailing prose: ' +
      'object-oriented, functional, data-oriented, procedural, mixed, or other.',
    );
  }
  const deliveryContext = getMachineReadableField(engineering, 'Delivery context');
  if (deliveryContext && !/^(?:greenfield|existing-system|new-subsystem|migration)$/i.test(deliveryContext)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Delivery context must be exactly one unquoted token with no trailing prose: ' +
      'greenfield, existing-system, new-subsystem, or migration.',
    );
  }
  const systemShape = getMachineReadableField(engineering, 'System shape');
  if (systemShape && !/^(?:local-utility|stateful-domain|interactive-simulation|data-flow|integration|mixed|other)$/i.test(systemShape)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' System shape must be exactly one unquoted token with no trailing prose: ' +
      'local-utility, stateful-domain, interactive-simulation, data-flow, integration, mixed, or other.',
    );
  }
  const objectApplicability = getMachineReadableField(engineering, 'Object-model applicability');
  if (objectApplicability && !/^(?:high|medium|low)$/i.test(objectApplicability)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Object-model applicability must be exactly one unquoted token with no trailing prose: high, medium, or low.',
    );
  }

  if (!/[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/.test(engineering)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Engineering Adaptation must cite concrete project files or modules.');
  }

  for (const section of sections) {
    if (section.kind === 'ADR') {
      const status = getMachineReadableField(section.markdown, 'Status');
      if (status && !/^(?:proposed|accepted|superseded|rejected)$/i.test(status)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Status must be proposed, accepted, superseded, or rejected.',
        );
      }
    }
    if (section.kind === 'RM') {
      errors.push(...validateRequirementContext(section));
    }
    if (section.kind === 'DOM') {
      const conceptKind = getMachineReadableField(section.markdown, 'Concept kind');
      if (conceptKind && !isExactMachineToken(conceptKind, DOMAIN_CONCEPT_KIND_TOKENS)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Concept kind must be exactly one English token with no trailing prose: ' +
          DOMAIN_CONCEPT_KIND_TOKENS.join(', ') + '.',
        );
      }
      const mapping = getMachineReadableField(section.markdown, 'Software mapping');
      if (mapping && !hasMachineTokenDescription(mapping, SOFTWARE_MAPPING_TOKENS)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Software mapping must use <existing|new|none> - <concrete mapping or reason>.',
        );
      }
    }
    if (section.kind === 'DES') {
      const element = getMachineReadableField(section.markdown, 'Element');
      if (element && !hasMachineTokenDescription(element, DESIGN_ELEMENT_TOKENS)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Element must use <' + DESIGN_ELEMENT_TOKENS.join('|') + '> - <concrete element or symbol>.',
        );
      }
      const role = getMachineReadableField(section.markdown, 'Role stereotype');
      if (role && !isExactMachineToken(role, DESIGN_ROLE_STEREOTYPE_TOKENS)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Role stereotype must be exactly one English token with no trailing prose: ' +
          DESIGN_ROLE_STEREOTYPE_TOKENS.join(', ') + '.',
        );
      }
    }
    if (section.kind === 'IMP') {
      const files = getMachineReadableField(section.markdown, 'Project files and symbols') ?? '';
      if (!/[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/.test(files)) {
        errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id + ' must map to concrete project files and symbols.');
      }
      const mappings = extractAutocodeDesignIds(
        getMachineReadableField(section.markdown, 'Design mapping') ?? '',
      );
      if (!mappings.some((id) => id.startsWith('SYS-')) ||
          !mappings.some((id) => id.startsWith('DES-')) ||
          !mappings.some((id) => id.startsWith('FLOW-') || id.startsWith('CONTRACT-'))) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' Design mapping must reference SYS-*, DES-*, and FLOW-*/CONTRACT-* IDs.',
        );
      }
    }
  }

  return errors;
}

function validateSystemResponsibilityAllocation(
  sections: readonly AutocodeDesignSection[],
): string[] {
  const errors: string[] = [];
  const requirementIds = new Set(
    sections.filter((section) => section.kind === 'RM').map((section) => section.id),
  );
  const systemIds = new Set(
    sections.filter((section) => section.kind === 'SYS').map((section) => section.id),
  );
  const allocatedRequirements = new Set<string>();
  const allocatedSystems = new Set<string>();

  for (const section of sections.filter((candidate) => candidate.kind === 'SYS')) {
    const allocations = extractAutocodeDesignIds(
      getMachineReadableField(section.markdown, 'Allocated requirements') ?? '',
    ).filter((id) => id.startsWith('RM-'));
    if (allocations.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
        ' must allocate at least one RM-* requirement.',
      );
    }
    for (const requirementId of allocations) {
      if (!requirementIds.has(requirementId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' allocates unknown requirement ' + requirementId + '.',
        );
      } else {
        allocatedRequirements.add(requirementId);
      }
    }
  }

  for (const section of sections.filter((candidate) => candidate.kind === 'DES')) {
    const allocations = extractAutocodeDesignIds(
      getMachineReadableField(section.markdown, 'System allocation') ?? '',
    ).filter((id) => id.startsWith('SYS-'));
    if (allocations.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
        ' must map to at least one SYS-* System allocation.',
      );
    }
    for (const systemId of allocations) {
      if (!systemIds.has(systemId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id +
          ' maps to unknown system boundary ' + systemId + '.',
        );
      } else {
        allocatedSystems.add(systemId);
      }
    }
  }

  for (const requirementId of requirementIds) {
    if (!allocatedRequirements.has(requirementId)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' requirement ' + requirementId +
        ' is not allocated to any SYS-* boundary.',
      );
    }
  }
  for (const systemId of systemIds) {
    if (!allocatedSystems.has(systemId)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' system boundary ' + systemId +
        ' has no allocated DES-* implementation responsibility.',
      );
    }
  }
  return errors;
}

function validateStaticDynamicConsistency(
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
): string[] {
  const errors: string[] = [];
  const designIds = new Set(
    sections.filter((section) => section.kind === 'DES').map((section) => section.id),
  );
  const systemIds = new Set(
    sections.filter((section) => section.kind === 'SYS').map((section) => section.id),
  );
  const runtimeCoveredDesignIds = new Set<string>();

  for (const flow of sections.filter((section) => section.kind === 'FLOW')) {
    const participants = extractAutocodeDesignIds(
      getMachineReadableField(flow.markdown, 'Participants') ?? '',
    ).filter((id) => id.startsWith('DES-'));
    const steps = getMachineReadableField(flow.markdown, 'Steps') ?? '';
    for (const participant of participants) {
      runtimeCoveredDesignIds.add(participant);
      if (!new RegExp('\\b' + escapeRegExp(participant) + '\\b', 'i').test(steps)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + flow.id +
          ' Steps must show the runtime action of participant ' + participant + '.',
        );
      }
    }
    if (
      depth !== 'local' &&
      participants.length > 1 &&
      !/(?:->|=>|\b1[.)].*\b2[.)])/i.test(steps)
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + flow.id +
        ' Steps must express an explicit order with arrows or numbered steps.',
      );
    }
  }

  for (const contract of sections.filter((section) => section.kind === 'CONTRACT')) {
    for (const designId of extractAutocodeDesignIds(contract.markdown).filter((id) => id.startsWith('DES-'))) {
      runtimeCoveredDesignIds.add(designId);
    }
  }

  if (depth !== 'local') {
    for (const designId of designIds) {
      if (!runtimeCoveredDesignIds.has(designId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + designId +
          ' must participate in a FLOW-* or CONTRACT-* entry, or be removed from the detailed design.',
        );
      }
    }
  }

  for (const pattern of sections.filter((section) => section.kind === 'PAT')) {
    const participants = extractAutocodeDesignIds(
      getMachineReadableField(pattern.markdown, 'Participants and roles') ?? '',
    ).filter((id) => id.startsWith('SYS-') || id.startsWith('DES-'));
    if (participants.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + pattern.id +
        ' Participants and roles must reference concrete SYS-* or DES-* IDs.',
      );
    }
    for (const participant of participants) {
      if (!systemIds.has(participant) && !designIds.has(participant)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + pattern.id +
          ' references unknown participant ' + participant + '.',
        );
      }
    }
  }
  return errors;
}

function validateSourceReconstruction(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
  direction: AutocodeDesignAnalysisDirection | undefined,
): string[] {
  const errors: string[] = [];
  const reconstructions = sections.filter((section) => section.kind === 'REV');
  if (direction === 'forward-design') {
    if (reconstructions.length > 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design +
        ' forward-design must omit REV-* entries; use mixed only when reconstruction is required.',
      );
    }
    return errors;
  }
  if (direction !== 'reverse-engineering' && direction !== 'mixed') {
    return errors;
  }
  if (!hasMarkdownHeading(markdown, 'Source Reconstruction')) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' missing "## Source Reconstruction" section.');
  }
  if (reconstructions.length === 0) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design + ' ' + direction +
      ' must define at least one REV-* source reconstruction.',
    );
    return errors;
  }

  const knownIds = new Set(sections.map((section) => section.id));
  for (const reconstruction of reconstructions) {
    const external = extractAutocodeDesignIds(
      getMachineReadableField(reconstruction.markdown, 'External capability') ?? '',
    );
    const domain = extractAutocodeDesignIds(
      getMachineReadableField(reconstruction.markdown, 'Domain concepts') ?? '',
    );
    const responsibility = extractAutocodeDesignIds(
      getMachineReadableField(reconstruction.markdown, 'Responsibility path') ?? '',
    );
    const runtime = extractAutocodeDesignIds(
      getMachineReadableField(reconstruction.markdown, 'Runtime path') ?? '',
    );
    if (!external.some((id) => id.startsWith('RM-'))) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id + ' External capability must reference RM-*.');
    }
    if (!domain.some((id) => id.startsWith('DOM-'))) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id + ' Domain concepts must reference DOM-*.');
    }
    if (
      !responsibility.some((id) => id.startsWith('SYS-')) ||
      !responsibility.some((id) => id.startsWith('DES-'))
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
        ' Responsibility path must reference SYS-* and DES-*.',
      );
    }
    if (!runtime.some((id) => id.startsWith('FLOW-') || id.startsWith('CONTRACT-'))) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
        ' Runtime path must reference FLOW-* or CONTRACT-*.',
      );
    }
    for (const id of [...external, ...domain, ...responsibility, ...runtime]) {
      if (!knownIds.has(id)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
          ' references unknown design ID ' + id + '.',
        );
      }
    }

    const sourceSymbols = getMachineReadableField(reconstruction.markdown, 'Source symbols') ?? '';
    if (!/[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()\[\]-]+(?:#|::)[A-Za-z_$][A-Za-z0-9_$.]*/.test(sourceSymbols)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
        ' Source symbols must cite an exact project path and symbol using path#symbol or path::symbol.',
      );
    }
    const contradictionChecks = getMachineReadableField(reconstruction.markdown, 'Contradiction checks') ?? '';
    if (!/^(?:checked|conflict|unresolved)\s+-\s+\S/i.test(contradictionChecks)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
        ' Contradiction checks must start with checked, conflict, or unresolved plus evidence.',
      );
    }
    const confidence = getMachineReadableField(reconstruction.markdown, 'Confidence') ?? '';
    if (!/^(?:high|medium|low)\s+-\s+\S/i.test(confidence)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' ' + reconstruction.id +
        ' Confidence must be high, medium, or low with a rationale.',
      );
    }
  }
  return errors;
}

function validateObjectModelDepth(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
): string[] {
  const errors: string[] = [];
  const engineering = extractMarkdownSection(markdown, 'Engineering Adaptation');
  const changeAnalysis = extractMarkdownSection(markdown, 'Change And Pattern Analysis');
  const delivery = getMachineReadableField(engineering, 'Delivery context')?.toLowerCase();
  const shape = getMachineReadableField(engineering, 'System shape')?.toLowerCase();
  const paradigm = getMachineReadableField(engineering, 'Project paradigm')?.toLowerCase();
  const applicability = getMachineReadableField(engineering, 'Object-model applicability')?.toLowerCase();
  const domainSections = sections.filter((section) => section.kind === 'DOM');
  const designSections = sections.filter((section) => section.kind === 'DES');
  const flowSections = sections.filter((section) => section.kind === 'FLOW');
  const classSections = designSections.filter((section) =>
    /^class\b/i.test(getMachineReadableField(section.markdown, 'Element') ?? ''),
  );
  const objectParadigm = paradigm === 'object-oriented' || paradigm === 'mixed';
  const broadInteractiveModel =
    shape === 'interactive-simulation' &&
    (delivery === 'greenfield' || delivery === 'new-subsystem');

  if (shape === 'interactive-simulation') {
    const variationInventory = getMachineReadableField(changeAnalysis, 'Variation inventory') ?? '';
    if (!variationInventory || isNoneValue(variationInventory)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' interactive-simulation must inventory its state, policy, construction, or interaction variations.');
    }
    if (broadInteractiveModel && depth === 'local') {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' greenfield or new-subsystem interactive-simulation must use standard or complex design depth.');
    }
  }

  if (applicability === 'high' && !objectParadigm) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' high object-model applicability requires object-oriented or mixed project paradigm.');
  }
  if (paradigm === 'object-oriented' && classSections.length === 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' object-oriented design must define at least one DES-* class element.');
  }
  if (applicability === 'high' && depth !== 'local' && classSections.length < 2) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' high-applicability ' + (depth ?? 'standard') + ' design must define at least two collaborating DES-* class elements.');
  }

  if (broadInteractiveModel && depth !== 'local') {
    if (domainSections.length < 3) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' greenfield interactive model must define at least three substantive DOM-* concepts or rule owners.');
    }
    if (designSections.length < 3) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' greenfield interactive model must define at least three cohesive DES-* elements.');
    }
    if (flowSections.length < 2) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' greenfield interactive model must define at least two key FLOW-* collaborations.');
    }
  }

  errors.push(...validatePatternCandidateDepth(changeAnalysis, shape, depth));
  errors.push(...validateFlowParticipants(sections, broadInteractiveModel && depth !== 'local'));
  errors.push(...validateGodObjectResponsibilities(designSections));
  return errors;
}

function validatePatternCandidateDepth(
  changeAnalysis: string,
  shape: string | undefined,
  depth: AutocodeDesignDepth | undefined,
): string[] {
  if (depth === 'local' || (shape !== 'interactive-simulation' && shape !== 'stateful-domain')) {
    return [];
  }
  const value = getMachineReadableField(changeAnalysis, 'Candidate patterns evaluated') ?? '';
  if (!value || isNoneValue(value)) {
    return [AUTOCODE_TASK_ARTIFACTS.design + ' ' + shape + ' must evaluate applicable pattern candidates and record selected/rejected reasons.'];
  }
  const names = new Set(
    (value.match(/\b(?:Strategy|State|Command|Factory|Observer|Adapter|Decorator|Template Method|Mediator|Composite|Bridge|Visitor|Builder|Facade|Object Pool|Pipeline|Entity Component System|ECS|Reducer|State Machine|Reactor|Publish-Subscribe|Event Queue)\b|\u7b56\u7565\u6a21\u5f0f|\u72b6\u6001\u6a21\u5f0f|\u547d\u4ee4\u6a21\u5f0f|\u5de5\u5382\u6a21\u5f0f|\u89c2\u5bdf\u8005\u6a21\u5f0f|\u9002\u914d\u5668\u6a21\u5f0f|\u88c5\u9970\u5668\u6a21\u5f0f/gi) ?? [])
      .map((name) => name.toLowerCase()),
  );
  const minimum = shape === 'interactive-simulation' ? 2 : 1;
  return names.size >= minimum
    ? []
    : [AUTOCODE_TASK_ARTIFACTS.design + ' ' + shape + ' must compare at least ' + minimum + ' applicable named pattern candidate(s), including rejection reasons.'];
}

function validateFlowParticipants(
  sections: readonly AutocodeDesignSection[],
  requireCollaboration: boolean,
): string[] {
  const knownDesignIds = new Set(
    sections.filter((section) => section.kind === 'DES').map((section) => section.id),
  );
  const errors: string[] = [];
  for (const flow of sections.filter((section) => section.kind === 'FLOW')) {
    const participants = extractAutocodeDesignIds(
      getMachineReadableField(flow.markdown, 'Participants') ?? '',
    ).filter((id) => id.startsWith('DES-'));
    for (const participant of participants) {
      if (!knownDesignIds.has(participant)) {
        errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + flow.id + ' references unknown participant ' + participant + '.');
      }
    }
    if (participants.length === 0) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + flow.id + ' must name at least one DES-* participant.');
    } else if (requireCollaboration && participants.length < 2) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + flow.id + ' must show at least two collaborating DES-* participants.');
    }
  }
  return errors;
}

function validateGodObjectResponsibilities(
  designSections: readonly AutocodeDesignSection[],
): string[] {
  const coordinatorPattern = /\b(?:manager|coordinator|orchestrator|controller|application|game)\b|\u7ba1\u7406\u5668|\u534f\u8c03\u5668|\u63a7\u5236\u5668/iu;
  const concernPatterns = [
    /\binput\b|\u8f93\u5165/iu,
    /\b(?:movement|simulation|physics)\b|\u79fb\u52a8|\u6a21\u62df|\u7269\u7406/iu,
    /\bcollision\b|\u78b0\u649e/iu,
    /\b(?:combat|fire|damage)\b|\u6218\u6597|\u5c04\u51fb|\u4f24\u5bb3/iu,
    /\bspawn\b|\u751f\u6210|\u5237\u65b0/iu,
    /\b(?:score|lives?)\b|\u8ba1\u5206|\u751f\u547d/iu,
    /\b(?:render|hud|presentation|ui)\b|\u6e32\u67d3|\u754c\u9762/iu,
    /\b(?:save|persistence)\b|\u5b58\u6863|\u6301\u4e45\u5316/iu,
  ];
  const errors: string[] = [];
  for (const section of designSections) {
    const identity = section.title + ' ' +
      (getMachineReadableField(section.markdown, 'Element') ?? '') + ' ' +
      (getMachineReadableField(section.markdown, 'Role stereotype') ?? '');
    if (!coordinatorPattern.test(identity)) {
      continue;
    }
    const responsibilities = getMachineReadableField(section.markdown, 'Responsibilities') ?? '';
    const concernCount = concernPatterns.filter((pattern) => pattern.test(responsibilities)).length;
    if (concernCount >= 4) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + section.id + ' appears to be a God coordinator spanning ' + concernCount + ' unrelated concern groups; redistribute behavior to cohesive owners.');
    }
  }
  return errors;
}

function validateDesignTraceability(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const traceability = extractMarkdownSection(markdown, 'Traceability');
  const tracedIds = new Set(extractAutocodeDesignIds(traceability));
  const knownIds = new Set(sections.map((section) => section.id));
  const errors = sections
    .filter((section) => !tracedIds.has(section.id))
    .map((section) => AUTOCODE_TASK_ARTIFACTS.design + ' Traceability must include ' + section.id + '.');
  for (const tracedId of tracedIds) {
    if (!knownIds.has(tracedId)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Traceability references unknown design ID ' + tracedId + '.');
    }
  }
  const traceLines = traceability.replace(/\r\n/g, '\n').split('\n');
  for (const requirement of sections.filter((section) => section.kind === 'RM')) {
    const hasConnectedPath = traceLines.some((line) => {
      const ids = extractAutocodeDesignIds(line);
      const requirementIndex = ids.indexOf(requirement.id);
      const domainIndex = ids.findIndex((id) => id.startsWith('DOM-'));
      const systemIndex = ids.findIndex((id) => id.startsWith('SYS-'));
      const designIndex = ids.findIndex((id) => id.startsWith('DES-'));
      const flowIndex = ids.findIndex((id) => id.startsWith('FLOW-') || id.startsWith('CONTRACT-'));
      const implementationIndex = ids.findIndex((id) => id.startsWith('IMP-'));
      return requirementIndex >= 0 &&
        requirementIndex < domainIndex &&
        domainIndex < systemIndex &&
        systemIndex < designIndex &&
        designIndex < flowIndex &&
        flowIndex < implementationIndex &&
        /(?:->|=>|\u2192)/u.test(line);
    });
    if (!hasConnectedPath) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' Traceability must connect ' + requirement.id +
        ' through DOM-*, SYS-*, DES-*, FLOW-*/CONTRACT-*, and IMP-* in that order.',
      );
    }
  }
  return errors;
}

function validateDesignEvidence(markdown: string): string[] {
  const section = extractMarkdownSection(markdown, 'Scope And Evidence');
  const errors: string[] = [];
  const direction = getMachineReadableField(section, 'Analysis direction')?.toLowerCase();
  const requirementEvidence = getMachineReadableField(section, 'Requirement evidence') ?? '';
  const projectEvidence = getMachineReadableField(section, 'Project evidence') ?? '';
  const designInferences = getMachineReadableField(section, 'Design inferences') ?? '';
  const unresolvedEvidence = getMachineReadableField(section, 'Unresolved evidence') ?? '';

  if (!/^(?:requirement|none)\s+-\s+\S/i.test(requirementEvidence)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Requirement evidence must start with the exact English prefix "requirement -" or "none -" and include a source or reason.',
    );
  }
  if (direction === 'forward-design' && !/^requirement\s+-\s+\S/i.test(requirementEvidence)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' forward-design requires concrete requirement evidence.');
  }
  if (
    !/^observed\s+-\s+\S/i.test(projectEvidence) ||
    !/(?:[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()\[\]-]+|https?:\/\/|project docs?|repository)/i
      .test(projectEvidence)
  ) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Project evidence must start with the exact English prefix "observed -" and cite a concrete path, repository document, or verified URL.',
    );
  }
  if (!/^(?:inferred|none)\s+-\s+\S/i.test(designInferences)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Design inferences must start with the exact English prefix "inferred -" or "none -" and include a rationale.',
    );
  }
  if (!/^(?:unresolved\s+-\s+\S|none)$/i.test(unresolvedEvidence)) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.design +
      ' Unresolved evidence must be exactly "none" or start with the exact English prefix "unresolved -" and include the open question.',
    );
  }
  return errors;
}

function validateRejectedComplexity(markdown: string): string[] {
  const section = extractMarkdownSection(markdown, 'Rejected Complexity');
  if (!section || /^(?:##[^\n]+\s*)?(?:none|n\/a|not applicable)\.?\s*$/i.test(section.trim())) {
    return [`${AUTOCODE_TASK_ARTIFACTS.design} Rejected Complexity must name at least one unnecessary alternative and why it was rejected.`];
  }
  return [];
}

function validateLocalDesignComplexity(markdown: string, depth: AutocodeDesignDepth | undefined): string[] {
  if (depth !== 'local') {
    return [];
  }
  const selectedDesign = [
    extractMarkdownSection(markdown, 'Architecture Decision'),
    extractMarkdownSection(markdown, 'Design Model'),
    extractMarkdownSection(markdown, 'Implementation Model'),
  ].join('\n');
  const suspicious = /\b(?:introduce|add|create|new)\b[^.\n]{0,60}\b(?:service layer|repository layer|event bus|plugin system|extension framework|generic framework)\b/i.exec(selectedDesign);
  return suspicious
    ? [`${AUTOCODE_TASK_ARTIFACTS.design} local design appears to add speculative complexity (${suspicious[0]}); use the existing boundary or provide evidence and raise the design depth.`]
    : [];
}

function extractAutocodeDesignIds(value: string): string[] {
  return [...new Set((value.match(DESIGN_ID_PATTERN) ?? []).map((id) => id.toUpperCase()))];
}

function hasMarkdownHeading(markdown: string, heading: string): boolean {
  return new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'im').test(markdown);
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, 'i').test(line.trim()));
  if (start < 0) {
    return '';
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    if (/^##\s+/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

function hashDesignContent(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
