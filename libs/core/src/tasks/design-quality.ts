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
export type AutocodeDesignContractVersion = 5;
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

function selectAutocodeDesignErrorOwnerStage(
  error: string,
): AutocodeDesignPackageStage {
  if (/\bSource Reconstruction\b/i.test(error)) {
    return 'design_model';
  }
  const artifactOwners = [
    [/\brequirement_model\.md\b/i, 'requirement_model'],
    [/\bdomain_model\.md\b/i, 'domain_model'],
    [/\bdesign\.md\b/i, 'design'],
    [/\bdesign_model\.md\b/i, 'design_model'],
    [/\bimplementation_model\.md\b/i, 'implementation_model'],
  ] as const satisfies readonly (readonly [RegExp, AutocodeDesignPackageStage])[];
  const firstArtifactOwner = artifactOwners
    .map(([pattern, stage]) => ({ index: error.search(pattern), stage }))
    .filter(({ index }) => index >= 0)
    .sort((left, right) => left.index - right.index)[0]?.stage;
  if (firstArtifactOwner) {
    return firstArtifactOwner;
  }
  if (/\b(?:RM|FUN|SSD)-[0-9]+\b/i.test(error)) {
    return 'requirement_model';
  }
  if (/\bDOM-[0-9]+\b/i.test(error)) {
    return 'domain_model';
  }
  if (/\b(?:SYS|DES|STATE|FLOW|CONTRACT|PAT|REV)-[0-9]+\b/i.test(error)) {
    return 'design_model';
  }
  if (/\b(?:LANG|IMP)-[0-9]+\b/i.test(error)) {
    return 'implementation_model';
  }
  return 'design';
}

export function selectAutocodeDesignRevisionStages(
  errors: readonly string[],
): AutocodeDesignPackageStage[] {
  const ownerStages = selectAutocodeDesignRevisionOwnerStages(errors);
  const firstStage = AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.find((stage) =>
    ownerStages.includes(stage)
  ) ?? 'design';
  const startIndex = AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.indexOf(
    firstStage as (typeof AUTOCODE_DESIGN_GENERATION_STAGE_ORDER)[number],
  );
  return [...AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.slice(Math.max(0, startIndex))];
}

/**
 * Select only the artifacts that directly own the reported validation errors.
 *
 * This is intentionally narrower than selectAutocodeDesignRevisionStages(),
 * which preserves the legacy "rerun from the earliest owner" behavior. Repair
 * state machines should use this function, then run deterministic validation
 * again and enqueue a downstream owner only when the new validation result
 * proves that its artifact is invalid.
 */
export function selectAutocodeDesignRevisionOwnerStages(
  errors: readonly string[],
): AutocodeDesignPackageStage[] {
  const ownerStages = new Set(errors.map(selectAutocodeDesignErrorOwnerStage));
  return AUTOCODE_DESIGN_GENERATION_STAGE_ORDER.filter((stage) =>
    ownerStages.has(stage)
  );
}

export interface AutocodeDesignSection {
  id: string;
  kind:
    | 'ADR'
    | 'RM'
    | 'FUN'
    | 'SSD'
    | 'DOM'
    | 'SYS'
    | 'DES'
    | 'STATE'
    | 'FLOW'
    | 'CONTRACT'
    | 'PAT'
    | 'REV'
    | 'LANG'
    | 'IMP';
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

const REQUIRED_DESIGN_ROOT_HEADINGS = [
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

const MODEL_FILE_CONTRACTS = [
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.requirementModel,
    title: 'Requirement Model',
    modelKind: 'requirement',
    allowedKinds: ['RM', 'FUN', 'SSD'],
    requiredKinds: ['RM', 'FUN', 'SSD'],
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
    allowedKinds: ['SYS', 'DES', 'STATE', 'FLOW', 'CONTRACT', 'PAT', 'REV'],
    // FLOW is not unconditionally required: the machine contract treats FLOW and CONTRACT as
    // interchangeable dynamic-behavior models. The dedicated "FLOW-* or CONTRACT-*" check
    // (validateV5ModelDocument) enforces that at least one exists, so a valid contract-only
    // design is no longer rejected for lacking FLOW.
    requiredKinds: ['SYS', 'DES'],
  },
  {
    artifact: AUTOCODE_TASK_ARTIFACTS.implementationModel,
    title: 'Implementation Model',
    modelKind: 'implementation',
    allowedKinds: ['LANG', 'IMP'],
    requiredKinds: ['LANG', 'IMP'],
  },
] as const;

const REQUIRED_DESIGN_ID_KINDS = [
  'ADR',
  'RM',
  'FUN',
  'SSD',
  'DOM',
  'SYS',
  'DES',
  // FLOW is intentionally omitted: dynamic behavior may be modeled with FLOW-* or CONTRACT-*.
  // The "FLOW-* or CONTRACT-*" check in validateV5ModelDocument enforces coverage of either.
  'LANG',
  'IMP',
] as const;
const DESIGN_ID_KINDS_PATTERN = 'ADR|RM|FUN|SSD|DOM|SYS|DES|STATE|FLOW|CONTRACT|PAT|REV|LANG|IMP';
const DESIGN_HEADING_PATTERN = new RegExp(
  '^#{3,6}\\s+((?:' + DESIGN_ID_KINDS_PATTERN + ')-\\d{3,})(?:\\s+(.+?))?\\s*$',
  'i',
);
const DESIGN_ID_PATTERN = new RegExp(
  '\\b(?:' + DESIGN_ID_KINDS_PATTERN + ')-\\d{3,}(?![A-Za-z0-9])',
  'gi',
);
const NON_CANONICAL_DESIGN_HEADING_PATTERN = new RegExp(
  '^#{3,6}\\s+((?:' + DESIGN_ID_KINDS_PATTERN + ')-\\d{1,2})(?!\\d)(?:\\s+|$)',
  'gim',
);
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
  'aggregate',
  'domain-service',
  'policy',
  'event',
  'role',
  'resource',
  'technical',
  'other',
] as const;
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
  'Single-responsibility decision',
  'Open-closed decision',
  'Liskov-substitution decision',
  'Interface-segregation decision',
  'Dependency-inversion decision',
  'Cohesion and encapsulation decision',
  'Framework adaptation decision',
  'Underdesign checks',
] as const;

const V5_REQUIREMENT_ANALYSIS_FIELDS = [
  'Input requirements',
  'Industry assumptions',
  'Open requirement questions',
] as const;

const V5_NOUN_ANALYSIS_FIELDS = [
  'Candidate nouns',
  'Excluded nouns',
  'Synonym merges',
] as const;

