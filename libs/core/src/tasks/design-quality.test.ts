import { describe, expect, it } from 'vitest';
import {
  AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT,
  buildAutocodeDesignPackageMarkdown,
  buildAutocodeDesignQualityRetryPrompt,
  detectAutocodeDesignReviewHumanInputGate,
  detectAutocodeRequirementsBlockingGate,
  getAutocodeDesignPackageFingerprint,
  getAutocodeDesignContractVersion,
  parseAutocodeDesignSections,
  selectAutocodeDesignRevisionStages,
  validateAutocodeStandardDesignArtifacts,
  validateAutocodeStandardDesignStageArtifacts,
  validateAutocodeTaskDesignReferences,
} from './design-quality.js';

const fence = '```';

const designMarkdown = `# Design: Task submission
Design-Contract: 5
Design-Depth: local
Design-Revision: 2

## Scope And Evidence
- Analysis direction: forward-design
- Primary source of truth: requirement
- Requirement evidence: requirement - requirements.md R-001 and AC-001 define task submission
- Project evidence: observed - apps/desktop/src/main/task-service.ts owns the existing task boundary
- Design inferences: inferred - one state owner keeps submission transitions coherent
- Unresolved evidence: none

## Complexity Assessment
- Primary complexity driver: one stateful submission lifecycle with validation
- Business rules and state: a task moves from draft to submitted or rejected under one owner
- Boundary and contract impact: the existing task service contract remains stable
- Quality-attribute risks: invalid submissions must not corrupt persisted task state
- Depth rationale: one cohesive state owner and one existing service boundary are sufficient

## Existing Architecture Fit
Reuse the existing renderer, bridge, and task-service boundary without adding architectural layers.

## Engineering Adaptation
- Delivery context: existing-system
- System shape: local-utility
- Project paradigm: object-oriented
- Paradigm rationale: the existing task entity owns identity, state, and submission invariants
- Object-model applicability: medium
- Object-model rationale: the task has meaningful state and behavior but no broad object collaboration
- Existing boundaries to preserve: apps/desktop/src/main/task-service.ts task service boundary
- Existing patterns to reuse: direct entity method invoked by the existing task service
- Language/framework constraints: TypeScript 5.9 and the existing Electron process split
- Integration and test seams: apps/desktop/src/main/task-service.test.ts exercises the service boundary

## Design Budget
- Expected modules changed: 2
- New modules allowed: 0
- New public contracts allowed: 0
- New dependencies allowed: 0
- New architectural patterns: none

## Architecture Candidates
- Architecture baseline: preserve the existing task service with a cohesive task state owner
- Candidate count: 1
- Candidate comparison: existing task boundary | satisfies the complete submission flow | keeps state and invariants cohesive | retains the current service dependency | limits migration and regression risk
- Selected architecture: existing task service boundary
- Selection rationale: the observed boundary already provides the smallest complete home for the required lifecycle
- Rejected alternatives: reject a new workflow service because it adds indirection without a second workflow variant
- Evolution trigger: two independently deployed submission policies with incompatible lifecycle rules

## Architecture Decision
### ADR-001 Preserve the task boundary
- Decision: keep submission policy and state mutation in the task owner behind the existing service
- Status: accepted
- Decision drivers: RM-001, FUN-001, DOM-001, reliability, compatibility, and minimal change radius
- Alternatives considered: a separate workflow service and an event-driven submission pipeline
- Trade-offs: cohesive mutation and low migration cost at the cost of retaining a synchronous local call
- Evidence basis: requirement - requirements.md R-001; observed - apps/desktop/src/main/task-service.ts

## Model Package
- Requirement model: requirement_model.md
- Domain model: domain_model.md
- Design model: design_model.md
- Implementation model: implementation_model.md

## Change And Pattern Analysis
- Verified variation points: none - one submission policy is currently required
- Variation inventory: none - no independent policy, type, or framework variants exist
- Candidate patterns evaluated: direct entity method is simpler than State or Strategy for one policy
- Simplest change mechanism: a cohesive submit operation with explicit transition guards
- Selected patterns: none

## Applicable Design Principles
- Single-responsibility decision: DES-001 owns only task submission state and invariants
- Open-closed decision: direct change is safer until a second verified submission policy exists
- Liskov-substitution decision: n/a - no subtype hierarchy is introduced
- Interface-segregation decision: n/a - the existing service uses one focused operation
- Dependency-inversion decision: n/a - no volatile external mechanism is introduced
- Cohesion and encapsulation decision: state mutation remains private to DES-001
- Framework adaptation decision: the existing service invokes the domain owner without absorbing its rules
- Underdesign checks: no generic manager, anemic state record, hidden mutation, or bypass path remains

## Rejected Complexity
A workflow engine, event bus, repository abstraction, and strategy hierarchy are rejected because no current variation requires them.

## Risks And Evolution
Regression risk is limited to transition validation and is covered by focused unit and service tests.

## Traceability
- RM-001 -> FUN-001 -> SSD-001 -> DOM-001 -> ADR-001 -> SYS-001 -> DES-001 -> STATE-001 -> FLOW-001 -> LANG-001 -> IMP-001
`;

const requirementModelMarkdown = `# Requirement Model: Task submission
Design-Contract: 5
Design-Revision: 2
Design-Root: design.md
Model-Kind: requirement

## Requirement Analysis
- Input requirements: R-001 and AC-001 task submission scope
- Industry assumptions: inferred - invalid submission should preserve the last valid task state
- Open requirement questions: none

## Use Case List
### RM-001 Submit a task
- Use case name: Submit a task
- Scenario: Who=project member; Where=task editor; When=after entering required task data
- 5W1H analysis: Who=project member; What=submit a valid task; Why=start tracked execution; When=after required data is ready; Where=task editor; How=confirm submission and inspect the result
- Trigger and preconditions: the member confirms a draft containing required fields
- Use case description: the member submits the draft and the system validates and records the accepted task
- Steps and outputs: 1. User confirms the draft => System returns validation feedback; 2. User submits valid data => System returns the submitted task and status
- Use case value: Why=turn an approved draft into trackable executable work
- Alternate and exception flows: missing required data -> reject submission -> preserve draft and show actionable validation; persistence failure -> retain draft -> report retry guidance
- Postconditions: success stores a submitted task; failure preserves the valid draft without partial state
- 8C constraints: Performance=validation completes within 200 ms locally; Cost=no new runtime dependency; Time=available in the current release; Reliability=failed submission preserves the draft; Security=only an authorized project member may submit; Compliance=audit metadata remains attributable; Technology=use the existing Electron and TypeScript stack; Compatibility=preserve the current task service contract
- Evidence basis: requirement - requirements.md R-001; requirement - spec.md SCN-001; inferred - standard transactional failure handling

## Functional List
### FUN-001 Validate and submit task
- Function description: validate a draft and persist one accepted task transition
- Involved use cases: RM-001
- Merge decision: distinct - only the submission use case requires this complete capability
- Evidence basis: requirement - requirement_model.md RM-001; requirement - requirements.md R-001

## System Sequence Diagrams
### SSD-001 Submit task sequence
- Use case: RM-001
- Participants: project member on the left and System on the right
- Main and exception messages: submit draft, validate input, return accepted task, or return actionable rejection
- Evidence basis: requirement - requirement_model.md RM-001
${fence}mermaid
sequenceDiagram
    autonumber
    actor Member as Project member
    participant System as Task system
    Member->>System: submit draft
    activate System
    System->>System: validate draft
    alt valid draft
        System->>System: record submitted task
        System-->>Member: submitted task and status
    else invalid or storage failure
        System-->>Member: rejection and preserved draft
    end
    deactivate System
${fence}
`;

