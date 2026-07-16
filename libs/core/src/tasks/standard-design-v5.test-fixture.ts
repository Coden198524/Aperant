const fence = '```';

export const designMarkdown = `# Design: Task submission
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

export const requirementModelMarkdown = `# Requirement Model: Task submission
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

export const domainModelMarkdown = `# Domain Model: Task submission
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

export const designModelMarkdown = `# Design Model: Task submission
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

export const implementationModelMarkdown = `# Implementation Model: Task submission
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

export const reviewMarkdown = `Status: PASSED

The complete Design-Contract: 5 package is traceable, cohesive, and proportionate to the verified scope.
`;

export const tasksMarkdown = `# Tasks

- [ ] 1. Task submission
  - [ ] 1.1 Implement and verify task submission
    - _Design: ADR-001, RM-001, FUN-001, SSD-001, DOM-001, SYS-001, DES-001, STATE-001, FLOW-001, LANG-001, IMP-001_
    - _Requirements: R-001, AC-001_
    - _Evidence: requirements.md R-001 and apps/desktop/src/main/task-service.ts_
    - _Done when: valid tasks submit and rejected tasks preserve draft state_
    - _Verification: focused unit tests, service tests, typecheck, and desktop build_
`;

export function buildStandardDesignV5Fixture() {
  return {
    designMarkdown,
    requirementModelMarkdown,
    domainModelMarkdown,
    designModelMarkdown,
    implementationModelMarkdown,
  };
}