const V5_DOMAIN_TO_SOFTWARE_MAPPING_FIELDS = [
  'Mapped concepts',
  'Unmapped concepts',
  'Auxiliary elements',
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

const COMMON_MODEL_SECTION_FIELDS: Partial<Record<AutocodeDesignSection['kind'], readonly string[]>> = {
  ADR: [
    'Decision',
    'Status',
    'Decision drivers',
    'Alternatives considered',
    'Trade-offs',
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
};

const MODEL_SECTION_FIELDS: Partial<Record<AutocodeDesignSection['kind'], readonly string[]>> = {
  ADR: COMMON_MODEL_SECTION_FIELDS.ADR,
  RM: [
    'Use case name',
    'Scenario',
    '5W1H analysis',
    'Trigger and preconditions',
    'Use case description',
    'Steps and outputs',
    'Use case value',
    'Alternate and exception flows',
    'Postconditions',
    '8C constraints',
    'Evidence basis',
  ],
  FUN: [
    'Function description',
    'Involved use cases',
    'Merge decision',
    'Evidence basis',
  ],
  SSD: [
    'Use case',
    'Participants',
    'Main and exception messages',
    'Evidence basis',
  ],
  DOM: [
    'Concept kind',
    'Noun sources',
    'Business meaning',
    'Attributes',
    'Identity',
    'Rules and invariants',
    'Lifecycle states',
    'Relationships',
    'Related use cases',
    'Evidence basis',
  ],
  SYS: [
    'Subsystem or boundary',
    'Allocated requirements',
    'Allocated functions',
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
    'Domain mapping',
    'Name mapping',
    'Attribute mapping',
    'Method derivation',
    'Role stereotype',
    'Framework role',
    'Owned state',
    'Public operations',
    'Responsibilities',
    'Collaborators',
    'Dependencies',
    'Encapsulation boundary',
    'Does not own',
    'SOLID rationale',
    'Pattern participation',
    'Evidence basis',
  ],
  STATE: [
    'State owner',
    'States',
    'Initial state',
    'Transitions',
    'Invalid transitions',
    'Exception recovery',
    'Evidence basis',
  ],
  FLOW: COMMON_MODEL_SECTION_FIELDS.FLOW,
  CONTRACT: COMMON_MODEL_SECTION_FIELDS.CONTRACT,
  PAT: COMMON_MODEL_SECTION_FIELDS.PAT,
  REV: COMMON_MODEL_SECTION_FIELDS.REV,
  LANG: [
    'Scope',
    'Language and version',
    'Naming and formatting',
    'Type and interface rules',
    'Class and visibility rules',
    'Error handling',
    'Resource and lifecycle management',
    'Concurrency and state management',
    'Framework integration',
    'Testing and documentation',
    'Evidence basis',
  ],
  IMP: [
    'Project files and symbols',
    'Design mapping',
    'Coding constraints',
    'Class realization',
    'Integration constraints',
    'Verification',
    'Evidence basis',
  ],
};

const AUTOCODE_SSD_MERMAID_SKELETON = [
  'sequenceDiagram',
  '    autonumber',
  '    actor User as <localized actor>',
  '    participant System as <localized product>',
  '    User->>+System: <request>',
  '    System->>System: <coarse internal processing>',
  '    System-->>-User: <observable response>',
].join('\n');

const AUTOCODE_DOMAIN_CLASS_DIAGRAM_SKELETON = [
  'classDiagram',
  '    direction LR',
  '    class DOM_001["<localized label>"] {',
  '        <<concept-kind>>',
  '        attributeName',
  '    }',
  '    DOM_001 "1" --> "*" DOM_002 : <relationship>',
].join('\n');

const AUTOCODE_STATE_DIAGRAM_SKELETON = [
  'stateDiagram-v2',
  '    [*] --> <InitialState>',
  '    <InitialState> --> <NextState>: <transition trigger>',
  '    <NextState> --> [*]',
].join('\n');

export const AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT = [
  'Deterministic machine contract. Keep every field label, list marker, ASCII colon, enum token, ID, and provenance prefix in English exactly as shown. Localize only descriptive prose.',
  'Write localized prose as natural, fluent, idiomatic technical writing in the target language: use complete, well-formed sentences and native terminology, not word-for-word translation of the English field names.',
  'Design package identity:',
  '- First line: # Design: <localized task title>',
  '- Design-Contract: 5',
  '- Design-Depth: local|standard|complex',
  '- Design-Revision: <non-negative integer>',
  '- design.md defines ADR-* only and references requirement_model.md, domain_model.md, design_model.md, and implementation_model.md.',
  '- Every model file declares Design-Contract: 5, the same Design-Revision, Design-Root: design.md, and its exact Model-Kind.',
  '- Each model file first line uses its own title, not # Design:. requirement_model.md starts with # Requirement Model: <localized title>; domain_model.md with # Domain Model: <localized title>; design_model.md with # Design Model: <localized title>; implementation_model.md with # Implementation Model: <localized title>.',
  '- requirement_model.md owns RM/FUN/SSD; domain_model.md owns DOM; design_model.md owns SYS/DES/STATE/FLOW/CONTRACT/PAT/REV; implementation_model.md owns LANG/IMP.',
  '- Stable IDs use at least three digits: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, optional STATE-001, FLOW-001 or CONTRACT-001, optional PAT-001/REV-001, LANG-001, and IMP-001.',
  '- design.md headings: Scope And Evidence; Complexity Assessment; Existing Architecture Fit; Engineering Adaptation; Design Budget; Architecture Candidates; Architecture Decision; Model Package; Change And Pattern Analysis; Applicable Design Principles; Rejected Complexity; Risks And Evolution; Traceability.',
  'Architecture candidate fields in design.md:',
  '- Architecture baseline: <observed current architecture or smallest viable baseline>',
  '- Candidate count: <integer; local=1, standard<=2, complex<=3>',
  '- Candidate comparison: separate candidates with ASCII semicolons and the five values within each candidate with ASCII pipes, even when the prose is localized. Provide exactly Candidate count entries: <candidate | fit | benefits | costs | risks>; repeat compactly.',
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
  '- Put every Scope And Evidence field directly below the ## Scope And Evidence heading as an exact - Field: value bullet. Do not place fields before the heading or rewrite them as prose.',
  '- Analysis direction: forward-design|reverse-engineering|mixed',
  '- Primary source of truth: requirement|source|mixed',
  '- Pair them consistently: forward-design uses requirement or mixed (never source alone); reverse-engineering uses source or mixed (never requirement alone); mixed analysis must use mixed.',
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
  '- observed - must cite durable project sources only (requirements.md, spec.md, source files, project docs, or configs). Never cite design_review.md, planning-transaction.json, or other transient planning or runner artifacts as observed facts; justify a review-driven or lifecycle decision with the underlying requirement or an inferred - rationale instead.',
  'Design Budget uses these exact bullet fields. Keep the English field names, list markers, and ASCII colons; do not use headings for these fields:',
  ...DESIGN_BUDGET_FORMAT_LINES,
  'At local depth, keep New dependencies allowed: 0 and New architectural patterns: none; escalate Design-Depth with complexity evidence before adding either.',
  'Exact model fields and value formats:',
  '- ADR: Decision; Status=proposed|accepted|superseded|rejected; Decision drivers; Alternatives considered; Trade-offs; Evidence basis.',
  '- Requirement Analysis: Input requirements; Industry assumptions=inferred - ...|none - ...; Open requirement questions=unresolved - ...|none.',
  '- RM use case: Use case name; Scenario; 5W1H analysis; Trigger and preconditions; Use case description; Steps and outputs; Use case value=Why=<localized customer value>; Alternate and exception flows; Postconditions; 8C constraints; Evidence basis.',
  '- Scenario and 5W1H analysis must separate dimensions with ASCII semicolons and ASCII equals signs even when the prose is localized. Scenario: Who=...; Where=...; When=.... 5W1H analysis: Who=...; What=...; Why=...; When=...; Where=...; How=....',
  '- Steps and outputs: numbered actions starting at 1. and separated by ASCII semicolons, each with an ASCII => or -> output marker, e.g. 1. <action> => <output>; 2. <action> => <output>.',
  '- 8C constraints must contain exactly these dimensions with ASCII equals signs and semicolons: Performance, Cost, Time, Reliability, Security, Compliance, Technology, Compatibility. Use n/a - <reason> as a dimension value only when justified.',
  '- FUN: Function description; Involved use cases=RM-*; Merge decision=merged|distinct - <reason>; Evidence basis. Merge equivalent capabilities across use cases into one FUN-*.',
  '- SSD: Use case=one RM-*; Participants; Main and exception messages; Evidence basis; one Mermaid sequenceDiagram with autonumber. Declare actor first, System second, and verified externals after; show a request, System activation and self-processing, and a dashed response. Expose no product internals.',
  'Exact SSD sequenceDiagram shape (keep the ASCII arrows and +/- activation markers; localize only prose):\n```mermaid\n' + AUTOCODE_SSD_MERMAID_SKELETON + '\n```',
  '- requirement_model.md headings: Requirement Analysis; Use Case List; Functional List; System Sequence Diagrams.',
  '- Noun Analysis: Candidate nouns; Excluded nouns; Synonym merges.',
  '- DOM Concept kind: ' + DOMAIN_CONCEPT_KIND_TOKENS.join('|'),
  '- DOM: Noun sources; Business meaning; Attributes (list each as name: type; constraint covering nullability and range, unit, or enum); Identity; Rules and invariants; Lifecycle states; Relationships; Related use cases=RM-*; Evidence basis. Domain classes define no software methods or file mapping.',
  '- domain_model.md headings: Noun Analysis; Domain Model; Domain Class Diagram. Use Mermaid classDiagram with labeled DOM_* boxes, <<Concept kind>>, attributes, and no methods. Start the classDiagram body with direction LR, and connect every DOM_* box to at least one other concept with a relationship. Association, aggregation, and composition show quoted multiplicity at both ends; generalization may omit it.',
  'Exact Domain Class Diagram shape (localize only prose; keep direction LR and quoted multiplicities):\n```mermaid\n' + AUTOCODE_DOMAIN_CLASS_DIAGRAM_SKELETON + '\n```',
  '- SYS: Subsystem or boundary; Allocated requirements=RM-*; Allocated functions=FUN-*; Owns; Provides; Requires; Data and control boundary; Failure ownership; Evidence basis.',
  '- Element: ' + DESIGN_ELEMENT_TOKENS.join('|') + ' - <localized concrete element or symbol>',
  '- Role stereotype: ' + DESIGN_ROLE_STEREOTYPE_TOKENS.join('|'),
  '- Domain To Software Mapping: Mapped concepts; Unmapped concepts; Auxiliary elements.',
  '- DES: System allocation=SYS-*; Domain mapping=DOM-* or none - <auxiliary reason>; Name mapping; Attribute mapping (map each as domainAttr -> visibility name: type; constraint covering nullability and range, unit, or enum); Method derivation=RM-*/FUN-*/SSD-* verbs; Framework role; Owned state; Public operations (write each as name(param: type, ...): returnType with a one-line precondition and postcondition and the observable outcome a test can assert); Responsibilities (state the invariants this element always upholds, the errors or edge cases it owns, and any Security, Reliability, or Performance 8C constraint it realizes); Collaborators; Dependencies; Encapsulation boundary; Does not own; SOLID rationale; Pattern participation; Evidence basis.',
  '- DES SOLID rationale must contain exactly these dimensions with ASCII equals signs and semicolons: SRP=...; OCP=...; LSP=...; ISP=...; DIP=.... Use n/a - <reason> as a dimension value when justified. Use ASCII semicolons to separate the dimensions even when the prose is localized.',
  '- STATE: State owner=DES-*; States; Initial state; Transitions; Invalid transitions; Exception recovery; Evidence basis; one Mermaid stateDiagram-v2 block. If no DES owns mutable state, define no STATE-* and instead write "none - <reason>" under the State Transition Diagrams heading.',
  'Exact STATE stateDiagram-v2 shape (localize only prose; begin and end at [*]):\n```mermaid\n' + AUTOCODE_STATE_DIAGRAM_SKELETON + '\n```',
  '- FLOW: Trigger; Participants; Steps; State changes; Failure paths; Evidence basis; one Mermaid sequenceDiagram block. Steps name every DES participant in explicit order.',
  '- design_model.md headings: System Responsibility Allocation; Domain To Software Mapping; Design Model; Class Diagram; State Transition Diagrams; Sequence Diagrams.',
  '- For reverse-engineering or mixed analysis, design_model.md must also contain exactly ## Source Reconstruction and at least one REV-* entry beneath it. For forward-design, omit the heading and all REV-* entries.',
  '- CONTRACT: Inputs and outputs (typed signatures with nullability and value constraints); Compatibility; Errors (each error condition and how a caller detects and handles it); Lifecycle; Evidence basis.',
  '- Change analysis: Verified variation points; Variation inventory; Candidate patterns evaluated (for each verified variation, name the applicable GoF or architectural pattern and compare it against the direct mechanism); Simplest change mechanism; Selected patterns=PAT-* IDs or none.',
  '- Pattern application balances NOP: when a variation is real and evidenced, apply the fitting pattern instead of a growing switch/if-else over types or states; when no variation is verified, keep the direct mechanism and record none.',
  '- PAT (define one per Selected pattern; Design Budget New architectural patterns must list the same PAT-* IDs): Verified variation; Evidence; Expected horizon; Stable boundary; Encapsulated variation; Participants and roles; Application scope; Simpler alternative; Benefit; Cost and failure modes.',
  '- REV when applicable: External capability; Domain concepts; Responsibility path; Runtime path; Source symbols; Contradiction checks=checked|conflict|unresolved - <evidence>; Confidence=high|medium|low - <rationale>.',
  '- LANG: Scope; Language and version=<observed language and a concrete version number>; Naming and formatting; Type and interface rules; Class and visibility rules; Error handling; Resource and lifecycle management; Concurrency and state management; Framework integration; Testing and documentation; Evidence basis.',
  '- IMP: Project files and symbols=<path/to/file#symbol>; Design mapping=SYS-*, DES-*, FLOW-*/CONTRACT-* (add STATE-* when the DES owns state); Coding constraints=LANG-*; Class realization=DES-* -> <file#symbol>; Integration constraints; Verification (name focused tests that assert each owned invariant, every RM alternate and exception flow this element realizes, and any Security, Reliability, or Performance 8C constraint it must meet); Evidence basis.',
  '- implementation_model.md headings: Language And Coding Constraints; Implementation Model.',
  '- Applicable Design Principles: Single-responsibility decision; Open-closed decision; Liskov-substitution decision; Interface-segregation decision; Dependency-inversion decision; Cohesion and encapsulation decision; Framework adaptation decision; Underdesign checks.',
  'Allocation and traceability invariants:',
  '- Every RM has at least one FUN and one SSD. Every SSD follows actor-left/System-right numbered black-box presentation with activation, System self-processing, and an observable response. Every FUN names all involved RM use cases and equivalent functions are merged.',
  '- Every RM and FUN is allocated by SYS. Every SYS has at least one DES implementation responsibility.',
  '- Every DOM is mapped to DES or explicitly documented as domain-only. Every DES maps to SYS and participates in FLOW or CONTRACT at Standard/Complex depth.',
  '- Every stateful DES has a STATE diagram. Every FLOW has a sequence diagram. Every IMP maps SYS, DES, STATE when applicable, and FLOW or CONTRACT, and references LANG.',
  '- Every RM Alternate and exception flow is realized by a FLOW Failure paths entry or a CONTRACT Errors entry and asserted by an IMP Verification test, so edge and error behavior is designed and tested, not just the happy path.',
  '- Traceability includes every ADR-*, and for each RM-* one single line connecting it with -> arrows in this exact left-to-right order: RM-* -> FUN-* -> SSD-* -> DOM-* -> ADR-* -> SYS-* -> DES-* -> STATE-*/FLOW-*/CONTRACT-* -> LANG-* -> IMP-*.',
  'Cross-model consistency and self-check (single source of truth):',
  '- Each fact has exactly one owner model. Downstream models reference upstream stable IDs and never restate, re-derive, or redefine an upstream fact in conflicting words or values.',
  '- Never fork a contradictory value: when an upstream fact is missing, ambiguous, or conflicts with another model, record it once as unresolved - <conflicting IDs and the contradiction> instead of silently choosing a divergent value.',
  '- Before finalizing this stage, self-check that every referenced upstream ID exists and that no two entries assert contradictory values for the same concept, constant, or state; reconcile the entries in place or mark them unresolved.',
].join('\n');

export const AUTOCODE_STANDARD_DESIGN_METHOD_PROMPT = `
You are the software designer for a staged Standard-mode design package. Write only the artifact named by
the current stage. Never collapse model bodies back into design.md and never edit source code or tasks.

Generate the package in this dependency order:
1. requirement_model.md derives complete RM-* use cases with 5W1H8C, deduplicated FUN-* capabilities, and
   one SSD-* system sequence diagram per use case.
2. domain_model.md applies find nouns, add attributes, and connect relationships to derive DOM-* business
   concepts and a method-free domain class diagram.
3. design.md compares bounded architecture candidates and records ADR-* decisions, budget, and package index.
4. design_model.md maps selected DOM-* concepts to software DES-* elements, applies SOLID and justified
   patterns, allocates RM/FUN through SYS, and defines class, STATE, FLOW sequence, CONTRACT, PAT, and REV models.
5. implementation_model.md defines evidence-backed LANG-* coding constraints and maps the approved design to
   exact project classes/elements, files, symbols, integration order, and tests through IMP-*.

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

For forward design, derive connected models in order: complete 5W1H use cases, all exact 8C constraints,
deduplicated functions, system sequence diagrams, domain nouns/attributes/relations, system requirement and
function allocation, detailed static and dynamic design, then language-constrained implementation mapping.
For reverse engineering, work outside-in: external
capability and guarantees, domain concepts, subsystem responsibilities/interfaces, runtime collaborations,
then exact packages/classes/functions and contradiction checks. Do not read a large codebase linearly from
an entry point and call that architecture analysis.

Analyze 5W1H (Who, Where, When, What, Why, How) and the eight required constraints (Performance, Cost, Time,
Reliability, Security, Compliance, Technology, Compatibility). Build use cases with actions, outputs, value,
exceptions, and postconditions; merge equivalent capabilities into FUN-*; visualize each use case with SSD-*.
Format each SSD like a conventional actor-to-system interaction timeline: autonumber the messages, place the
primary business actor first and System second, show the System activation interval, use coarse System self-
messages for processing responsibilities, and return observable outcomes with dashed messages. Keep product
internals behind the single System boundary.
Discover domain concepts by finding nouns, excluding implementation/incidental terms, adding domain attributes,
and connecting relationships. Domain diagrams use labeled concept boxes, kind stereotypes, attributes, and
two-ended multiplicities for associations; they contain no software methods. In detailed design, map domain
names and attributes selectively, derive operations from use-case verbs, and assign decisions to their
information/invariant owner. Use
CRC-style responsibility/collaborator reasoning, keep behavior with invariant owners, and make coordinators
coordinate rather than absorb domain behavior. Allocate every RM-* and FUN-* to a SYS-* boundary before
detailed DES-* elements. Define what each subsystem owns, provides, requires, and how it contains failures. Model
ordered collaboration, state changes, failures, contracts, ownership/lifetime, timing/concurrency where
relevant, and exact file/symbol/test integration.

Start with exactly "# Design: <localized task title>". Use stable headings with zero-padded IDs such as
ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, optional STATE-001,
FLOW-001/CONTRACT-001, optional PAT-001, optional REV-001, LANG-001, and IMP-001. Every stable ID uses at
least three digits; ADR-1 and DES-01 are invalid. New packages use Design-Contract: 5. REV-* is required only
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

Apply SRP, OCP, LSP, ISP, and DIP explicitly to class/element boundaries; record a concrete decision or a
justified n/a for each. SOLID and named patterns are tools, not goals. Do not add an interface, service, layer, repository, event
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
check complete 5W1H and exact 8C coverage, use-case actions/outputs/value/exceptions, FUN deduplication, SSD
coverage and actor-left/System-right numbered black-box presentation with activation, self-processing, and
dashed observable responses, domain noun filtering/attributes/relationships, method-free domain diagrams, selective domain-to-
software mapping, all five SOLID decisions, system RM/FUN allocation, class/state/sequence diagram consistency,
language coding constraints, responsibility assignment from scenario verbs, and collaboration/state/failure
behavior. For reverse engineering, verify the outside-in chain from
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
  const declarations = [...(markdown ?? '').matchAll(/^Design-Contract:\s*(\S.*?)\s*$/gim)]
    .map((match) => match[1]?.trim());
  return declarations.length === 1 && declarations[0] === '5' ? 5 : undefined;
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

interface AutocodeModelFileContract {
  artifact: string;
  title: string;
  modelKind: string;
  allowedKinds: readonly string[];
  requiredKinds: readonly string[];
}

function getModelDocuments(
  input: AutocodeDesignPackageMarkdown,
) {
  const contracts: readonly AutocodeModelFileContract[] = MODEL_FILE_CONTRACTS;
  return [
    { contract: contracts[0], markdown: input.requirementModelMarkdown },
    { contract: contracts[1], markdown: input.domainModelMarkdown },
    { contract: contracts[2], markdown: input.designModelMarkdown },
    { contract: contracts[3], markdown: input.implementationModelMarkdown },
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
  }
  return errors;
}

function validateModelDocumentPackageIdentity(
  markdown: string,
  contract: AutocodeModelFileContract,
  expectedRevision?: string,
): string[] {
  const errors: string[] = [];
  if (markdown.length === 0) {
    errors.push(contract.artifact + ' is empty.');
  }
  const identityLines = markdown.split(String.fromCharCode(10)).map((line) => line.trim());
  if (getAutocodeDesignContractVersion(markdown) !== 5) {
    errors.push(contract.artifact + ' must declare Design-Contract: 5.');
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
  return errors;
}

function validateModelDocumentIdentity(
  markdown: string,
  contract: AutocodeModelFileContract,
  expectedRevision?: string,
): string[] {
  const errors = validateModelDocumentPackageIdentity(markdown, contract, expectedRevision);
  const expectedTitle = '# ' + contract.title + ':';
  if (!markdown.startsWith(expectedTitle)) {
    errors.push(contract.artifact + ' must start with ' + expectedTitle + ' followed by a localized title.');
  }
  if (
    contract.artifact !== AUTOCODE_TASK_ARTIFACTS.requirementModel &&
    !hasMarkdownHeading(markdown, contract.title)
  ) {
    errors.push(contract.artifact + ' is missing its level-two ' + contract.title + ' section.');
  }
  return errors;
}

export function validateAutocodeDesignPackageIdentity(
  input: AutocodeDesignPackageMarkdown,
): string[] {
  const designMarkdown = input.designMarkdown?.trim() ?? '';
  if (!designMarkdown) {
    return [AUTOCODE_TASK_ARTIFACTS.design + ' is missing.'];
  }
  if (getAutocodeDesignContractVersion(designMarkdown) !== 5) {
    return [
      AUTOCODE_TASK_ARTIFACTS.design +
      ' must declare exactly one Design-Contract: 5 line; older or additional contract versions are unsupported.',
    ];
  }

  const revisionLine = designMarkdown
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  const errors: string[] = [];
  if (!revision || !Number.isInteger(Number(revision)) || Number(revision) < 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare a numeric Design-Revision.');
  }

  for (const document of getModelDocuments(input)) {
    const markdown = document.markdown?.trim() ?? '';
    if (!markdown) {
      errors.push(document.contract.artifact + ' is missing from the Design-Contract: 5 package.');
      continue;
    }
    errors.push(...validateModelDocumentPackageIdentity(markdown, document.contract, revision));
  }
  return errors;
}

function validateModelDocument(
  markdownValue: string | null | undefined,
  contract: AutocodeModelFileContract,
  expectedRevision?: string,
): string[] {
  const markdown = markdownValue?.trim() ?? '';
  if (!markdown) {
    return [contract.artifact + ' is missing from the Design-Contract: 5 package.'];
  }
  const errors = validateModelDocumentIdentity(markdown, contract, expectedRevision);
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
  errors.push(...validateV5ModelArtifact(markdown, contract.artifact, sections));
  return errors;
}

function validateV5ModelDocument(
  markdownValue: string | null | undefined,
  contract: AutocodeModelFileContract,
  expectedRevision?: string,
): string[] {
  return validateModelDocument(markdownValue, contract, expectedRevision);
}

function validateV5ModelArtifact(
  markdown: string,
  artifact: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  if (artifact === AUTOCODE_TASK_ARTIFACTS.requirementModel) {
    return validateV5RequirementModel(markdown, sections);
  }
  if (artifact === AUTOCODE_TASK_ARTIFACTS.domainModel) {
    return validateV5DomainModel(markdown, sections);
  }
  if (artifact === AUTOCODE_TASK_ARTIFACTS.designModel) {
    return validateV5DetailedDesignModel(markdown, sections);
  }
  if (artifact === AUTOCODE_TASK_ARTIFACTS.implementationModel) {
    return validateV5ImplementationModel(markdown, sections);
  }
  return [];
}

function validateRequiredHeadings(
  markdown: string,
  artifact: string,
  headings: readonly string[],
): string[] {
  return headings
    .filter((heading) => !hasMarkdownHeading(markdown, heading))
    .map((heading) => artifact + ' is missing level-two section ' + heading + '.');
}

function extractMermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/gi)]
    .map((match) => match[1].trim());
}

function hasMermaidDiagram(markdown: string, diagramType: string): boolean {
  const pattern = new RegExp('^\\s*' + escapeRegExp(diagramType) + '\\b', 'im');
  return extractMermaidBlocks(markdown).some((block) => pattern.test(block));
}

function validateV5SystemSequencePresentation(section: AutocodeDesignSection): string[] {
  const location = AUTOCODE_TASK_ARTIFACTS.requirementModel + ' ' + section.id;
  const diagram = extractMermaidBlocks(section.markdown)
    .find((block) => /^\s*sequenceDiagram\b/im.test(block));
  if (!diagram) {
    return [];
  }

  const errors: string[] = [];
  if (!/^\s*autonumber\s*$/im.test(diagram)) {
    errors.push(location + ' SSD must enable Mermaid autonumber so business messages are displayed in order.');
  }

  const declarations = [...diagram.matchAll(
    /^\s*(actor|participant)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+as\s+.+)?$/gim,
  )].map((match) => ({
    kind: match[1].toLowerCase(),
    alias: match[2],
  }));
  const primaryActor = declarations[0];
  const system = declarations[1];
  if (primaryActor?.kind !== 'actor') {
    errors.push(location + ' SSD must declare the primary business actor first so it appears on the left.');
  }
  if (system?.kind !== 'participant' || system.alias.toLowerCase() !== 'system') {
    errors.push(location + ' SSD must declare the product second with the stable alias System.');
  }

  if (primaryActor?.kind === 'actor' && system?.alias.toLowerCase() === 'system') {
    const actorAlias = escapeRegExp(primaryActor.alias);
    const request = new RegExp(
      '^\\s*' + actorAlias + '\\s*->>\\+?\\s*System\\s*:',
      'im',
    );
    const response = new RegExp(
      '^\\s*System\\s*-->>-?\\s*' + actorAlias + '\\s*:',
      'im',
    );
    if (!request.test(diagram)) {
      errors.push(location + ' SSD must show at least one primary actor-to-System request message.');
    }
    if (!response.test(diagram)) {
      errors.push(location + ' SSD must show at least one dashed System-to-primary-actor observable response.');
    }
  }

  if (!/^\s*System\s*->>\+?\s*System\s*:/im.test(diagram)) {
    errors.push(location + ' SSD must show at least one coarse System-to-System processing responsibility.');
  }
  const activatesSystem =
    /^\s*activate\s+System\s*$/im.test(diagram) ||
    /->>\+\s*System\s*:/im.test(diagram);
  const deactivatesSystem =
    /^\s*deactivate\s+System\s*$/im.test(diagram) ||
    /^\s*System\s*-->>-\s*[A-Za-z_][A-Za-z0-9_]*\s*:/im.test(diagram);
  if (!activatesSystem || !deactivatesSystem) {
    errors.push(location + ' SSD must show a complete System activation and deactivation interval.');
  }
  return errors;
}

function validateV5DomainClassDiagramPresentation(
  diagram: string,
  concepts: readonly AutocodeDesignSection[],
): string[] {
  const artifact = AUTOCODE_TASK_ARTIFACTS.domainModel;
  const block = extractMermaidBlocks(diagram)
    .find((candidate) => /^\s*classDiagram\b/im.test(candidate));
  if (!block) {
    return [];
  }

  const errors: string[] = [];
  if (!/^\s*direction\s+LR\s*$/im.test(block)) {
    errors.push(artifact + ' Domain Class Diagram must use direction LR for a readable relationship layout.');
  }

  const knownAliases = new Map(
    concepts.map((concept) => [concept.id.replaceAll('-', '_').toUpperCase(), concept.id]),
  );
  const connectedAliases = new Set<string>();
  for (const concept of concepts) {
    const alias = concept.id.replaceAll('-', '_');
    const classMatch = new RegExp(
      '(?:^|\\n)\\s*class\\s+' + escapeRegExp(alias) +
      '(\\s*\\[\\s*"[^"\\n]+"\\s*\\])?\\s*\\{([\\s\\S]*?)\\}',
      'i',
    ).exec(block);
    const location = artifact + ' Domain Class Diagram ' + concept.id;
    if (!classMatch) {
      errors.push(location + ' must define one labeled class box with attributes.');
      continue;
    }
    if (!classMatch[1]) {
      errors.push(location + ' must use a localized visible label on its DOM_* alias.');
    }

    const body = classMatch[2] ?? '';
    const conceptKind = (getMachineReadableField(concept.markdown, 'Concept kind') ?? '')
      .trim()
      .toLowerCase();
    if (
      conceptKind &&
      !new RegExp(
        '^\\s*<<\\s*' + escapeRegExp(conceptKind) + '\\s*>>\\s*$',
        'im',
      ).test(body)
    ) {
      errors.push(location + ' must show the <<' + conceptKind + '>> concept-kind stereotype.');
    }

    const attributes = getMachineReadableField(concept.markdown, 'Attributes') ?? '';
    const bodyAttributes = body
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !/^<<[^>]+>>$/u.test(line));
    if (!/^none\s+-\s+\S/iu.test(attributes) && bodyAttributes.length === 0) {
      errors.push(location + ' must show its defined domain attributes inside the class box.');
    }
  }

  for (const line of block.split(/\r?\n/u)) {
    const aliases = [...line.matchAll(/\bDOM_[0-9]+\b/giu)]
      .map((match) => match[0].toUpperCase());
    if (aliases.length < 2 || !/(?:--|\.\.)/u.test(line)) {
      continue;
    }
    for (const alias of aliases) {
      if (!knownAliases.has(alias)) {
        errors.push(
          artifact + ' Domain Class Diagram relationship references unknown concept ' +
          alias.replace('_', '-') + '.',
        );
      } else {
        connectedAliases.add(alias);
      }
    }
    const isGeneralizationOrDependency = /(?:<\|--|--\|>|\.\.>|\.\.\|>)/u.test(line);
    if (!isGeneralizationOrDependency) {
      const multiplicities = [...line.matchAll(/"([^"\n]+)"/gu)];
      if (multiplicities.length < 2) {
        errors.push(
          artifact +
          ' Domain Class Diagram association, aggregation, or composition must show quoted multiplicity at both ends.',
        );
      }
    }
  }

  if (concepts.length > 1) {
    for (const [alias, id] of knownAliases) {
      if (!connectedAliases.has(alias)) {
        errors.push(artifact + ' Domain Class Diagram ' + id + ' must participate in a domain relationship.');
      }
    }
  }
  return errors;
}

function diagramReferencesStableId(markdown: string, id: string): boolean {
  const aliases = [id, id.replaceAll('-', '_')];
  return aliases.some((alias) => new RegExp('\\b' + escapeRegExp(alias) + '\\b', 'i').test(markdown));
}

function validateDimensionAssignments(
  value: string,
  dimensions: readonly string[],
  location: string,
): string[] {
  const errors: string[] = [];
  const allowedDimensions = new Set(dimensions.map((dimension) => dimension.toLowerCase()));
  const unexpectedDimensions = new Set<string>();
  for (const match of value.matchAll(/(?:^|;)\s*([A-Za-z][A-Za-z0-9 _-]*?)\s*=/g)) {
    const dimension = match[1]?.trim() ?? '';
    if (dimension && !allowedDimensions.has(dimension.toLowerCase())) {
      unexpectedDimensions.add(dimension);
    }
  }
  for (const dimension of unexpectedDimensions) {
    errors.push(
      location + ' must not define ' + dimension + '=...; allowed dimensions are ' +
      dimensions.join(', ') + '.',
    );
  }
  for (const dimension of dimensions) {
    const matches = value.match(new RegExp(
      '(?:^|;)\\s*' + escapeRegExp(dimension) + '\\s*=\\s*\\S[^;]*',
      'gi',
    )) ?? [];
    if (matches.length !== 1) {
      errors.push(location + ' must define exactly one ' + dimension + '=... assignment.');
    }
  }
  return errors;
}

function validateV5UseCaseSection(section: AutocodeDesignSection): string[] {
  const location = AUTOCODE_TASK_ARTIFACTS.requirementModel + ' ' + section.id;
  const errors: string[] = [];
  const scenario = getMachineReadableField(section.markdown, 'Scenario') ?? '';
  errors.push(...validateDimensionAssignments(scenario, ['Who', 'Where', 'When'], location + ' Scenario'));
  const analysis = getMachineReadableField(section.markdown, '5W1H analysis') ?? '';
  errors.push(...validateDimensionAssignments(
    analysis,
    ['Who', 'What', 'Why', 'When', 'Where', 'How'],
    location + ' 5W1H analysis',
  ));
  const constraints = getMachineReadableField(section.markdown, '8C constraints') ?? '';
  errors.push(...validateDimensionAssignments(
    constraints,
    ['Performance', 'Cost', 'Time', 'Reliability', 'Security', 'Compliance', 'Technology', 'Compatibility'],
    location + ' 8C constraints',
  ));
  const steps = getMachineReadableField(section.markdown, 'Steps and outputs') ?? '';
  if (!/(?:^|;)\s*1[.)]\s+\S/u.test(steps) || !/(?:=>|->|→)/u.test(steps)) {
    errors.push(location + ' Steps and outputs must contain ordered actions and explicit output markers.');
  }
  const value = getMachineReadableField(section.markdown, 'Use case value') ?? '';
  if (!/^Why\s*=\s*\S/iu.test(value)) {
    errors.push(location + ' Use case value must use Why=<customer value>.');
  }
  return errors;
}

function normalizeCapabilityText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function validateV5RequirementModel(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const artifact = AUTOCODE_TASK_ARTIFACTS.requirementModel;
  const errors = validateRequiredHeadings(markdown, artifact, [
    'Requirement Analysis',
    'Use Case List',
    'Functional List',
    'System Sequence Diagrams',
  ]);
  errors.push(...validateMachineReadableFields(
    extractMarkdownSection(markdown, 'Requirement Analysis'),
    artifact + ' Requirement Analysis',
    V5_REQUIREMENT_ANALYSIS_FIELDS,
  ));
  const useCases = sections.filter((section) => section.kind === 'RM');
  const functions = sections.filter((section) => section.kind === 'FUN');
  const sequences = sections.filter((section) => section.kind === 'SSD');
  const useCaseIds = new Set(useCases.map((section) => section.id));
  const coveredUseCases = new Set<string>();
  const capabilityKeys = new Map<string, string>();

  for (const useCase of useCases) {
    errors.push(...validateV5UseCaseSection(useCase));
  }
  for (const feature of functions) {
    const location = artifact + ' ' + feature.id;
    const involved = extractAutocodeDesignIds(
      getMachineReadableField(feature.markdown, 'Involved use cases') ?? '',
    ).filter((id) => id.startsWith('RM-'));
    if (involved.length === 0) {
      errors.push(location + ' must involve at least one RM-* use case.');
    }
    for (const useCaseId of involved) {
      if (!useCaseIds.has(useCaseId)) {
        errors.push(location + ' references unknown use case ' + useCaseId + '.');
      } else {
        coveredUseCases.add(useCaseId);
      }
    }
    const mergeDecision = getMachineReadableField(feature.markdown, 'Merge decision') ?? '';
    const mergeMatch = /^(merged|distinct)\s+-\s+\S/iu.exec(mergeDecision);
    if (!mergeMatch) {
      errors.push(location + ' Merge decision must use merged - <reason> or distinct - <reason>.');
    } else if (involved.length > 1 && mergeMatch[1].toLowerCase() !== 'merged') {
      errors.push(location + ' shared by multiple use cases must use a merged decision.');
    } else if (involved.length === 1 && mergeMatch[1].toLowerCase() !== 'distinct') {
      errors.push(location + ' used by one use case must explain why it is a distinct function.');
    }
    for (const value of [
      feature.title,
      getMachineReadableField(feature.markdown, 'Function description') ?? '',
    ]) {
      const key = normalizeCapabilityText(value);
      if (key.length < 4) {
        continue;
      }
      const existing = capabilityKeys.get(key);
      if (existing && existing !== feature.id) {
        errors.push(artifact + ' functions ' + existing + ' and ' + feature.id +
          ' duplicate the same normalized capability; merge them.');
      } else {
        capabilityKeys.set(key, feature.id);
      }
    }
  }
  for (const useCaseId of useCaseIds) {
    if (!coveredUseCases.has(useCaseId)) {
      errors.push(artifact + ' use case ' + useCaseId + ' is not covered by any FUN-* function.');
    }
  }

  const sequenceCountByUseCase = new Map<string, number>();
  for (const sequence of sequences) {
    const location = artifact + ' ' + sequence.id;
    const refs = extractAutocodeDesignIds(
      getMachineReadableField(sequence.markdown, 'Use case') ?? '',
    ).filter((id) => id.startsWith('RM-'));
    if (refs.length !== 1 || !useCaseIds.has(refs[0])) {
      errors.push(location + ' Use case must reference exactly one known RM-*.');
    } else {
      sequenceCountByUseCase.set(refs[0], (sequenceCountByUseCase.get(refs[0]) ?? 0) + 1);
    }
    if (!hasMermaidDiagram(sequence.markdown, 'sequenceDiagram')) {
      errors.push(location + ' must contain a Mermaid sequenceDiagram.');
    } else {
      errors.push(...validateV5SystemSequencePresentation(sequence));
    }
  }
  for (const useCaseId of useCaseIds) {
    if ((sequenceCountByUseCase.get(useCaseId) ?? 0) !== 1) {
      errors.push(artifact + ' use case ' + useCaseId + ' must have exactly one SSD-* system sequence diagram.');
    }
  }
  return errors;
}

function validateV5DomainModel(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const artifact = AUTOCODE_TASK_ARTIFACTS.domainModel;
  const errors = validateRequiredHeadings(markdown, artifact, [
    'Noun Analysis',
    'Domain Model',
    'Domain Class Diagram',
  ]);
  errors.push(...validateMachineReadableFields(
    extractMarkdownSection(markdown, 'Noun Analysis'),
    artifact + ' Noun Analysis',
    V5_NOUN_ANALYSIS_FIELDS,
  ));
  const diagram = extractMarkdownSection(markdown, 'Domain Class Diagram');
  if (!hasMermaidDiagram(diagram, 'classDiagram')) {
    errors.push(artifact + ' Domain Class Diagram must contain a Mermaid classDiagram.');
  } else {
    errors.push(...validateV5DomainClassDiagramPresentation(
      diagram,
      sections.filter((section) => section.kind === 'DOM'),
    ));
  }
  for (const concept of sections.filter((section) => section.kind === 'DOM')) {
    const nounSources = extractAutocodeDesignIds(
      getMachineReadableField(concept.markdown, 'Noun sources') ?? '',
    ).filter((id) => id.startsWith('RM-') || id.startsWith('FUN-') || id.startsWith('SSD-'));
    if (nounSources.length === 0) {
      errors.push(artifact + ' ' + concept.id + ' Noun sources must reference RM, FUN, or SSD evidence.');
    }
  }
  for (const block of extractMermaidBlocks(diagram)) {
    if (/(?:^|\n)\s*(?:[+#~-]\s*)?[A-Za-z_$][\w$]*\s*\([^\n)]*\)/u.test(block)) {
      errors.push(artifact + ' Domain Class Diagram must not define software methods.');
    }
    if (/(?:^|\n)\s*[+#~-]\s*[^\n(){}]+(?:\n|$)/u.test(block)) {
      errors.push(artifact + ' Domain Class Diagram must not define software access modifiers.');
    }
  }
  return errors;
}

function validateSolidRationale(value: string, location: string): string[] {
  return validateDimensionAssignments(value, ['SRP', 'OCP', 'LSP', 'ISP', 'DIP'], location);
}

function validateV5DetailedDesignModel(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const artifact = AUTOCODE_TASK_ARTIFACTS.designModel;
  const errors = validateRequiredHeadings(markdown, artifact, [
    'System Responsibility Allocation',
    'Domain To Software Mapping',
    'Design Model',
    'Class Diagram',
    'State Transition Diagrams',
    'Sequence Diagrams',
  ]);
  errors.push(...validateMachineReadableFields(
    extractMarkdownSection(markdown, 'Domain To Software Mapping'),
    artifact + ' Domain To Software Mapping',
    V5_DOMAIN_TO_SOFTWARE_MAPPING_FIELDS,
  ));
  const designElements = sections.filter((section) => section.kind === 'DES');
  const classDiagram = extractMarkdownSection(markdown, 'Class Diagram');
  if (!hasMermaidDiagram(classDiagram, 'classDiagram')) {
    errors.push(artifact + ' Class Diagram must contain a Mermaid classDiagram.');
  }
  for (const element of designElements) {
    const solid = getMachineReadableField(element.markdown, 'SOLID rationale') ?? '';
    errors.push(...validateSolidRationale(solid, artifact + ' ' + element.id + ' SOLID rationale'));
    if (
      /^class\s+-/iu.test(getMachineReadableField(element.markdown, 'Element') ?? '') &&
      !diagramReferencesStableId(classDiagram, element.id)
    ) {
      errors.push(artifact + ' Class Diagram must include software class ' + element.id + '.');
    }
  }

  const stateSections = sections.filter((section) => section.kind === 'STATE');
  const statefulElements = designElements.filter((element) => {
    const state = getMachineReadableField(element.markdown, 'Owned state') ?? '';
    return state.length > 0 && !/^(?:none|n\/a)\s+-/iu.test(state);
  });
  const stateOwners = new Set<string>();
  for (const state of stateSections) {
    const owners = extractAutocodeDesignIds(
      getMachineReadableField(state.markdown, 'State owner') ?? '',
    ).filter((id) => id.startsWith('DES-'));
    if (owners.length !== 1) {
      errors.push(artifact + ' ' + state.id + ' State owner must reference exactly one DES-*.');
    } else {
      stateOwners.add(owners[0]);
    }
    if (!hasMermaidDiagram(state.markdown, 'stateDiagram-v2')) {
      errors.push(artifact + ' ' + state.id + ' must contain a Mermaid stateDiagram-v2.');
    }
  }
  for (const element of statefulElements) {
    if (!stateOwners.has(element.id)) {
      errors.push(artifact + ' stateful element ' + element.id + ' must own a STATE-* diagram.');
    }
  }
  if (
    statefulElements.length === 0 &&
    !/none\s+-\s+\S/iu.test(extractMarkdownSection(markdown, 'State Transition Diagrams'))
  ) {
    errors.push(artifact + ' stateless design must record none - <reason> under State Transition Diagrams.');
  }
  for (const flow of sections.filter((section) => section.kind === 'FLOW')) {
    if (!hasMermaidDiagram(flow.markdown, 'sequenceDiagram')) {
      errors.push(artifact + ' ' + flow.id + ' must contain a Mermaid sequenceDiagram.');
    }
  }
  return errors;
}

function validateV5ImplementationModel(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
): string[] {
  const artifact = AUTOCODE_TASK_ARTIFACTS.implementationModel;
  const errors = validateRequiredHeadings(markdown, artifact, [
    'Language And Coding Constraints',
    'Implementation Model',
  ]);
  const languages = sections.filter((section) => section.kind === 'LANG');
  const languageIds = new Set(languages.map((section) => section.id));
  const referencedLanguages = new Set<string>();
  for (const language of languages) {
    const version = getMachineReadableField(language.markdown, 'Language and version') ?? '';
    if (!/\d/u.test(version) || /^(?:language|runtime|current|project default)\b/iu.test(version)) {
      errors.push(artifact + ' ' + language.id + ' must cite an observed language/toolchain version.');
    }
  }
  for (const implementation of sections.filter((section) => section.kind === 'IMP')) {
    const location = artifact + ' ' + implementation.id;
    const constraints = extractAutocodeDesignIds(
      getMachineReadableField(implementation.markdown, 'Coding constraints') ?? '',
    ).filter((id) => id.startsWith('LANG-'));
    if (constraints.length === 0) {
      errors.push(location + ' Coding constraints must reference at least one LANG-*.');
    }
    for (const id of constraints) {
      if (!languageIds.has(id)) {
        errors.push(location + ' references unknown coding constraint ' + id + '.');
      } else {
        referencedLanguages.add(id);
      }
    }
    const realization = extractAutocodeDesignIds(
      getMachineReadableField(implementation.markdown, 'Class realization') ?? '',
    ).filter((id) => id.startsWith('DES-'));
    if (realization.length === 0) {
      errors.push(location + ' Class realization must reference at least one DES-*.');
    }
  }
  for (const languageId of languageIds) {
    if (!referencedLanguages.has(languageId)) {
      errors.push(artifact + ' coding constraint ' + languageId + ' is not applied by any IMP-*.');
    }
  }
  return errors;
}

function validateDesignRoot(
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
  if (getAutocodeDesignContractVersion(designMarkdown) !== 5) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare Design-Contract: 5.');
  }
  if (!getAutocodeDesignDepth(designMarkdown)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare Design-Depth: local, standard, or complex.');
  }
  const revisionLine = identityLines.find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  if (!revision || !Number.isInteger(Number(revision)) || Number(revision) < 0) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' must declare a numeric Design-Revision.');
  }
  for (const heading of REQUIRED_DESIGN_ROOT_HEADINGS) {
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

function validateV5DesignRoot(
  designMarkdownValue: string | null | undefined,
): string[] {
  return validateDesignRoot(designMarkdownValue);
}

function validateV5DesignPackage(
  input: ValidateAutocodeStandardDesignArtifactsInput,
  combinedMarkdown: string,
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
  analysisDirection: AutocodeDesignAnalysisDirection | undefined,
): string[] {
  const errors = validateV5DesignRoot(input.designMarkdown);
  const revisionLine = (input.designMarkdown ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  for (const document of getModelDocuments(input)) {
    errors.push(...validateV5ModelDocument(document.markdown, document.contract, revision));
  }
  for (const kind of REQUIRED_DESIGN_ID_KINDS) {
    if (!sections.some((section) => section.kind === kind)) {
      errors.push('Design-Contract: 5 package must define at least one ' + kind + '-* section.');
    }
  }
  for (const duplicateId of findDuplicateAutocodeDesignIds(combinedMarkdown)) {
    errors.push('Design package defines ' + duplicateId + ' more than once.');
  }
  errors.push(...validateDesignBudget(combinedMarkdown, depth, sections));
  errors.push(...validateStructuredDesignMethod(combinedMarkdown, sections, depth));
  errors.push(...validateSystemResponsibilityAllocation(sections));
  errors.push(...validateV5CrossArtifactMappings(combinedMarkdown, sections));
  errors.push(...validateObjectModelDepth(combinedMarkdown, sections, depth));
  errors.push(...validateStaticDynamicConsistency(sections, depth));
  errors.push(...validateSourceReconstruction(
    input.designModelMarkdown ?? '',
    sections,
    analysisDirection,
  ));
  errors.push(...validateDesignTraceability(combinedMarkdown, sections));
  errors.push(...validateDesignEvidence(combinedMarkdown));
  errors.push(...validateRejectedComplexity(combinedMarkdown));
  errors.push(...validateLocalDesignComplexity(combinedMarkdown, depth));
  return errors;
}

function validateV5DesignRootQuality(
  input: ValidateAutocodeStandardDesignArtifactsInput,
  combinedMarkdown: string,
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
  requirePatternDefinitions: boolean,
): string[] {
  return [
    ...validateV5DesignRoot(input.designMarkdown),
    ...validateDesignBudget(
      combinedMarkdown,
      depth,
      sections,
      requirePatternDefinitions,
    ),
    ...validateStructuredDesignMethod(combinedMarkdown, sections, depth),
    ...validateDesignEvidence(combinedMarkdown),
    ...validateRejectedComplexity(combinedMarkdown),
    ...validateLocalDesignComplexity(combinedMarkdown, depth),
  ];
}

function validateV5DesignModelStage(
  input: ValidateAutocodeStandardDesignArtifactsInput,
  combinedMarkdown: string,
  sections: readonly AutocodeDesignSection[],
  depth: AutocodeDesignDepth | undefined,
  analysisDirection: AutocodeDesignAnalysisDirection | undefined,
): string[] {
  const errors = validateV5DesignRootQuality(
    input,
    combinedMarkdown,
    sections,
    depth,
    true,
  );
  for (const kind of REQUIRED_DESIGN_ID_KINDS.filter(
    (candidate) => candidate !== 'LANG' && candidate !== 'IMP',
  )) {
    if (!sections.some((section) => section.kind === kind)) {
      errors.push('Design-Contract: 5 package must define at least one ' + kind + '-* section.');
    }
  }
  for (const duplicateId of findDuplicateAutocodeDesignIds(combinedMarkdown)) {
    errors.push('Design package defines ' + duplicateId + ' more than once.');
  }
  errors.push(...validateSystemResponsibilityAllocation(sections));
  errors.push(...validateV5CrossArtifactMappings(combinedMarkdown, sections, false));
  errors.push(...validateObjectModelDepth(combinedMarkdown, sections, depth));
  errors.push(...validateStaticDynamicConsistency(sections, depth));
  errors.push(...validateSourceReconstruction(
    input.designModelMarkdown ?? '',
    sections,
    analysisDirection,
  ));
  errors.push(...validateDesignTraceability(combinedMarkdown, sections, false));
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
  const documents = getModelDocuments(input);
  const validateDocument = validateV5ModelDocument;
  const revisionLine = (input.designMarkdown ?? '')
    .split(String.fromCharCode(10))
    .map((line) => line.trim())
    .find((line) => line.startsWith('Design-Revision:'));
  const revision = revisionLine?.slice('Design-Revision:'.length).trim();
  const expectedRevision = stage === 'design' || stage === 'design_model'
    ? revision
    : undefined;
  errors.push(...validateDocument(
    documents[0].markdown,
    documents[0].contract,
    expectedRevision,
  ));
  if (stage !== 'requirement_model') {
    errors.push(...validateDocument(
      documents[1].markdown,
      documents[1].contract,
      expectedRevision,
    ));
  }
  if (stage === 'design_model') {
    errors.push(...validateDocument(documents[2].markdown, documents[2].contract, revision));
  }
  const availableInput: ValidateAutocodeStandardDesignArtifactsInput = {
    requirementModelMarkdown: input.requirementModelMarkdown,
    domainModelMarkdown: stage === 'requirement_model'
      ? undefined
      : input.domainModelMarkdown,
    designMarkdown: stage === 'design' || stage === 'design_model'
      ? input.designMarkdown
      : undefined,
    designModelMarkdown: stage === 'design_model'
      ? input.designModelMarkdown
      : undefined,
  };
  const packageMarkdown = buildAutocodeDesignPackageMarkdown(availableInput);
  const sections = parseAutocodeDesignSections(packageMarkdown);
  const depth = getAutocodeDesignDepth(input.designMarkdown ?? '');
  const analysisDirection = getAutocodeDesignAnalysisDirection(input.designMarkdown ?? '');
  if (stage === 'design') {
    errors.push(...validateV5DesignRootQuality(
      input,
      packageMarkdown,
      sections,
      depth,
      false,
    ));
  } else if (stage === 'design_model') {
    errors.push(...validateV5DesignModelStage(
      input,
      packageMarkdown,
      sections,
      depth,
      analysisDirection,
    ));
  }
  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
    warnings: [],
    depth,
    analysisDirection,
    reviewStatus: getAutocodeDesignReviewStatus(input.designReviewMarkdown ?? ''),
    contractVersion: 5,
    sections,
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
  const packageMarkdown = buildAutocodeDesignPackageMarkdown(input);
  const sections = parseAutocodeDesignSections(packageMarkdown);
  const depth = getAutocodeDesignDepth(designMarkdown);
  const analysisDirection = getAutocodeDesignAnalysisDirection(designMarkdown);
  const reviewStatus = getAutocodeDesignReviewStatus(reviewMarkdown);

  if (!designMarkdown) {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} is missing.`);
  } else if (contractVersion === 5) {
    errors.push(...validateV5DesignPackage(
      input,
      packageMarkdown,
      sections,
      depth,
      analysisDirection,
    ));
  } else {
    errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} must declare Design-Contract: 5; older design contracts are unsupported.`);
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

  const uniqueErrors = [...new Set(errors)];
  return {
    valid: uniqueErrors.length === 0,
    errors: uniqueErrors,
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
  const referencedFunctionIds = new Set<string>();
  const referencedStateIds = new Set<string>();
  const referencedLanguageIds = new Set<string>();
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
      if (nextItem) {
        // Stop at the next task item of any depth. A task's own metadata bullets
        // (_Design:_, _Requirements:_, ...) are not task items and always precede
        // its first child task, so restricting the block to the task body prevents
        // a parent task from borrowing a nested child task's _Design:_ references
        // and masking a missing-metadata error. Child tasks contribute their own
        // references through their own iteration, so coverage is unaffected.
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
    if (
      refs.some((ref) => ref.startsWith('IMP-')) &&
      !refs.some((ref) => ref.startsWith('FUN-'))
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.tasks + ' task ' + taskId +
        ' references implementation work but omits its FUN-* capability.',
      );
    }
    if (
      refs.some((ref) => ref.startsWith('IMP-')) &&
      !refs.some((ref) => ref.startsWith('LANG-'))
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.tasks + ' task ' + taskId +
        ' references implementation work but omits its LANG-* coding constraints.',
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
      if (ref.startsWith('FUN-')) {
        referencedFunctionIds.add(ref);
      }
      if (ref.startsWith('STATE-')) {
        referencedStateIds.add(ref);
      }
      if (ref.startsWith('LANG-')) {
        referencedLanguageIds.add(ref);
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
    if (
      section.kind === 'FUN' &&
      !referencedFunctionIds.has(section.id)
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' function ' + section.id +
        ' is not covered by any executable task.',
      );
    }
    if (
      section.kind === 'STATE' &&
      !referencedStateIds.has(section.id)
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' state model ' + section.id +
        ' is not covered by any executable task.',
      );
    }
    if (
      section.kind === 'LANG' &&
      !referencedLanguageIds.has(section.id)
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' language constraint ' + section.id +
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

export interface AutocodeDesignReviewDecisionOption {
  /** Stable option letter within a question, e.g. `A`, `B`, `C`. */
  id: string;
  /** The concrete decision text presented to the user. */
  label: string;
  /** True for the single option the review recommends as the default choice. */
  recommended: boolean;
}

export interface AutocodeDesignReviewOpenQuestion {
  /** Stable question id, e.g. `HQ-001`. */
  id: string;
  /** The short open-question prompt the user must decide. */
  question: string;
  /** Selectable decision options; exactly one is normally flagged recommended. */
  options: AutocodeDesignReviewDecisionOption[];
}

export interface AutocodeDesignReviewHumanInputGate {
  /** True when the REVISE review is blocked on open questions only a human can resolve. */
  blocked: boolean;
  /** The distinct unresolved open questions extracted from review evidence fields. */
  questions: string[];
  /**
   * Structured decision prompts parsed from the review's optional
   * `## Human Decision Options` section. Empty for older reviews, in which case callers
   * can fall back to the plain `questions` list.
   */
  decisions: AutocodeDesignReviewOpenQuestion[];
  /** A ready-to-surface message describing what the user must provide. */
  message: string;
}