const domainModelMarkdown = `# Domain Model: Task submission
Design-Contract: 5
Design-Revision: 2
Design-Root: design.md
Model-Kind: domain

## Noun Analysis
- Candidate nouns: task -> RM-001 and FUN-001; draft -> RM-001; submission status -> SSD-001
- Excluded nouns: editor - interaction location rather than a domain object; button - user interface detail
- Synonym merges: draft task and task draft -> Task because they share one identity and lifecycle

## Domain Model
### DOM-001 Task
- Concept kind: entity
- Noun sources: RM-001, FUN-001, SSD-001
- Business meaning: a unit of requested work that moves from draft to an accepted or rejected submission outcome
- Attributes: taskId: stable identity; title: required work name; status: draft or submitted; rejectionReason: protected failure detail
- Identity: taskId remains stable throughout the task lifecycle
- Rules and invariants: only a complete draft may become submitted and a failed attempt preserves draft state
- Lifecycle states: draft -> submitted on valid acceptance; draft remains draft on rejection
- Relationships: a project member submits one Task and a Task belongs to one project lifecycle
- Related use cases: RM-001
- Evidence basis: requirement - requirement_model.md RM-001; inferred - task identity persists across submission attempts

## Domain Class Diagram
${fence}mermaid
classDiagram
    direction LR
    class DOM_001["Task"] {
        <<entity>>
        taskId
        title
        status
        rejectionReason
    }
${fence}
`;

const designModelMarkdown = `# Design Model: Task submission
Design-Contract: 5
Design-Revision: 2
Design-Root: design.md
Model-Kind: design

## System Responsibility Allocation
### SYS-001 Task service boundary
- Subsystem or boundary: existing task service application boundary
- Allocated requirements: RM-001
- Allocated functions: FUN-001
- Owns: submission orchestration and persistence handoff
- Provides: one compatible submit-task operation
- Requires: DOM-001 task state and the existing persistence port
- Data and control boundary: the service receives a draft and delegates invariant enforcement to DES-001
- Failure ownership: the service translates validation or persistence failure without mutating a rejected draft
- Evidence basis: requirement - requirement_model.md RM-001; observed - apps/desktop/src/main/task-service.ts

## Domain To Software Mapping
- Mapped concepts: DOM-001 -> DES-001 because task identity, attributes, and invariants require one state owner
- Unmapped concepts: none - every retained domain concept has implementation responsibility
- Auxiliary elements: none - the existing service boundary already satisfies framework obligations

## Design Model
### DES-001 TaskExecution
- Element: class - TaskExecution
- System allocation: SYS-001
- Domain mapping: DOM-001
- Name mapping: DOM-001 Task -> TaskExecution to match the existing project symbol
- Attribute mapping: taskId -> private taskId; title -> private title; status -> private status; rejectionReason -> protected failure result
- Method derivation: RM-001 submit and FUN-001 validate submit from SSD-001 -> submitDraft -> DES-001
- Role stereotype: entity
- Framework role: none - the class is framework independent and invoked by the existing service
- Owned state: taskId, title, and submission status with sole transition authority
- Public operations: submitDraft validates required data and returns an accepted or rejected result
- Responsibilities: enforce completeness and transition a draft to submitted exactly once
- Collaborators: SYS-001 service boundary and the existing persistence port
- Dependencies: depends on submitted-task persistence only after invariant validation
- Encapsulation boundary: status mutation and transition guards remain private
- Does not own: user interface rendering, IPC transport, scheduling, or persistence implementation
- SOLID rationale: SRP=owns only task submission invariants; OCP=direct change remains safer until a second policy exists; LSP=n/a - no subtype hierarchy; ISP=n/a - one focused operation serves one client; DIP=n/a - the existing persistence port already isolates the mechanism
- Pattern participation: none - a direct entity method is the simplest cohesive mechanism
- Evidence basis: requirement - requirement_model.md RM-001; observed - apps/desktop/src/main/task-service.ts; inferred - entity ownership prevents partial transitions

## Class Diagram
${fence}mermaid
classDiagram
    class DES_001 {
        -taskId
        -title
        -status
        +submitDraft()
    }
${fence}

## State Transition Diagrams
### STATE-001 Task submission lifecycle
- State owner: DES-001
- States: Draft accepts edits; Submitted is the accepted terminal state
- Initial state: Draft
- Transitions: submit valid draft -> Draft -> Submitted -> persist accepted task
- Invalid transitions: submit incomplete draft is rejected and preserves Draft
- Exception recovery: persistence failure returns to Draft with retry-safe data
- Evidence basis: requirement - requirement_model.md RM-001; requirement - requirement_model.md FUN-001
${fence}mermaid
stateDiagram-v2
    [*] --> Draft
    Draft --> Submitted: valid submit
    Draft --> Draft: invalid or persistence failure
${fence}

## Sequence Diagrams
### FLOW-001 Submit task collaboration
- Trigger: a project member confirms task submission
- Participants: DES-001
- Steps: DES-001 validates DOM-001 invariants -> DES-001 transitions state -> SYS-001 persists and returns the result
- State changes: DES-001 alone changes Draft to Submitted after successful persistence
- Failure paths: validation or persistence failure preserves Draft and returns an actionable rejection
- Evidence basis: requirement - requirement_model.md RM-001; observed - apps/desktop/src/main/task-service.ts
${fence}mermaid
sequenceDiagram
    participant Service as SYS-001
    participant Task as DES-001
    Service->>Task: submitDraft
    Task-->>Service: accepted task or rejection
${fence}
`;

const implementationModelMarkdown = `# Implementation Model: Task submission
Design-Contract: 5
Design-Revision: 2
Design-Root: design.md
Model-Kind: implementation

## Language And Coding Constraints
### LANG-001 TypeScript desktop constraints
- Scope: task entity, task service integration, and focused tests
- Language and version: TypeScript 5.9 from apps/desktop/package.json and the configured compiler
- Naming and formatting: PascalCase classes, camelCase members, single quotes, semicolons, and two-space indentation
- Type and interface rules: explicit result unions model accepted and rejected submission outcomes
- Class and visibility rules: private mutable fields and the smallest public operation surface
- Error handling: expected validation failures use typed results and unexpected persistence failures retain causal context
- Resource and lifecycle management: no unmanaged resource survives the submit operation
- Concurrency and state management: one owner serializes status mutation and rejects duplicate transitions
- Framework integration: preserve Electron main, preload, renderer boundaries and the existing task service API
- Testing and documentation: unit-test transitions and service-test success and failure behavior
- Evidence basis: observed - apps/desktop/package.json; observed - apps/desktop/src/main/task-service.ts

## Implementation Model
### IMP-001 Realize task submission
- Project files and symbols: apps/desktop/src/main/task-service.ts#submitTask; apps/desktop/src/main/task-execution.ts#TaskExecution; apps/desktop/src/main/task-service.test.ts
- Design mapping: SYS-001, DES-001, STATE-001, FLOW-001
- Coding constraints: LANG-001
- Class realization: DES-001 -> apps/desktop/src/main/task-execution.ts#TaskExecution
- Integration constraints: preserve the current service signature and expose no renderer-only dependency in main
- Verification: run focused transition tests, service tests, typecheck, and the desktop build
- Evidence basis: observed - apps/desktop/src/main/task-service.ts; requirement - requirement_model.md FUN-001
`;

const reviewMarkdown = `Status: PASSED

The complete Design-Contract: 5 package is traceable, cohesive, and proportionate to the verified scope.
`;

const tasksMarkdown = `# Tasks

- [ ] 1. Task submission
  - [ ] 1.1 Implement and verify task submission
    - _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_
    - _Requirements: R-001, AC-001_
    - _Evidence: requirements.md R-001 and apps/desktop/src/main/task-service.ts_
    - _Done when: valid tasks submit and rejected tasks preserve draft state_
    - _Verification: focused unit tests, service tests, typecheck, and desktop build_
`;

function buildV5Package() {
  return {
    designMarkdown,
    requirementModelMarkdown,
    domainModelMarkdown,
    designModelMarkdown,
    implementationModelMarkdown,
  };
}

function validatePackage(overrides: Partial<ReturnType<typeof buildV5Package>> = {}) {
  return validateAutocodeStandardDesignArtifacts({
    ...buildV5Package(),
    ...overrides,
    designReviewMarkdown: reviewMarkdown,
    tasksMarkdown,
  });
}

function removeRange(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  return source.slice(0, startIndex) + source.slice(endIndex);
}

describe('Design-Contract: 5 quality validation', () => {
  it('does not require every LANG-* to appear in design.md Traceability', () => {
    // Regression: secondary cross-cutting LANG constraints (e.g. a test/toolchain language)
    // are traced through IMP "Coding constraints=LANG-*"; the machine contract only requires
    // one LANG-* per RM chain, so requiring each LANG-* in the Traceability section
    // over-constrained valid designs and failed planning after exhausting revisions.
    const withSecondaryLang = implementationModelMarkdown
      .replace(
        '## Implementation Model',
        [
          '### LANG-002 Test tooling constraints',
          '- Scope: focused unit and service tests for task submission',
          '- Language and version: Vitest 3.2 from apps/desktop/package.json',
          '- Naming and formatting: describe and it blocks with single quotes and semicolons',
          '- Type and interface rules: typed fixtures mirror the result unions',
          '- Class and visibility rules: tests import only public entry points',
          '- Error handling: assert accepted and rejected submission outcomes',
          '- Resource and lifecycle management: no shared mutable state across tests',
          '- Concurrency and state management: tests run serially without shared owners',
          '- Framework integration: preserve the existing Vitest configuration',
          '- Testing and documentation: cover each transition and failure path',
          '- Evidence basis: observed - apps/desktop/package.json',
          '',
          '## Implementation Model',
        ].join('\n'),
      )
      .replace('Coding constraints: LANG-001', 'Coding constraints: LANG-001, LANG-002');

    const result = validatePackage({ implementationModelMarkdown: withSecondaryLang });
    expect(result.errors).not.toContain('design.md Traceability must include LANG-002.');
  });

  it('accepts a complete v5 design package and task traceability', () => {
    const result = validatePackage();

    expect(result.errors).toEqual([]);
    expect(result.contractVersion).toBe(5);
    expect(result.sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'ADR-001',
      'RM-001',
      'FUN-001',
      'SSD-001',
      'DOM-001',
      'SYS-001',
      'DES-001',
      'STATE-001',
      'FLOW-001',
      'LANG-001',
      'IMP-001',
    ]));
  });

  it('validates each v5 generation stage before downstream generation', () => {
    expect(validateAutocodeStandardDesignStageArtifacts(
      { requirementModelMarkdown },
      'requirement_model',
    ).errors).toEqual([]);
    expect(validateAutocodeStandardDesignStageArtifacts(
      { requirementModelMarkdown, domainModelMarkdown, designMarkdown },
      'design',
    ).errors).toEqual([]);
    expect(validateAutocodeStandardDesignStageArtifacts(
      { requirementModelMarkdown, domainModelMarkdown, designMarkdown, designModelMarkdown },
      'design_model',
    ).errors).toEqual([]);
    expect(validateAutocodeStandardDesignStageArtifacts(
      buildV5Package(),
      'implementation_model',
    ).errors).toEqual([]);
  });

  it('accepts multi-word and multi-entry unresolved evidence values', () => {
    const withOpenQuestion = designMarkdown.replace(
      '- Unresolved evidence: none',
      '- Unresolved evidence: unresolved - requirements.md Q1 has not fixed the spawn layout and rotation pivot',
    );
    expect(validatePackage({ designMarkdown: withOpenQuestion }).errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Unresolved evidence must be exactly')]),
    );

    const withMultipleQuestions = designMarkdown.replace(
      '- Unresolved evidence: none',
      '- Unresolved evidence: unresolved - Q1 spawn layout is open; unresolved - Q2 fall interval is open',
    );
    expect(validatePackage({ designMarkdown: withMultipleQuestions }).errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('Unresolved evidence must be exactly')]),
    );
  });

  it('rejects unresolved evidence that lacks the exact prefix or the exact "none" token', () => {
    const withoutPrefix = designMarkdown.replace(
      '- Unresolved evidence: none',
      '- Unresolved evidence: pending - the spawn layout is still open',
    );
    expect(validatePackage({ designMarkdown: withoutPrefix }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Unresolved evidence must be exactly')]),
    );

    const noneWithReason = designMarkdown.replace(
      '- Unresolved evidence: none',
      '- Unresolved evidence: none - nothing outstanding',
    );
    expect(validatePackage({ designMarkdown: noneWithReason }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('Unresolved evidence must be exactly')]),
    );
  });

  it('rejects misplaced root machine fields during the design owner stage', () => {
    const malformedDesign = designMarkdown.replace(
      '- Analysis direction: forward-design',
      'Analysis direction: forward-design',
    );

    expect(validateAutocodeStandardDesignStageArtifacts(
      { requirementModelMarkdown, domainModelMarkdown, designMarkdown: malformedDesign },
      'design',
    ).errors).toContain(
      'design.md Scope And Evidence must contain machine field - Analysis direction: <value>.',
    );
  });

  it('detects design-model mappings, derivation, and ordering before implementation mapping', () => {
    const malformedDesignModel = designModelMarkdown
      .replace(
        '- Mapped concepts: DOM-001 -> DES-001 because task identity, attributes, and invariants require one state owner',
        '- Mapped concepts: none - no concepts listed',
      )
      .replace(
        '- Method derivation: RM-001 submit and FUN-001 validate submit from SSD-001 -> submitDraft -> DES-001',
        '- Method derivation: submit the draft through the state owner',
      )
      .replace(
        '- Steps: DES-001 validates DOM-001 invariants -> DES-001 transitions state -> SYS-001 persists and returns the result',
        '- Steps: DES-001 validates; DES-001 transitions; SYS-001 persists',
      )
      .replace(
        '- Participants: DES-001',
        '- Participants: DES-001, DES-999',
      );

    const errors = validateAutocodeStandardDesignStageArtifacts(
      {
        requirementModelMarkdown,
        domainModelMarkdown,
        designMarkdown: designMarkdown.replace(
          'Design-Depth: local',
          'Design-Depth: standard',
        ),
        designModelMarkdown: malformedDesignModel,
      },
      'design_model',
    ).errors;

    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('DES-001 mapping must also appear in the Mapped concepts summary.'),
      expect.stringContaining('DES-001 Method derivation must reference RM, FUN, or SSD verbs.'),
      expect.stringContaining('FLOW-001 Steps must express an explicit order with arrows or numbered steps.'),
    ]));
  });

  it('requires Source Reconstruction in design_model.md rather than elsewhere in the package', () => {
    const reverseDesign = designMarkdown
      .replace('- Analysis direction: forward-design', '- Analysis direction: reverse-engineering')
      .replace('- Primary source of truth: requirement', '- Primary source of truth: source')
      .replace(
        '## Risks And Evolution',
        '## Source Reconstruction\nThis deliberately misplaced heading must not satisfy the design-model contract.\n\n## Risks And Evolution',
      );

    const errors = validateAutocodeStandardDesignStageArtifacts(
      {
        requirementModelMarkdown,
        domainModelMarkdown,
        designMarkdown: reverseDesign,
        designModelMarkdown,
      },
      'design_model',
    ).errors;

    expect(errors).toContain('design_model.md missing "## Source Reconstruction" section.');
    expect(errors).not.toContain('design.md missing "## Source Reconstruction" section.');
  });

  it('routes validation errors by their owning artifact before inspecting referenced IDs', () => {
    expect(selectAutocodeDesignRevisionStages([
      'design.md Traceability must connect RM-001 through FUN-*, SSD-*, and DOM-*.',
    ])).toEqual(['design', 'design_model', 'implementation_model']);
    expect(selectAutocodeDesignRevisionStages([
      'design.md Model Package must contain - Requirement model: requirement_model.md.',
    ])).toEqual(['design', 'design_model', 'implementation_model']);
    expect(selectAutocodeDesignRevisionStages([
      'design_model.md DES-001 Method derivation must reference RM-001 verbs.',
    ])).toEqual(['design_model', 'implementation_model']);
    expect(selectAutocodeDesignRevisionStages([
      'design_model.md missing "## Source Reconstruction" section.',
    ])).toEqual(['design_model', 'implementation_model']);
    expect(selectAutocodeDesignRevisionStages([
      'design.md missing "## Source Reconstruction" section.',
    ])).toEqual(['design_model', 'implementation_model']);
    expect(selectAutocodeDesignRevisionStages([
      'implementation_model.md IMP-001 lacks coverage.',
      'design.md Traceability must include IMP-001.',
    ])).toEqual(['design', 'design_model', 'implementation_model']);
  });

  it('accepts root project files and explained no-pattern declarations', () => {
    const result = validatePackage({
      designMarkdown: designMarkdown
        .replace('- New architectural patterns: none', '- New architectural patterns: none - no verified variation')
        .replace('- Selected patterns: none', '- Selected patterns: none - direct behavior is sufficient'),
      implementationModelMarkdown: implementationModelMarkdown.replace(
        /^- Project files and symbols:.*$/m,
        '- Project files and symbols: CMakeLists.txt; README.md',
      ),
    });

    expect(result.errors).toEqual([]);
  });

  it('recognizes only v5 and rejects v3 or v4 roots', () => {
    expect(getAutocodeDesignContractVersion(designMarkdown)).toBe(5);
    for (const version of [3, 4]) {
      const legacy = designMarkdown.replace('Design-Contract: 5', 'Design-Contract: ' + version);
      expect(getAutocodeDesignContractVersion(legacy)).toBeUndefined();
      expect(validatePackage({ designMarkdown: legacy }).errors).toContain(
        'design.md must declare Design-Contract: 5; older design contracts are unsupported.',
      );
    }
    expect(getAutocodeDesignContractVersion(
      designMarkdown.replace('Design-Contract: 5', 'Design-Contract: 5\nDesign-Contract: 4'),
    )).toBeUndefined();
  });

  it('requires every exact 8C assignment', () => {
    const malformed = requirementModelMarkdown.replace(
      'Compliance=audit metadata remains attributable;',
      'Regulation=audit metadata remains attributable;',
    );

    expect(validatePackage({ requirementModelMarkdown: malformed }).errors).toContain(
      'requirement_model.md RM-001 8C constraints must define exactly one Compliance=... assignment.',
    );
  });

  it('rejects full-width semicolons between Scenario/5W1H dimensions (must use ASCII separators)', () => {
    // Regression: dimension fields are split on ASCII ";"; localized (zh-CN) runs often
    // emit full-width "；" which hides every dimension after the first. The machine
    // contract prompt must therefore require ASCII separators for Scenario and 5W1H.
    const scenarioMalformed = requirementModelMarkdown.replace(
      '- Scenario: Who=project member; Where=task editor; When=after entering required task data',
      '- Scenario: Who=project member；Where=task editor；When=after entering required task data',
    );
    expect(validatePackage({ requirementModelMarkdown: scenarioMalformed }).errors).toEqual(
      expect.arrayContaining([
        'requirement_model.md RM-001 Scenario must define exactly one Where=... assignment.',
        'requirement_model.md RM-001 Scenario must define exactly one When=... assignment.',
      ]),
    );
  });

  it('rejects forward-design paired with source-only truth (prompt must declare the pairing)', () => {
    const forwardSource = designMarkdown.replace(
      '- Primary source of truth: requirement',
      '- Primary source of truth: source',
    );
    expect(validatePackage({ designMarkdown: forwardSource }).errors).toEqual(
      expect.arrayContaining([
        'design.md forward-design cannot declare source as its only primary source of truth.',
      ]),
    );
  });

  it('rejects local depth that adds a dependency (prompt must declare the budget rule)', () => {
    const localWithDependency = designMarkdown.replace(
      '- New dependencies allowed: 0',
      '- New dependencies allowed: 1',
    );
    expect(validatePackage({ designMarkdown: localWithDependency }).errors).toEqual(
      expect.arrayContaining([
        'design.md local design may not add a dependency without escalating its depth and evidence.',
      ]),
    );
  });

  it('rejects full-width semicolons between architecture candidate entries', () => {
    // Regression: Candidate comparison is split on ASCII ";" and must contain exactly
    // Candidate count entries. A localized full-width "；" collapses multiple candidates
    // into one entry, so the machine contract prompt must require ASCII separators.
    const fullWidthCandidates = designMarkdown
      .replace('Design-Depth: local', 'Design-Depth: standard')
      .replace('- Candidate count: 1', '- Candidate count: 2')
      .replace(
        '- Candidate comparison: existing task boundary | satisfies the complete submission flow | keeps state and invariants cohesive | retains the current service dependency | limits migration and regression risk',
        '- Candidate comparison: existing boundary | fits the flow | keeps invariants cohesive | retains one dependency | limits regression risk；new workflow service | also fits the flow | adds isolation seams | adds indirection cost | adds migration risk',
      );
    expect(validatePackage({ designMarkdown: fullWidthCandidates }).errors).toEqual(
      expect.arrayContaining([
        'design.md Architecture Candidates Candidate comparison must contain exactly 2 semicolon-separated candidate entries.',
      ]),
    );
  });

  it('rejects constraint dimensions outside the exact 8C set', () => {
    const malformed = requirementModelMarkdown.replace(
      'Compatibility=preserve the current task service contract',
      'Compatibility=preserve the current task service contract; Scalability=add unlimited workers',
    );

    expect(validatePackage({ requirementModelMarkdown: malformed }).errors).toContain(
      'requirement_model.md RM-001 8C constraints must not define Scalability=...; allowed dimensions are Performance, Cost, Time, Reliability, Security, Compliance, Technology, Compatibility.',
    );
  });

  it('rejects duplicate normalized functions', () => {
    const duplicateSection = [
      '',
      '### FUN-002 Validate and submit task',
      '- Function description: validate a draft and persist one accepted task transition',
      '- Involved use cases: RM-001',
      '- Merge decision: distinct - this intentionally duplicates FUN-001 for validation',
      '- Evidence basis: requirement - requirement_model.md RM-001',
      '',
      '## System Sequence Diagrams',
    ].join('\n');
    const duplicate = requirementModelMarkdown.replace(
      '\n## System Sequence Diagrams',
      duplicateSection,
    );

    expect(validatePackage({ requirementModelMarkdown: duplicate }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('duplicate the same normalized capability; merge them.')]),
    );
  });

  it('requires exactly one SSD for every use case', () => {
    const withoutSequence = requirementModelMarkdown.replace(/### SSD-001[\s\S]*$/u, '');

    expect(validatePackage({ requirementModelMarkdown: withoutSequence }).errors).toEqual(
      expect.arrayContaining([
        'requirement_model.md use case RM-001 must have exactly one SSD-* system sequence diagram.',
      ]),
    );
  });

  it('requires numbered actor-System SSD presentation with processing and activation', () => {
    const malformed = requirementModelMarkdown
      .replace('    autonumber\n', '')
      .replace('    activate System\n', '')
      .replace('    deactivate System\n', '')
      .replace(/^\s*System->>System:.*\n/gmu, '')
      .replaceAll('System-->>Member:', 'System->>Member:');

    expect(validatePackage({ requirementModelMarkdown: malformed }).errors).toEqual(
      expect.arrayContaining([
        'requirement_model.md SSD-001 SSD must enable Mermaid autonumber so business messages are displayed in order.',
        'requirement_model.md SSD-001 SSD must show at least one dashed System-to-primary-actor observable response.',
        'requirement_model.md SSD-001 SSD must show at least one coarse System-to-System processing responsibility.',
        'requirement_model.md SSD-001 SSD must show a complete System activation and deactivation interval.',
      ]),
    );
  });

  it('requires the primary actor first and stable System alias second', () => {
    const reversed = requirementModelMarkdown.replace(
      '    actor Member as Project member\n    participant System as Task system',
      '    participant System as Task system\n    actor Member as Project member',
    );

    expect(validatePackage({ requirementModelMarkdown: reversed }).errors).toEqual(
      expect.arrayContaining([
        'requirement_model.md SSD-001 SSD must declare the primary business actor first so it appears on the left.',
        'requirement_model.md SSD-001 SSD must declare the product second with the stable alias System.',
      ]),
    );
  });

  it('requires a concrete version in LANG Language and version (prompt must declare it)', () => {
    const noVersion = implementationModelMarkdown.replace(
      '- Language and version: TypeScript 5.9 from apps/desktop/package.json and the configured compiler',
      '- Language and version: TypeScript from the existing project toolchain',
    );
    expect(validatePackage({ implementationModelMarkdown: noVersion }).errors).toEqual(
      expect.arrayContaining([
        'implementation_model.md LANG-001 must cite an observed language/toolchain version.',
      ]),
    );
  });

  it('requires DES Domain mapping to reference DOM-* or none - <reason> (prompt must declare it)', () => {
    const badMapping = designModelMarkdown.replace(
      '- Domain mapping: DOM-001',
      '- Domain mapping: the task concept',
    );
    expect(validatePackage({ designModelMarkdown: badMapping }).errors).toEqual(
      expect.arrayContaining([
        'design_model.md DES-001 Domain mapping must reference DOM-* or use none - <auxiliary reason>.',
      ]),
    );
  });

  it('requires DOM Related use cases to reference RM-* (prompt must declare it)', () => {
    const noRm = domainModelMarkdown.replace(
      '- Related use cases: RM-001',
      '- Related use cases: none',
    );
    expect(validatePackage({ domainModelMarkdown: noRm }).errors).toEqual(
      expect.arrayContaining([
        'domain_model.md DOM-001 must reference at least one RM-* Related use case.',
      ]),
    );
  });

  it('requires IMP Project files and symbols to be concrete (prompt must declare it)', () => {
    const abstractFiles = implementationModelMarkdown.replace(
      /^- Project files and symbols:.*$/m,
      '- Project files and symbols: the task service and execution modules',
    );
    expect(validatePackage({ implementationModelMarkdown: abstractFiles }).errors).toEqual(
      expect.arrayContaining([
        'implementation_model.md IMP-001 must map to concrete project files and symbols.',
      ]),
    );
  });

  it('requires FUN-* to be covered by a task (prompt must list FUN/STATE/LANG as referenceable)', () => {
    // Regression: the validator requires every FUN/STATE/LANG to be covered by a task
    // and every implementation task to cite FUN-*/LANG-*, but the tasks prompt used to
    // omit FUN/STATE/LANG from the referenceable-ID list.
    const tasksWithoutFun = tasksMarkdown.replace('FUN-001, ', '');
    const result = validateAutocodeStandardDesignArtifacts({
      ...buildV5Package(),
      designReviewMarkdown: reviewMarkdown,
      tasksMarkdown: tasksWithoutFun,
    });
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('function FUN-001 is not covered by any executable task'),
      ]),
    );
  });

  it('requires IMP Design mapping to reference SYS-*, DES-*, and FLOW-*/CONTRACT-* (prompt must declare it)', () => {
    const missingRefs = implementationModelMarkdown.replace(
      '- Design mapping: SYS-001, DES-001, STATE-001, FLOW-001',
      '- Design mapping: DES-001',
    );
    expect(validatePackage({ implementationModelMarkdown: missingRefs }).errors).toEqual(
      expect.arrayContaining([
        'implementation_model.md IMP-001 Design mapping must reference SYS-*, DES-*, and FLOW-*/CONTRACT-* IDs.',
      ]),
    );
  });

  it('requires IMP Class realization to reference a DES-* (prompt must declare it)', () => {
    const noDesRef = implementationModelMarkdown.replace(
      '- Class realization: DES-001 -> apps/desktop/src/main/task-execution.ts#TaskExecution',
      '- Class realization: the task execution class in apps/desktop/src/main/task-execution.ts',
    );
    expect(validatePackage({ implementationModelMarkdown: noDesRef }).errors).toEqual(
      expect.arrayContaining([
        'implementation_model.md IMP-001 Class realization must reference at least one DES-*.',
      ]),
    );
  });

  it('requires direction LR in the domain class diagram (prompt must declare it)', () => {
    // Regression: the validator enforces `direction LR` but the prompt previously
    // never mentioned it, so generated domain_model.md failed the layout check.
    const noDirection = domainModelMarkdown.replace('    direction LR\n', '');
    expect(validatePackage({ domainModelMarkdown: noDirection }).errors).toEqual(
      expect.arrayContaining([
        'domain_model.md Domain Class Diagram must use direction LR for a readable relationship layout.',
      ]),
    );
  });

  it('rejects software methods in the domain class diagram', () => {
    const withMethod = domainModelMarkdown.replace(
      '        rejectionReason\n',
      '        rejectionReason\n        submitDraft()\n',
    );

    expect(validatePackage({ domainModelMarkdown: withMethod }).errors).toContain(
      'domain_model.md Domain Class Diagram must not define software methods.',
    );
  });

  it('rejects software access modifiers in the domain class diagram', () => {
    const withVisibility = domainModelMarkdown.replace(
      '        rejectionReason\n',
      '        +rejectionReason\n',
    );

    expect(validatePackage({ domainModelMarkdown: withVisibility }).errors).toContain(
      'domain_model.md Domain Class Diagram must not define software access modifiers.',
    );
  });

  it('requires labeled domain boxes with concept-kind stereotypes and left-to-right layout', () => {
    const malformed = domainModelMarkdown
      .replace('    direction LR\n', '')
      .replace('    class DOM_001["Task"] {', '    class DOM_001 {')
      .replace('        <<entity>>\n', '');

    expect(validatePackage({ domainModelMarkdown: malformed }).errors).toEqual(
      expect.arrayContaining([
        'domain_model.md Domain Class Diagram must use direction LR for a readable relationship layout.',
        'domain_model.md Domain Class Diagram DOM-001 must use a localized visible label on its DOM_* alias.',
        'domain_model.md Domain Class Diagram DOM-001 must show the <<entity>> concept-kind stereotype.',
      ]),
    );
  });

  it('requires multiplicity at both ends of domain associations', () => {
    const relatedConcept = `
### DOM-002 Project member
- Concept kind: role
- Noun sources: RM-001
- Business meaning: the business role that submits a task
- Attributes: memberId: stable business identity
- Identity: memberId identifies one project member
- Rules and invariants: one member may submit multiple tasks
- Lifecycle states: none - the use case does not define a member lifecycle
- Relationships: DOM-002 submits DOM-001
- Related use cases: RM-001
- Evidence basis: requirement - requirement_model.md RM-001
`;
    const withoutMultiplicity = domainModelMarkdown
      .replace('\n## Domain Class Diagram', `\n${relatedConcept}\n## Domain Class Diagram`)
      .replace(
        '        rejectionReason\n    }\n',
        [
          '        rejectionReason',
          '    }',
          '    class DOM_002["Project member"] {',
          '        <<role>>',
          '        memberId',
          '    }',
          '    DOM_002 --> DOM_001 : submits',
          '',
        ].join('\n'),
      );

    expect(validatePackage({ domainModelMarkdown: withoutMultiplicity }).errors).toContain(
      'domain_model.md Domain Class Diagram association, aggregation, or composition must show quoted multiplicity at both ends.',
    );
  });

  it('requires domain mappings to be summarized explicitly', () => {
    const missingSummary = designModelMarkdown.replace(
      '- Mapped concepts: DOM-001 -> DES-001 because task identity, attributes, and invariants require one state owner',
      '- Mapped concepts: none - no concepts listed',
    );

    expect(validatePackage({ designModelMarkdown: missingSummary }).errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('DES-001 mapping must also appear in the Mapped concepts summary.'),
      ]),
    );
  });

  it('requires all five SOLID decisions', () => {
    const missingDip = designModelMarkdown.replace(
      '; DIP=n/a - the existing persistence port already isolates the mechanism',
      '',
    );

    expect(validatePackage({ designModelMarkdown: missingDip }).errors).toContain(
      'design_model.md DES-001 SOLID rationale must define exactly one DIP=... assignment.',
    );
  });

  it('requires a STATE diagram for every stateful design element', () => {
    const withoutState = removeRange(
      designModelMarkdown,
      '### STATE-001 Task submission lifecycle',
      '## Sequence Diagrams',
    );

    expect(validatePackage({ designModelMarkdown: withoutState }).errors).toContain(
      'design_model.md stateful element DES-001 must own a STATE-* diagram.',
    );
  });

  it('requires FLOW entries to contain Mermaid sequence diagrams', () => {
    const withoutSequence = designModelMarkdown.replace(
      'sequenceDiagram\n    participant Service as SYS-001',
      'flowchart TD\n    participant Service as SYS-001',
    );

    expect(validatePackage({ designModelMarkdown: withoutSequence }).errors).toContain(
      'design_model.md FLOW-001 must contain a Mermaid sequenceDiagram.',
    );
  });

  it('requires every implementation entry to apply a LANG constraint', () => {
    const withoutLanguage = implementationModelMarkdown.replace(
      '- Coding constraints: LANG-001',
      '- Coding constraints: none - no coding constraints selected',
    );

    expect(validatePackage({ implementationModelMarkdown: withoutLanguage }).errors).toContain(
      'implementation_model.md IMP-001 Coding constraints must reference at least one LANG-*.',
    );
  });

  it('rejects a broken end-to-end traceability order', () => {
    const broken = designMarkdown.replace(
      'RM-001 -> FUN-001 -> SSD-001 -> DOM-001',
      'DOM-001 -> RM-001 -> FUN-001 -> SSD-001',
    );

    expect(validatePackage({ designMarkdown: broken }).errors).toEqual(
      expect.arrayContaining([expect.stringContaining('in that order')]),
    );
  });

  it('requires executable tasks to reference FUN and LANG entries', () => {
    const incompleteTasks = tasksMarkdown
      .replace('FUN-001, ', '')
      .replace('LANG-001, ', '');
    const errors = validateAutocodeTaskDesignReferences(
      incompleteTasks,
      buildAutocodeDesignPackageMarkdown(buildV5Package()),
    );

    expect(errors).toEqual(expect.arrayContaining([
      'tasks.md task 1.1 references implementation work but omits its FUN-* capability.',
      'tasks.md task 1.1 references implementation work but omits its LANG-* coding constraints.',
    ]));
  });

  it('does not let a parent task borrow a nested child task _Design_ metadata', () => {
    // Regression: the block scan collected nested child-task lines, so a parent
    // task without its own _Design:_ silently borrowed a child's references and
    // escaped the missing-metadata check. The parent must report its own gap while
    // the child still contributes its references for coverage.
    const nestedTasks = [
      '# Tasks',
      '',
      '- [ ] 1. Task submission',
      '  - [ ] 1.1 Group without its own design',
      '    - _Requirements: R-001, AC-001_',
      '    - [ ] 1.1.1 Leaf with design',
      '      - _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_',
      '      - _Requirements: R-001, AC-001_',
      '      - _Evidence: requirements.md R-001 and apps/desktop/src/main/task-service.ts_',
      '      - _Done when: valid tasks submit and rejected tasks preserve draft state_',
      '      - _Verification: focused unit tests, service tests, typecheck, and desktop build_',
      '',
    ].join('\n');
    const errors = validateAutocodeTaskDesignReferences(
      nestedTasks,
      buildAutocodeDesignPackageMarkdown(buildV5Package()),
    );

    expect(errors).toEqual(
      expect.arrayContaining(['tasks.md task 1.1 missing _Design: ..._ metadata.']),
    );
    // The child's references still satisfy coverage, so no "not covered" errors fire.
    expect(errors).not.toEqual(
      expect.arrayContaining([expect.stringContaining('is not covered by any executable task')]),
    );
  });

  it('requires Chinese review prose for a Chinese task', () => {
    expect(validateAutocodeStandardDesignArtifacts({
      ...buildV5Package(),
      designReviewMarkdown: reviewMarkdown,
      language: 'zh-CN',
      requireTaskReferences: false,
    }).errors).toContain(
      'design_review.md review prose must use Simplified Chinese for language zh-CN. Keep only the required Status token and technical identifiers in English.',
    );

    expect(validateAutocodeStandardDesignArtifacts({
      ...buildV5Package(),
      designReviewMarkdown: 'Status: PASSED\n\n\u8bbe\u8ba1\u8bc1\u636e\u5145\u5206\uff0c\u804c\u8d23\u8fb9\u754c\u6e05\u6670\uff0c\u4e14\u6ca1\u6709\u8fc7\u5ea6\u8bbe\u8ba1\u3002',
      language: 'zh-CN',
      requireTaskReferences: false,
    }).errors).toEqual([]);
  });

  it('emits a v5-only repair prompt and machine contract', () => {
    const retryPrompt = buildAutocodeDesignQualityRetryPrompt([
      'design.md must declare Design-Contract: 5; older design contracts are unsupported.',
      'Design-Contract: 5 package must define at least one LANG-* section.',
    ]);

    expect(retryPrompt).toContain('Use Design-Contract: 5 across design.md and all four model files');
    expect(retryPrompt).toContain('### LANG-001 <localized language/toolchain title>');
    expect(retryPrompt).not.toContain('Design-Contract: 3');
    expect(retryPrompt).not.toContain('Design-Contract: 4');
    expect(AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT).toContain('Design-Contract: 5');
    // Candidate 5: the Traceability contract must declare a single ordered line with
    // -> arrows in the exact left-to-right order the validator enforces, otherwise
    // generators emit unordered or multi-line chains that fail deterministic parsing.
    expect(AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT).toContain(
      'RM-* -> FUN-* -> SSD-* -> DOM-* -> ADR-* -> SYS-* -> DES-* -> STATE-*/FLOW-*/CONTRACT-* -> LANG-* -> IMP-*',
    );
    expect(AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT).toContain(
      'design_model.md must also contain exactly ## Source Reconstruction',
    );
    expect(AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT).not.toContain('Design-Contract: 4');
  });

  it('declares code-quality precision guidance in the machine contract', () => {
    // These contract refinements shape generation toward code the coder can implement
    // with fewer guesses: typed attributes/signatures, per-element testability and
    // failure semantics, quality-attribute realization, and end-to-end error coverage.
    const contract = AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT;
    // 1 + 6: typed attributes and precise public-operation signatures.
    expect(contract).toContain('Attributes (list each as name: type; constraint');
    expect(contract).toContain('Attribute mapping (map each as domainAttr -> visibility name: type; constraint');
    expect(contract).toContain('write each as name(param: type, ...): returnType with a one-line precondition and postcondition');
    // 1: typed contract inputs/outputs.
    expect(contract).toContain('Inputs and outputs (typed signatures with nullability and value constraints)');
    // 2 + 3 + 5: observable outcomes, owned invariants/errors, and NFR realization on DES.
    expect(contract).toContain('the observable outcome a test can assert');
    expect(contract).toContain('state the invariants this element always upholds, the errors or edge cases it owns');
    // 2 + 5: verification asserts invariants, exception flows, and quality attributes.
    expect(contract).toContain('name focused tests that assert each owned invariant, every RM alternate and exception flow');
    // 4: end-to-end error/edge coverage invariant (no happy-path-only designs).
    expect(contract).toContain('Every RM Alternate and exception flow is realized by a FLOW Failure paths entry or a CONTRACT Errors entry');
    // Alignment: the validator requires the RM "Use case value" to start with Why=, so the
    // contract must show that exact format instead of a plain field name.
    expect(contract).toContain('Use case value=Why=');
  });

  it('fingerprints the full five-artifact package deterministically', () => {
    expect(getAutocodeDesignPackageFingerprint(buildV5Package())).toHaveLength(64);
    expect(getAutocodeDesignPackageFingerprint(buildV5Package()))
      .toBe(getAutocodeDesignPackageFingerprint({ ...buildV5Package() }));
  });
});