const AUTOCODE_DESIGN_REVIEW_DECISION_OPTIONS_HEADING = 'Human Decision Options';

/**
 * Parses the optional `## Human Decision Options` section an independent design review
 * appends when it stops on unresolved open questions. Each `### HQ-<n> <question>` block
 * carries `- Option <id> (recommended)?: <label>` bullets that the desktop UI renders as a
 * single-choice prompt. Returns an empty list when the section is absent or malformed.
 */
function parseAutocodeDesignReviewDecisionOptions(
  markdown: string,
): AutocodeDesignReviewOpenQuestion[] {
  const section = extractMarkdownSection(markdown, AUTOCODE_DESIGN_REVIEW_DECISION_OPTIONS_HEADING);
  if (!section) {
    return [];
  }
  const decisions: AutocodeDesignReviewOpenQuestion[] = [];
  const questionPattern = /^###\s+(HQ-\d{1,4})\s+(.+?)\s*$/gim;
  const matches = [...section.matchAll(questionPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const id = match[1].toUpperCase();
    const question = (match[2] ?? '').trim();
    const blockStart = (match.index ?? 0) + match[0].length;
    const blockEnd = index + 1 < matches.length ? (matches[index + 1].index ?? section.length) : section.length;
    const block = section.slice(blockStart, blockEnd);
    const options: AutocodeDesignReviewDecisionOption[] = [];
    const seen = new Set<string>();
    const optionPattern = /^\s*-\s*Option\s+([A-Za-z0-9]+)\s*(\(recommended\))?\s*[:：]\s*(.+?)\s*$/gim;
    for (const optionMatch of block.matchAll(optionPattern)) {
      const optionId = optionMatch[1].toUpperCase();
      const label = (optionMatch[3] ?? '').trim();
      if (!label || seen.has(optionId)) {
        continue;
      }
      seen.add(optionId);
      options.push({ id: optionId, label, recommended: Boolean(optionMatch[2]) });
    }
    if (!question || options.length === 0) {
      continue;
    }
    // Guarantee a single default: honour the review's flag, else recommend the first option.
    if (!options.some((option) => option.recommended)) {
      options[0].recommended = true;
    } else {
      let seenRecommended = false;
      for (const option of options) {
        if (option.recommended && seenRecommended) {
          option.recommended = false;
        } else if (option.recommended) {
          seenRecommended = true;
        }
      }
    }
    decisions.push({ id, question, options });
  }
  return decisions;
}

function extractAutocodeDesignReviewUnresolvedQuestions(markdown: string): string[] {
  const questions: string[] = [];
  const seen = new Set<string>();
  for (const line of markdown.split(/\r?\n/)) {
    const evidenceMatch = line.match(
      /^\s*-\s*Evidence(?:\s+basis)?\s*[:：]\s*(.*)$/i,
    );
    const directMatch = line.match(/^\s*-\s*(unresolved\s*-\s*.*)$/i);
    const payload = evidenceMatch?.[1] ?? directMatch?.[1];
    if (payload === undefined) {
      continue;
    }
    // A provenance clause must begin the evidence payload or follow a clause separator.
    // This excludes negated prose and an `unresolved -` phrase quoted inside an observed
    // claim, both of which describe the review rather than request a user decision.
    const pattern = /(?:^|[;\uFF1B])\s*unresolved\s*-\s*([^\r\n;\uFF1B]+)/giu;
    for (const match of payload.matchAll(pattern)) {
      const text = (match[1] ?? '').trim();
      if (!text || /^(?:none|n\/a)\b/i.test(text)) {
        continue;
      }
      const key = text.toLowerCase();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      questions.push(text);
    }
  }
  return questions;
}

/**
 * Detects whether an independent design review returned Status: REVISE because it is
 * blocked on provenance-level `unresolved - ...` evidence that requires a human decision.
 * Raw substring matches are deliberately excluded because the token can appear in negated
 * prose or inside an observed claim about an automatically repairable design ambiguity.
 */
export function detectAutocodeDesignReviewHumanInputGate(
  designReviewMarkdown: string | undefined | null,
): AutocodeDesignReviewHumanInputGate {
  const empty: AutocodeDesignReviewHumanInputGate = {
    blocked: false,
    questions: [],
    decisions: [],
    message: '',
  };
  if (!designReviewMarkdown) {
    return empty;
  }
  if (getAutocodeDesignReviewStatus(designReviewMarkdown) !== 'REVISE') {
    return empty;
  }
  const questions = extractAutocodeDesignReviewUnresolvedQuestions(designReviewMarkdown);
  if (questions.length === 0) {
    return empty;
  }
  const decisions = parseAutocodeDesignReviewDecisionOptions(designReviewMarkdown);
  const message =
    'Independent design review is blocked on unresolved open questions that require a human decision. ' +
    'Resolve these in requirements.md/spec.md, then re-run planning: ' +
    questions.map((question, index) => `(${index + 1}) ${question}`).join(' ');
  return { blocked: true, questions, decisions, message };
}

/** Machine token requirements.md uses to flag an open question that blocks implementation. */
export const AUTOCODE_REQUIREMENTS_BLOCKING_TOKEN = '[BLOCKS-IMPLEMENTATION]';

export interface AutocodeRequirementsBlockingGate {
  /** True when requirements.md has open questions tagged as implementation-blocking. */
  blocked: boolean;
  /** The distinct blocking open questions (token stripped, Q-id preserved). */
  questions: string[];
  /** A ready-to-surface message describing what the user must decide. */
  message: string;
}

/**
 * Detects whether requirements.md still carries open questions the requirements author
 * tagged as hard implementation/testability gates (with `[BLOCKS-IMPLEMENTATION]`). This
 * lets standard planning stop for a human decision right after requirements, before it
 * spends stages building five design models on an unresolvable foundation. A question is
 * treated as resolved once its token is replaced (e.g. with `[RESOLVED]`) during write-back.
 */
export function detectAutocodeRequirementsBlockingGate(
  requirementsMarkdown: string | undefined | null,
): AutocodeRequirementsBlockingGate {
  const empty: AutocodeRequirementsBlockingGate = { blocked: false, questions: [], message: '' };
  if (!requirementsMarkdown) {
    return empty;
  }
  const questions: string[] = [];
  const seen = new Set<string>();
  const tokenPattern = /\[BLOCKS-IMPLEMENTATION\]/g;
  for (const rawLine of requirementsMarkdown.split(/\r?\n/)) {
    if (!rawLine.includes(AUTOCODE_REQUIREMENTS_BLOCKING_TOKEN)) {
      continue;
    }
    // Only bullet lines (open-question entries) carry the token; keep the Q-id so the
    // desktop write-back can locate and resolve the exact line.
    const match = /^\s*-\s*(.+)$/.exec(rawLine);
    if (!match) {
      continue;
    }
    const text = match[1].replace(tokenPattern, ' ').replace(/\s+/g, ' ').trim();
    if (!text) {
      continue;
    }
    const key = text.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    questions.push(text);
  }
  if (questions.length === 0) {
    return empty;
  }
  const message =
    'Planning paused before design modeling: requirements.md has open questions that block ' +
    'implementation and need a human decision. Resolve these in requirements.md, then re-run planning: ' +
    questions.map((question, index) => `(${index + 1}) ${question}`).join(' ');
  return { blocked: true, questions, message };
}

export function buildAutocodeDesignQualityRetryPrompt(errors: readonly string[]): string {
  const identityFormatGuidance = errors.some((error) =>
    error.includes('# Design:') ||
    error.includes('stable ') ||
    /must define at least one (?:ADR|RM|FUN|SSD|DOM|SYS|DES|STATE|FLOW|CONTRACT|LANG|IMP)-\*/.test(error)
  )
    ? [
        'Use the exact document title and stable-ID syntax below:',
        '```md',
        '# Design: <localized task title>',
        '### ADR-001 <localized decision title>',
        '### RM-001 <localized use-case title>',
        '### FUN-001 <localized function title>',
        '### SSD-001 <localized system-sequence title>',
        '### DOM-001 <localized concept title>',
        '### SYS-001 <localized boundary title>',
        '### DES-001 <localized element title>',
        '### STATE-001 <localized state title>',
        '### FLOW-001 <localized flow title>',
        '### LANG-001 <localized language/toolchain title>',
        '### IMP-001 <localized implementation title>',
        '```',
        'Every stable ID uses at least three digits. ADR-1 and DES-01 are invalid. Update definitions, fields, and Traceability references consistently.',
      ].join('\n')
    : '';
  const contractGuidance = errors.some((error) => error.includes('Design-Contract'))
    ? 'Use Design-Contract: 5 across design.md and all four model files with one shared Design-Revision. Reject every other design contract version.'
    : '';
  const machineContractGuidance = errors.length > 0
    ? AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT
    : '';
  const sourceReconstructionGuidance = errors.some((error) =>
    error.includes('Source Reconstruction')
  )
    ? [
        'Source Reconstruction is owned by design_model.md, never design.md.',
        'For reverse-engineering or mixed analysis, add exactly ## Source Reconstruction to design_model.md and define the required REV-* entries beneath it.',
        'For forward-design, omit both the heading and REV-* entries. Preserve design.md ADRs, evidence, and stable IDs.',
      ].join('\n')
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
        'through FUN/SSD/DOM/ADR/SYS/DES/STATE-or-FLOW/LANG to IMP. Keep selected patterns limited to evidenced variation.',
        'For reverse or mixed work, reconstruct external capability to exact source symbols and record contradiction checks.',
      ].join('\n')
    : '';
  const diagramGuidance = errors.some((error) =>
    error.includes('SSD must') ||
    error.includes('Class Diagram') ||
    error.includes('stateDiagram-v2') ||
    error.includes('State Transition Diagrams')
  )
    ? [
        'Copy these Mermaid shapes exactly; keep the ASCII arrows, autonumber, activation markers, and direction:',
        'SSD sequenceDiagram (requirement_model.md): declare the actor first and System second, and keep the +/- activation markers.',
        '```mermaid',
        AUTOCODE_SSD_MERMAID_SKELETON,
        '```',
        'Domain classDiagram (domain_model.md): start with direction LR, label every DOM_* box, and connect each box with quoted multiplicity.',
        '```mermaid',
        AUTOCODE_DOMAIN_CLASS_DIAGRAM_SKELETON,
        '```',
        'STATE stateDiagram-v2 (design_model.md): begin at [*], name each transition, and end at [*]. If no DES owns state, write "none - <reason>" under State Transition Diagrams instead.',
        '```mermaid',
        AUTOCODE_STATE_DIAGRAM_SKELETON,
        '```',
      ].join('\n')
    : '';
  const separatorGuidance = errors.some((error) =>
    error.includes('must define exactly one') ||
    error.includes('semicolon-separated') ||
    error.includes('ordered actions and explicit output markers')
  )
    ? [
        'Dimension and comparison fields are parsed on ASCII ";" and "=". Use ASCII separators even in localized prose; never use full-width "；" or "，". Examples:',
        '- Scenario: Who=...; Where=...; When=...',
        '- 5W1H analysis: Who=...; What=...; Why=...; When=...; Where=...; How=...',
        '- 8C constraints: Performance=...; Cost=...; Time=...; Reliability=...; Security=...; Compliance=...; Technology=...; Compatibility=...',
        '- SOLID rationale: SRP=...; OCP=...; LSP=...; ISP=...; DIP=...',
        '- Candidate comparison: <candidate | fit | benefits | costs | risks>; <second candidate | ... | ...>',
        '- Steps and outputs: 1. <action> => <output>; 2. <action> => <output>',
      ].join('\n')
    : '';
  const validationErrorBlock = [
    'BEGIN STANDARD DESIGN VALIDATION ERRORS',
    ...formatAutocodeRetryErrorLines(errors, { maxErrors: 80, maxCharsPerError: 400 }),
    'END STANDARD DESIGN VALIDATION ERRORS',
  ].join('\n');
  return [
    'The Standard design artifacts failed deterministic validation.',
    'Revise only the invalid design package artifacts. Keep valid evidence and stable IDs unchanged.',
    validationErrorBlock,
    identityFormatGuidance,
    contractGuidance,
    separatorGuidance,
    diagramGuidance,
    sourceReconstructionGuidance,
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
  requirePatternDefinitions = true,
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
    if (patterns && !isNoneValue(patterns[1])) {
      errors.push(`${AUTOCODE_TASK_ARTIFACTS.design} local design must use no new architectural pattern unless complexity evidence justifies a deeper design.`);
    }
  }
  errors.push(...validatePatternBudget(
    markdown,
    depth,
    sections,
    requirePatternDefinitions,
  ));
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

function getPatternIdsFromField(markdown: string, field: string): string[] {
  const value = getMachineReadableField(markdown, field);
  if (!value || isNoneValue(value)) {
    return [];
  }
  return extractAutocodeDesignIds(value).filter((id) => id.startsWith('PAT-'));
}

function isNoneValue(value: string): boolean {
  return /^(?:0|(?:none|n\/a)(?:\s+-\s+\S.*)?)$/i.test(value.trim());
}

function hasConcreteProjectFileReference(value: string): boolean {
  return /[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()[\]-]+/.test(value) ||
    /\b(?:[A-Za-z0-9_()-]+\.)+[A-Za-z][A-Za-z0-9-]*\b/.test(value) ||
    /\b(?:Dockerfile|Makefile|Rakefile|Gemfile|Procfile)\b/.test(value);
}

function haveSameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function validatePatternBudget(
  markdown: string,
  depth: AutocodeDesignDepth | undefined,
  sections: readonly AutocodeDesignSection[],
  requirePatternDefinitions = true,
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
  if (
    !haveSameIds(budgetIds, selectedIds) ||
    (requirePatternDefinitions && !haveSameIds(selectedIds, definedIds))
  ) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' pattern IDs must match across Design Budget, Selected patterns, and PAT-* sections.');
  }

  const limit = depth === 'complex' ? 3 : depth === 'standard' ? 2 : 0;
  if (definedIds.length > limit) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' ' + (depth ?? 'local') + ' design exceeds its selected-pattern limit of ' + limit + '.');
  }

  return errors;
}