describe('design review human-input gate detection', () => {
  const reviseWithUnresolved = [
    'Status: REVISE',
    '',
    '## 阻塞发现',
    '',
    '### BR-002 Q1/Q2 仍是实现硬门',
    '- Impacted design IDs: DES-004, DES-006',
    '- Evidence: unresolved - requirements.md Q1 尚未批准七种方块的精确布局；observed - IMP-005 不能形成旋转期望；inferred - 终点未闭合。',
    '- Simplest project-consistent correction: 先按 Q1/Q2 的人工确认路径批准一套规则。',
    '',
    '### BR-006 SevenBag 组合点矛盾',
    '- Evidence: observed - ADR-002 与 DES-011 冲突；unresolved - requirements.md Q2 尚未批准下落间隔初值与逐级函数。',
  ].join('\n');

  it('flags a REVISE review with provenance-level unresolved evidence', () => {
    const gate = detectAutocodeDesignReviewHumanInputGate(reviseWithUnresolved);
    expect(gate.blocked).toBe(true);
    expect(gate.questions).toHaveLength(2);
    expect(gate.questions[0]).toContain('requirements.md Q1');
    expect(gate.questions[1]).toContain('requirements.md Q2');
    expect(gate.decisions).toEqual([]);
    expect(gate.message).toContain('require a human decision');
    expect(gate.message).toContain('re-run planning');
  });

  it('does not flag a PASSED review', () => {
    const passed = 'Status: PASSED\n\nThe package is coherent.\n- Evidence: unresolved - stale example';
    expect(detectAutocodeDesignReviewHumanInputGate(passed).blocked).toBe(false);
  });

  it('does not flag a REVISE review whose findings are all fixable defects', () => {
    const fixableOnly = [
      'Status: REVISE',
      '### BR-006 SevenBag 矛盾',
      '- Evidence: observed - ADR-002 与 DES-011 冲突；inferred - 对象图不一致。',
    ].join('\n');
    expect(detectAutocodeDesignReviewHumanInputGate(fixableOnly).blocked).toBe(false);
  });

  it('does not treat negated or automatically repairable unresolved prose as human input', () => {
    const automaticRevision = [
      'Status: REVISE',
      '',
      '所有阻塞项均可依据现有需求与项目证据自动修订，不涉及只能由人工决定的 unresolved - open question。',
      '',
      '### DR-003 profile 资产载体与公共支撑类型预算没有闭合',
      '- Evidence:',
      '  - observed - LANG-001 明确保留 unresolved - `EDragonInteractionShape`、`EDragonPartEventType` 等类型究竟属于支撑类型还是额外公共契约。',
      '- Simplest project-consistent correction: 在上游明确配置载体并统一类型预算。',
    ].join('\n');
    const gate = detectAutocodeDesignReviewHumanInputGate(automaticRevision);
    expect(gate.blocked).toBe(false);
    expect(gate.questions).toEqual([]);
    expect(gate.decisions).toEqual([]);
  });

  it('ignores unresolved - none placeholders and deduplicates questions', () => {
    const withNone = [
      'Status: REVISE',
      '- Evidence: unresolved - none',
      '- Evidence: unresolved - requirements.md Q1 布局待批准',
      '- Evidence: unresolved - requirements.md Q1 布局待批准',
    ].join('\n');
    const gate = detectAutocodeDesignReviewHumanInputGate(withNone);
    expect(gate.blocked).toBe(true);
    expect(gate.questions).toEqual(['requirements.md Q1 布局待批准']);
  });

  it('handles missing input safely', () => {
    expect(detectAutocodeDesignReviewHumanInputGate(undefined).blocked).toBe(false);
    expect(detectAutocodeDesignReviewHumanInputGate('').blocked).toBe(false);
  });

  it('parses the Human Decision Options section into selectable decisions', () => {
    const withOptions = [
      'Status: REVISE',
      '### BR-002 Q1 待批准',
      '- Evidence: unresolved - requirements.md Q1 尚未批准七种方块的精确布局。',
      '- Evidence: unresolved - requirements.md Q2 尚未批准下落间隔初值与逐级函数。',
      '',
      '## Human Decision Options',
      '',
      '### HQ-001 是否规定精确旋转布局与水平修正偏移？',
      '- Option A (recommended): 采用标准 SRS 出生布局与 [0,-1,+1,-2,+2] 水平修正顺序。',
      '- Option B: 保持当前假设 A3，仅尝试相邻一格水平修正。',
      '',
      '### HQ-002 初始下落间隔与逐级变化如何取值？',
      '- Option A: 初始 1000ms，每级乘 0.85，最小 100ms。',
      '- Option B (recommended): 初始 800ms，每级减 60ms，最小 120ms。',
    ].join('\n');
    const gate = detectAutocodeDesignReviewHumanInputGate(withOptions);
    expect(gate.blocked).toBe(true);
    expect(gate.questions[0]).toContain('requirements.md Q1');
    expect(gate.questions[1]).toContain('requirements.md Q2');
    expect(gate.message).toContain('require a human decision');
    expect(gate.message).toContain('re-run planning');
    expect(gate.decisions).toHaveLength(2);
    expect(gate.decisions[0].id).toBe('HQ-001');
    expect(gate.decisions[0].options).toHaveLength(2);
    expect(gate.decisions[0].options[0].recommended).toBe(true);
    expect(gate.decisions[0].options[1].recommended).toBe(false);
    // The recommended flag follows the review even when it is not the first option.
    expect(gate.decisions[1].options.find((option) => option.recommended)?.id).toBe('B');
  });

  it('keeps plain questions as a fallback when the review omits decision options', () => {
    const gate = detectAutocodeDesignReviewHumanInputGate(reviseWithUnresolved);
    expect(gate.blocked).toBe(true);
    expect(gate.decisions).toEqual([]);
  });

  it('defaults the first option to recommended when the review marks none', () => {
    const noRecommended = [
      'Status: REVISE',
      '- Evidence: unresolved - requirements.md Q1 待批准。',
      '',
      '## Human Decision Options',
      '### HQ-001 采用哪种布局？',
      '- Option A: 方案甲。',
      '- Option B: 方案乙。',
    ].join('\n');
    const gate = detectAutocodeDesignReviewHumanInputGate(noRecommended);
    expect(gate.decisions[0].options[0].recommended).toBe(true);
    expect(gate.decisions[0].options[1].recommended).toBe(false);
  });
});

describe('detectAutocodeRequirementsBlockingGate', () => {
  it('flags open questions tagged as implementation-blocking', () => {
    const requirements = [
      '## Open Questions',
      '- Q1: 是否需要规定精确旋转布局与水平修正偏移？ [BLOCKS-IMPLEMENTATION]',
      '- Q2: 初始下落间隔与逐级函数如何取值？ [BLOCKS-IMPLEMENTATION]',
      '- Q3: 是否为软降提供额外分数？当前按 A4 处理。',
    ].join('\n');
    const gate = detectAutocodeRequirementsBlockingGate(requirements);
    expect(gate.blocked).toBe(true);
    expect(gate.questions).toHaveLength(2);
    // The Q-id is preserved (so write-back can locate the line) and the token is stripped.
    expect(gate.questions[0]).toContain('Q1');
    expect(gate.questions[0]).not.toContain('[BLOCKS-IMPLEMENTATION]');
    expect(gate.message).toContain('block');
  });

  it('does not flag untagged or resolved open questions', () => {
    const requirements = [
      '## Open Questions',
      '- Q1: 可延后的问题，按假设处理。',
      '- Q2: 已批准 [RESOLVED] 采用当前假设。',
    ].join('\n');
    expect(detectAutocodeRequirementsBlockingGate(requirements).blocked).toBe(false);
  });

  it('handles missing input safely', () => {
    expect(detectAutocodeRequirementsBlockingGate(undefined).blocked).toBe(false);
    expect(detectAutocodeRequirementsBlockingGate('').blocked).toBe(false);
  });
});