function getDesignSectionArtifact(kind: AutocodeDesignSection['kind']): string {
  if (kind === 'ADR') {
    return AUTOCODE_TASK_ARTIFACTS.design;
  }
  if (kind === 'RM' || kind === 'FUN' || kind === 'SSD') {
    return AUTOCODE_TASK_ARTIFACTS.requirementModel;
  }
  if (kind === 'DOM') {
    return AUTOCODE_TASK_ARTIFACTS.domainModel;
  }
  if (
    kind === 'SYS' ||
    kind === 'DES' ||
    kind === 'STATE' ||
    kind === 'FLOW' ||
    kind === 'CONTRACT' ||
    kind === 'PAT' ||
    kind === 'REV'
  ) {
    return AUTOCODE_TASK_ARTIFACTS.designModel;
  }
  return AUTOCODE_TASK_ARTIFACTS.implementationModel;
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
    const location = getDesignSectionArtifact(section.kind) + ' ' + section.id;
    const body = section.markdown.replace(/^#{3,6}\s+[^\n]+\s*/i, '').trim();
    if (body.length < 20 || /^(?:none|n\/a|not applicable|todo|tbd)\.?$/i.test(body)) {
      errors.push(location + ' must contain a substantive design decision or model entry.');
    }
    const fields = MODEL_SECTION_FIELDS[section.kind];
    if (fields) {
      errors.push(...validateMachineReadableFields(
        section.markdown,
        location,
        fields,
      ));
    }
    const evidenceBasis = getMachineReadableField(section.markdown, 'Evidence basis');
    if (evidenceBasis) {
      errors.push(...validateEvidenceBasis(
        evidenceBasis,
        location + ' Evidence basis',
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

  if (!hasConcreteProjectFileReference(engineering)) {
    errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Engineering Adaptation must cite concrete project files or modules.');
  }

  for (const section of sections) {
    const location = getDesignSectionArtifact(section.kind) + ' ' + section.id;
    if (section.kind === 'ADR') {
      const status = getMachineReadableField(section.markdown, 'Status');
      if (status && !/^(?:proposed|accepted|superseded|rejected)$/i.test(status)) {
        errors.push(
          location +
          ' Status must be proposed, accepted, superseded, or rejected.',
        );
      }
    }
    if (section.kind === 'DOM') {
      const conceptKind = getMachineReadableField(section.markdown, 'Concept kind');
      if (conceptKind && !isExactMachineToken(conceptKind, DOMAIN_CONCEPT_KIND_TOKENS)) {
        errors.push(
          location +
          ' Concept kind must be exactly one English token with no trailing prose: ' +
          DOMAIN_CONCEPT_KIND_TOKENS.join(', ') + '.',
        );
      }
    }
    if (section.kind === 'DES') {
      const element = getMachineReadableField(section.markdown, 'Element');
      if (element && !hasMachineTokenDescription(element, DESIGN_ELEMENT_TOKENS)) {
        errors.push(
          location +
          ' Element must use <' + DESIGN_ELEMENT_TOKENS.join('|') + '> - <concrete element or symbol>.',
        );
      }
      const role = getMachineReadableField(section.markdown, 'Role stereotype');
      if (role && !isExactMachineToken(role, DESIGN_ROLE_STEREOTYPE_TOKENS)) {
        errors.push(
          location +
          ' Role stereotype must be exactly one English token with no trailing prose: ' +
          DESIGN_ROLE_STEREOTYPE_TOKENS.join(', ') + '.',
        );
      }
    }
    if (section.kind === 'IMP') {
      const files = getMachineReadableField(section.markdown, 'Project files and symbols') ?? '';
      if (!hasConcreteProjectFileReference(files)) {
        errors.push(location + ' must map to concrete project files and symbols.');
      }
      const mappings = extractAutocodeDesignIds(
        getMachineReadableField(section.markdown, 'Design mapping') ?? '',
      );
      if (!mappings.some((id) => id.startsWith('SYS-')) ||
          !mappings.some((id) => id.startsWith('DES-')) ||
          !mappings.some((id) => id.startsWith('FLOW-') || id.startsWith('CONTRACT-'))) {
        errors.push(
          location +
          ' Design mapping must reference SYS-*, DES-*, and FLOW-*/CONTRACT-* IDs.',
        );
      }
    }
  }

  return errors;
}

function validateV5CrossArtifactMappings(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
  requireImplementationCoverage = true,
): string[] {
  const errors: string[] = [];
  const knownIds = new Set(sections.map((section) => section.id));
  const requirementIds = new Set(
    sections.filter((section) => section.kind === 'RM').map((section) => section.id),
  );
  const functionIds = new Set(
    sections.filter((section) => section.kind === 'FUN').map((section) => section.id),
  );
  const sequenceIds = new Set(
    sections.filter((section) => section.kind === 'SSD').map((section) => section.id),
  );
  const domainIds = new Set(
    sections.filter((section) => section.kind === 'DOM').map((section) => section.id),
  );
  const designIds = new Set(
    sections.filter((section) => section.kind === 'DES').map((section) => section.id),
  );
  const languageIds = new Set(
    sections.filter((section) => section.kind === 'LANG').map((section) => section.id),
  );

  for (const concept of sections.filter((section) => section.kind === 'DOM')) {
    const sourceRefs = extractAutocodeDesignIds(
      getMachineReadableField(concept.markdown, 'Noun sources') ?? '',
    );
    for (const ref of sourceRefs) {
      if (
        (ref.startsWith('RM-') || ref.startsWith('FUN-') || ref.startsWith('SSD-')) &&
        !knownIds.has(ref)
      ) {
        errors.push(AUTOCODE_TASK_ARTIFACTS.domainModel + ' ' + concept.id +
          ' references unknown noun source ' + ref + '.');
      }
    }
    const relatedUseCases = extractAutocodeDesignIds(
      getMachineReadableField(concept.markdown, 'Related use cases') ?? '',
    ).filter((id) => id.startsWith('RM-'));
    if (relatedUseCases.length === 0) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.domainModel + ' ' + concept.id +
        ' must reference at least one RM-* Related use case.');
    }
    for (const ref of relatedUseCases) {
      if (!requirementIds.has(ref)) {
        errors.push(AUTOCODE_TASK_ARTIFACTS.domainModel + ' ' + concept.id +
          ' references unknown related use case ' + ref + '.');
      }
    }
  }

  const mappingSection = extractMarkdownSection(markdown, 'Domain To Software Mapping');
  const mappedField = getMachineReadableField(mappingSection, 'Mapped concepts') ?? '';
  const unmappedField = getMachineReadableField(mappingSection, 'Unmapped concepts') ?? '';
  const auxiliaryField = getMachineReadableField(mappingSection, 'Auxiliary elements') ?? '';
  const listedMapped = new Set(extractAutocodeDesignIds(mappedField));
  const listedUnmapped = new Set(extractAutocodeDesignIds(unmappedField));
  const listedAuxiliary = new Set(extractAutocodeDesignIds(auxiliaryField));
  const mappedByElement = new Set<string>();

  for (const element of sections.filter((section) => section.kind === 'DES')) {
    const location = AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + element.id;
    const mappingValue = getMachineReadableField(element.markdown, 'Domain mapping') ?? '';
    const mappings = extractAutocodeDesignIds(mappingValue).filter((id) => id.startsWith('DOM-'));
    if (mappings.length === 0) {
      if (!/^none\s+-\s+\S/iu.test(mappingValue)) {
        errors.push(location + ' Domain mapping must reference DOM-* or use none - <auxiliary reason>.');
      } else if (!listedAuxiliary.has(element.id)) {
        errors.push(location + ' has no DOM mapping and must appear in Auxiliary elements.');
      }
    }
    for (const domainId of mappings) {
      if (!domainIds.has(domainId)) {
        errors.push(location + ' maps unknown domain concept ' + domainId + '.');
      } else {
        mappedByElement.add(domainId);
      }
      if (!listedMapped.has(domainId) || !listedMapped.has(element.id)) {
        errors.push(location + ' mapping must also appear in the Mapped concepts summary.');
      }
    }
    const methodRefs = extractAutocodeDesignIds(
      getMachineReadableField(element.markdown, 'Method derivation') ?? '',
    ).filter((id) =>
      id.startsWith('RM-') || id.startsWith('FUN-') || id.startsWith('SSD-')
    );
    if (methodRefs.length === 0) {
      errors.push(location + ' Method derivation must reference RM, FUN, or SSD verbs.');
    }
    for (const ref of methodRefs) {
      if (
        !requirementIds.has(ref) &&
        !functionIds.has(ref) &&
        !sequenceIds.has(ref)
      ) {
        errors.push(location + ' derives a method from unknown model entry ' + ref + '.');
      }
    }
  }
  for (const domainId of domainIds) {
    if (!mappedByElement.has(domainId) && !listedUnmapped.has(domainId)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' domain concept ' + domainId +
        ' must be mapped to DES-* or listed under Unmapped concepts with a reason.');
    }
  }

  for (const state of sections.filter((section) => section.kind === 'STATE')) {
    const owner = extractAutocodeDesignIds(
      getMachineReadableField(state.markdown, 'State owner') ?? '',
    ).find((id) => id.startsWith('DES-'));
    if (owner && !designIds.has(owner)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + state.id +
        ' references unknown state owner ' + owner + '.');
    }
  }

  if (!requireImplementationCoverage) {
    return errors;
  }

  const implementationCoverage = new Set<string>();
  const languageCoverage = new Set<string>();
  for (const implementation of sections.filter((section) => section.kind === 'IMP')) {
    const location = AUTOCODE_TASK_ARTIFACTS.implementationModel + ' ' + implementation.id;
    const mappings = extractAutocodeDesignIds(
      getMachineReadableField(implementation.markdown, 'Design mapping') ?? '',
    );
    for (const ref of mappings) {
      if (!knownIds.has(ref)) {
        errors.push(location + ' Design mapping references unknown ID ' + ref + '.');
      } else {
        implementationCoverage.add(ref);
      }
    }
    const classMappings = extractAutocodeDesignIds(
      getMachineReadableField(implementation.markdown, 'Class realization') ?? '',
    ).filter((id) => id.startsWith('DES-'));
    for (const ref of classMappings) {
      if (!designIds.has(ref)) {
        errors.push(location + ' Class realization references unknown design element ' + ref + '.');
      } else {
        implementationCoverage.add(ref);
      }
    }
    const constraints = extractAutocodeDesignIds(
      getMachineReadableField(implementation.markdown, 'Coding constraints') ?? '',
    ).filter((id) => id.startsWith('LANG-'));
    for (const ref of constraints) {
      if (!languageIds.has(ref)) {
        errors.push(location + ' Coding constraints reference unknown language entry ' + ref + '.');
      } else {
        languageCoverage.add(ref);
      }
    }
  }

  for (const section of sections) {
    if (
      ['SYS', 'DES', 'STATE', 'FLOW', 'CONTRACT', 'PAT', 'REV'].includes(section.kind) &&
      !implementationCoverage.has(section.id)
    ) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.implementationModel + ' must map in-scope ' +
        section.id + ' through an IMP-* entry.');
    }
  }
  for (const languageId of languageIds) {
    if (!languageCoverage.has(languageId)) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.implementationModel + ' must apply ' +
        languageId + ' through an IMP-* Coding constraints field.');
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
  const functionIds = new Set(
    sections.filter((section) => section.kind === 'FUN').map((section) => section.id),
  );
  const allocatedRequirements = new Set<string>();
  const allocatedFunctions = new Set<string>();
  const allocatedSystems = new Set<string>();

  for (const section of sections.filter((candidate) => candidate.kind === 'SYS')) {
    const allocations = extractAutocodeDesignIds(
      getMachineReadableField(section.markdown, 'Allocated requirements') ?? '',
    ).filter((id) => id.startsWith('RM-'));
    if (allocations.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
        ' must allocate at least one RM-* requirement.',
      );
    }
    for (const requirementId of allocations) {
      if (!requirementIds.has(requirementId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
          ' allocates unknown requirement ' + requirementId + '.',
        );
      } else {
        allocatedRequirements.add(requirementId);
      }
    }
    const functionAllocations = extractAutocodeDesignIds(
      getMachineReadableField(section.markdown, 'Allocated functions') ?? '',
    ).filter((id) => id.startsWith('FUN-'));
    if (functionAllocations.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
        ' must allocate at least one FUN-* function.',
      );
    }
    for (const functionId of functionAllocations) {
      if (!functionIds.has(functionId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
          ' allocates unknown function ' + functionId + '.',
        );
      } else {
        allocatedFunctions.add(functionId);
      }
    }
  }

  for (const section of sections.filter((candidate) => candidate.kind === 'DES')) {
    const allocations = extractAutocodeDesignIds(
      getMachineReadableField(section.markdown, 'System allocation') ?? '',
    ).filter((id) => id.startsWith('SYS-'));
    if (allocations.length === 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
        ' must map to at least one SYS-* System allocation.',
      );
    }
    for (const systemId of allocations) {
      if (!systemIds.has(systemId)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id +
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
        AUTOCODE_TASK_ARTIFACTS.designModel + ' requirement ' + requirementId +
        ' is not allocated to any SYS-* boundary.',
      );
    }
  }
  for (const functionId of functionIds) {
    if (!allocatedFunctions.has(functionId)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' function ' + functionId +
        ' is not allocated to any SYS-* boundary.',
      );
    }
  }
  for (const systemId of systemIds) {
    if (!allocatedSystems.has(systemId)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' system boundary ' + systemId +
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
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + flow.id +
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
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + flow.id +
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
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + designId +
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
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + pattern.id +
        ' Participants and roles must reference concrete SYS-* or DES-* IDs.',
      );
    }
    for (const participant of participants) {
      if (!systemIds.has(participant) && !designIds.has(participant)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + pattern.id +
          ' references unknown participant ' + participant + '.',
        );
      }
    }
  }
  return errors;
}

function validateSourceReconstruction(
  designModelMarkdown: string,
  sections: readonly AutocodeDesignSection[],
  direction: AutocodeDesignAnalysisDirection | undefined,
): string[] {
  const errors: string[] = [];
  const reconstructions = sections.filter((section) => section.kind === 'REV');
  if (direction === 'forward-design') {
    if (reconstructions.length > 0) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel +
        ' forward-design must omit REV-* entries; use mixed only when reconstruction is required.',
      );
    }
    return errors;
  }
  if (direction !== 'reverse-engineering' && direction !== 'mixed') {
    return errors;
  }
  if (!hasMarkdownHeading(designModelMarkdown, 'Source Reconstruction')) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.designModel +
      ' missing "## Source Reconstruction" section.',
    );
  }
  if (reconstructions.length === 0) {
    errors.push(
      AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + direction +
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
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id + ' External capability must reference RM-*.');
    }
    if (!domain.some((id) => id.startsWith('DOM-'))) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id + ' Domain concepts must reference DOM-*.');
    }
    if (
      !responsibility.some((id) => id.startsWith('SYS-')) ||
      !responsibility.some((id) => id.startsWith('DES-'))
    ) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
        ' Responsibility path must reference SYS-* and DES-*.',
      );
    }
    if (!runtime.some((id) => id.startsWith('FLOW-') || id.startsWith('CONTRACT-'))) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
        ' Runtime path must reference FLOW-* or CONTRACT-*.',
      );
    }
    for (const id of [...external, ...domain, ...responsibility, ...runtime]) {
      if (!knownIds.has(id)) {
        errors.push(
          AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
          ' references unknown design ID ' + id + '.',
        );
      }
    }

    const sourceSymbols = getMachineReadableField(reconstruction.markdown, 'Source symbols') ?? '';
    if (!/[A-Za-z0-9_.-]+[/\\][A-Za-z0-9_.()\[\]-]+(?:#|::)[A-Za-z_$][A-Za-z0-9_$.]*/.test(sourceSymbols)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
        ' Source symbols must cite an exact project path and symbol using path#symbol or path::symbol.',
      );
    }
    const contradictionChecks = getMachineReadableField(reconstruction.markdown, 'Contradiction checks') ?? '';
    if (!/^(?:checked|conflict|unresolved)\s+-\s+\S/i.test(contradictionChecks)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
        ' Contradiction checks must start with checked, conflict, or unresolved plus evidence.',
      );
    }
    const confidence = getMachineReadableField(reconstruction.markdown, 'Confidence') ?? '';
    if (!/^(?:high|medium|low)\s+-\s+\S/i.test(confidence)) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + reconstruction.id +
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
        errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + flow.id + ' references unknown participant ' + participant + '.');
      }
    }
    if (participants.length === 0) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + flow.id + ' must name at least one DES-* participant.');
    } else if (requireCollaboration && participants.length < 2) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + flow.id + ' must show at least two collaborating DES-* participants.');
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
      errors.push(AUTOCODE_TASK_ARTIFACTS.designModel + ' ' + section.id + ' appears to be a God coordinator spanning ' + concernCount + ' unrelated concern groups; redistribute behavior to cohesive owners.');
    }
  }
  return errors;
}