describe('machine contract prompt stays aligned with the validator', () => {
  const prompt = AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT;

  it('instructs the DES field labels the validator actually requires', () => {
    // Regression: the prompt previously told the model to emit "- DES Element:" and
    // "- DES Role stereotype:", but getMachineReadableField only matches "- Element:"
    // and "- Role stereotype:", so every generated design_model.md failed validation.
    expect(prompt).toContain('- Element: ');
    expect(prompt).toContain('- Role stereotype: ');
    expect(prompt).not.toContain('- DES Element:');
    expect(prompt).not.toContain('- DES Role stereotype:');
  });

  it('forbids citing transient planning artifacts as observed evidence', () => {
    // Break the self-perpetuating loop where the design cites design_review.md findings or
    // stale planning-transaction.json state as observed facts, which never validate because
    // the review is rolled back each run.
    expect(prompt).toContain('Never cite design_review.md, planning-transaction.json, or other transient planning or runner artifacts as observed facts');
  });

  it('requires cross-model consistency binding and a pre-finalize self-check', () => {
    // Reduce cross-model drift (e.g. RM/DOM/DES contradictions): each fact has one owner,
    // downstream references IDs instead of restating, conflicts are recorded as unresolved
    // rather than forked, and each stage self-checks its references before finalizing.
    expect(prompt).toContain('Cross-model consistency and self-check');
    expect(prompt).toContain('never restate, re-derive, or redefine an upstream fact');
    expect(prompt).toContain('Never fork a contradictory value');
    expect(prompt).toContain('self-check that every referenced upstream ID exists');
  });

  it('tells the model each model file uses its own title, not # Design:', () => {
    // Regression: the model reused "# Design:" for design_model.md, but the model-file
    // identity check requires "# Design Model:" (contract.title).
    expect(prompt).toContain('# Requirement Model: ');
    expect(prompt).toContain('# Domain Model: ');
    expect(prompt).toContain('# Design Model: ');
    expect(prompt).toContain('# Implementation Model: ');
  });

  it('requires ASCII-semicolon separated SOLID assignments', () => {
    // Regression: the model used full-width separators, so validateDimensionAssignments
    // (which splits on ASCII ";") could not find the OCP/LSP/ISP/DIP assignments.
    expect(prompt).toContain('SRP=...; OCP=...; LSP=...; ISP=...; DIP=...');
  });

  it('requires ASCII separators for Scenario and 5W1H dimensions', () => {
    // Regression: Scenario (Who/Where/When) and 5W1H (Who/What/Why/When/Where/How)
    // are validated with validateDimensionAssignments, which splits on ASCII ";".
    expect(prompt).toContain(
      'Scenario and 5W1H analysis must separate dimensions with ASCII semicolons',
    );
  });

  it('lists design.md and implementation_model.md headings like the other model files', () => {
    // The validator enforces required headings for every artifact; the prompt must
    // declare them for design.md and implementation_model.md too (previously only
    // requirement_model/domain_model/design_model headings were listed).
    expect(prompt).toContain('- design.md headings: Scope And Evidence;');
    expect(prompt).toContain(
      '- implementation_model.md headings: Language And Coding Constraints; Implementation Model.',
    );
  });

  it('requires ASCII separators for architecture candidate comparison', () => {
    // Regression: Candidate comparison is split on ASCII ";" (candidates) and "|" (values).
    expect(prompt).toContain(
      'separate candidates with ASCII semicolons and the five values within each candidate with ASCII pipes',
    );
  });

  it('declares the combination constraints for analysis direction and local budget', () => {
    // Regression: the validator enforces direction/source pairings and local-depth budget.
    expect(prompt).toContain('forward-design uses requirement or mixed (never source alone)');
    expect(prompt).toContain('mixed analysis must use mixed');
    expect(prompt).toContain('At local depth, keep New dependencies allowed: 0 and New architectural patterns: none');
  });

  it('declares PAT machine fields and balanced pattern-application guidance', () => {
    // Quality: PAT fields were never declared in the contract, so selected patterns
    // had no field template; also give positive guidance to apply a fitting pattern
    // for real variations while keeping NOP for none.
    expect(prompt).toContain('name the applicable GoF or architectural pattern');
    expect(prompt).toContain('Pattern application balances NOP');
    expect(prompt).toContain('- PAT (define one per Selected pattern');
    expect(prompt).toContain('Cost and failure modes');
  });

  it('declares the domain class diagram direction LR requirement', () => {
    // Regression: the validator enforces `direction LR` for the domain classDiagram.
    expect(prompt).toContain('Start the classDiagram body with direction LR');
  });

  it('requires localized prose to read naturally and idiomatically', () => {
    // Quality: prevents machine-translated / word-for-word localized descriptions.
    expect(prompt).toContain('natural, fluent, idiomatic technical writing');
    expect(prompt).toContain('not word-for-word translation');
  });

  it('embeds copyable SSD and domain classDiagram skeletons in the initial contract', () => {
    // Quality: give the model the exact diagram shapes up front so requirement_model
    // and domain_model pass on the first attempt instead of failing then repairing.
    expect(prompt).toContain('User->>+System:');
    expect(prompt).toContain('System-->>-User:');
    expect(prompt).toContain('class DOM_001["<localized label>"]');
    expect(prompt).toContain('[*] --> <InitialState>');
  });

  it('declares the stateless State Transition Diagrams none-reason rule', () => {
    // Regression: the validator requires a stateless design to record `none - <reason>`
    // under State Transition Diagrams; the prompt must declare that.
    expect(prompt).toContain('write "none - <reason>" under the State Transition Diagrams heading');
  });

  it('declares that IMP Class realization references DES-* and LANG cites a version', () => {
    // Regression: the validator requires Class realization to reference DES-* and
    // Language and version to include a concrete version number.
    expect(prompt).toContain('Class realization=DES-*');
    expect(prompt).toContain('Language and version=<observed language and a concrete version number>');
  });

  it('declares that IMP Design mapping references SYS-*, DES-*, and FLOW-*/CONTRACT-*', () => {
    // Regression: the validator requires Design mapping to reference SYS-*, DES-*,
    // and FLOW-*/CONTRACT-* IDs.
    expect(prompt).toContain('Design mapping=SYS-*, DES-*, FLOW-*/CONTRACT-*');
  });

  it('declares the reference requirements for DES/DOM/IMP fields', () => {
    // Regression: these fields must reference specific ID kinds / concrete files.
    expect(prompt).toContain('Domain mapping=DOM-* or none - <auxiliary reason>');
    expect(prompt).toContain('Method derivation=RM-*/FUN-*/SSD-* verbs');
    expect(prompt).toContain('Related use cases=RM-*');
    expect(prompt).toContain('Project files and symbols=<path/to/file#symbol>');
  });

  it('produces a design_model.md that passes validation when the contract is followed', () => {
    // designModelMarkdown mirrors the machine contract labels; it must validate cleanly.
    const stageErrors = validateAutocodeStandardDesignStageArtifacts(
      { requirementModelMarkdown, domainModelMarkdown, designMarkdown, designModelMarkdown },
      'design_model',
    ).errors;

    expect(stageErrors).toEqual([]);
    expect(designModelMarkdown.startsWith('# Design Model:')).toBe(true);
    expect(designModelMarkdown).toContain('\n- Element: class - TaskExecution');
    expect(designModelMarkdown).toContain('\n- Role stereotype: entity');
  });
});

describe('design quality retry prompt targeted repair guidance', () => {
  it('routes Source Reconstruction repair to design_model.md without rewriting design.md', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'design_model.md missing "## Source Reconstruction" section.',
    ]);
    expect(prompt).toContain('Source Reconstruction is owned by design_model.md, never design.md.');
    expect(prompt).toContain('add exactly ## Source Reconstruction to design_model.md');
    expect(prompt).toContain('Preserve design.md ADRs, evidence, and stable IDs.');
  });

  it('injects a Mermaid SSD skeleton when SSD checks fail', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'requirement_model.md SSD-001 SSD must enable Mermaid autonumber so business messages are displayed in order.',
    ]);
    expect(prompt).toContain('Copy these Mermaid shapes exactly');
    expect(prompt).toContain('User->>+System:');
    expect(prompt).toContain('System-->>-User:');
  });

  it('injects a domain classDiagram skeleton when class diagram checks fail', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'domain_model.md Domain Class Diagram must use direction LR for a readable relationship layout.',
    ]);
    expect(prompt).toContain('Copy these Mermaid shapes exactly');
    expect(prompt).toContain('DOM_001["<localized label>"]');
  });

  it('injects a STATE stateDiagram-v2 skeleton when state checks fail', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'design_model.md STATE-001 must contain a Mermaid stateDiagram-v2.',
    ]);
    expect(prompt).toContain('Copy these Mermaid shapes exactly');
    expect(prompt).toContain('[*] --> <InitialState>');
  });

  it('injects ASCII separator examples when dimension/comparison checks fail', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'requirement_model.md RM-001 Scenario must define exactly one Where=... assignment.',
    ]);
    expect(prompt).toContain('never use full-width');
    expect(prompt).toContain('SOLID rationale: SRP=...; OCP=...; LSP=...; ISP=...; DIP=...');
  });

  it('omits diagram and separator guidance for unrelated errors', () => {
    const prompt = buildAutocodeDesignQualityRetryPrompt([
      'design.md must declare Design-Contract: 5.',
    ]);
    expect(prompt).not.toContain('Copy these Mermaid shapes exactly');
    expect(prompt).not.toContain('never use full-width');
  });
});