function validateDesignTraceability(
  markdown: string,
  sections: readonly AutocodeDesignSection[],
  requireImplementationCoverage = true,
): string[] {
  const traceability = extractMarkdownSection(markdown, 'Traceability');
  const tracedIds = new Set(extractAutocodeDesignIds(traceability));
  const knownIds = new Set(sections.map((section) => section.id));
  // The machine contract's Traceability chain is RM-* -> FUN-* -> SSD-* -> DOM-* -> ADR-* ->
  // SYS-* -> DES-* -> STATE-*/FLOW-*/CONTRACT-* -> LANG-* -> IMP-*. LANG-*, PAT-*, and REV-*
  // are not positions in that chain: LANG is cross-cutting (traced via IMP Coding
  // constraints), PAT is traced via DES Pattern participation and the Design Budget, and REV
  // is traced via its own reconstruction paths. Requiring each of them to also appear in the
  // Traceability section contradicted the contract and failed valid designs.
  const traceabilityExemptKinds = new Set(['LANG', 'PAT', 'REV']);
  const errors = sections
    .filter((section) => !tracedIds.has(section.id) && !traceabilityExemptKinds.has(section.kind))
    .map((section) => AUTOCODE_TASK_ARTIFACTS.design + ' Traceability must include ' + section.id + '.');
  for (const tracedId of tracedIds) {
    if (
      !knownIds.has(tracedId) &&
      (
        requireImplementationCoverage ||
        !/^(?:LANG|IMP)-/.test(tracedId)
      )
    ) {
      errors.push(AUTOCODE_TASK_ARTIFACTS.design + ' Traceability references unknown design ID ' + tracedId + '.');
    }
  }
  const traceLines = traceability.replace(/\r\n/g, '\n').split('\n');
  for (const requirement of sections.filter((section) => section.kind === 'RM')) {
    const hasConnectedPath = traceLines.some((line) => {
      const ids = extractAutocodeDesignIds(line);
      const requirementIndex = ids.indexOf(requirement.id);
      const functionIndex = ids.findIndex((id) => id.startsWith('FUN-'));
      const sequenceIndex = ids.findIndex((id) => id.startsWith('SSD-'));
      const domainIndex = ids.findIndex((id) => id.startsWith('DOM-'));
      const decisionIndex = ids.findIndex((id) => id.startsWith('ADR-'));
      const systemIndex = ids.findIndex((id) => id.startsWith('SYS-'));
      const designIndex = ids.findIndex((id) => id.startsWith('DES-'));
      const dynamicIndex = ids.findIndex((id) =>
        id.startsWith('STATE-') || id.startsWith('FLOW-') || id.startsWith('CONTRACT-')
      );
      const languageIndex = ids.findIndex((id) => id.startsWith('LANG-'));
      const implementationIndex = ids.findIndex((id) => id.startsWith('IMP-'));
      const designPathIsConnected = requirementIndex >= 0 &&
        requirementIndex < functionIndex &&
        functionIndex < sequenceIndex &&
        sequenceIndex < domainIndex &&
        domainIndex < decisionIndex &&
        decisionIndex < systemIndex &&
        systemIndex < designIndex &&
        designIndex < dynamicIndex;
      const implementationPathIsConnected = !requireImplementationCoverage || (
        dynamicIndex < languageIndex &&
        languageIndex < implementationIndex
      );
      return designPathIsConnected &&
        implementationPathIsConnected &&
        /(?:->|=>|\u2192)/u.test(line);
    });
    if (!hasConnectedPath) {
      errors.push(
        AUTOCODE_TASK_ARTIFACTS.design + ' Traceability must connect ' + requirement.id +
        (
          requireImplementationCoverage
            ? ' through FUN-*, SSD-*, DOM-*, ADR-*, SYS-*, DES-*, STATE/FLOW/CONTRACT, LANG-*, and IMP-* in that order.'
            : ' through FUN-*, SSD-*, DOM-*, ADR-*, SYS-*, DES-*, and STATE/FLOW/CONTRACT in that order.'
        ),
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
    !hasConcreteProjectFileReference(projectEvidence) &&
    !/(?:https?:\/\/|project docs?|repository)/i.test(projectEvidence)
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
  if (!/^(?:unresolved\s+-\s+\S.*|none)$/i.test(unresolvedEvidence)) {
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
