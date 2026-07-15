import { describe, expect, it } from 'vitest';
import {
  AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT,
  buildAutocodeDesignPackageMarkdown,
  buildAutocodeDesignQualityRetryPrompt,
  extractAutocodeDesignReferenceExcerpt,
  getAutocodeDesignReferenceFingerprint,
  getAutocodeDesignPackageFingerprint,
  parseAutocodeDesignSections,
  validateAutocodeStandardDesignArtifacts,
  validateAutocodeStandardDesignStageArtifacts,
  validateAutocodeTaskDesignReferences,
} from './design-quality.js';

const design = `# Design: Focused change
Design-Contract: 3
Design-Depth: local
Design-Revision: 1

## Scope And Evidence
- Analysis direction: forward-design
- Primary source of truth: mixed
- Requirement evidence: requirement - requirements.md R-001 defines the requested command result
- Project evidence: observed - src/main/existing.ts#computeCommandResult owns the current behavior
- Design inferences: none - the cited requirement and source establish the complete local boundary
- Unresolved evidence: none
## Complexity Assessment
- Primary complexity driver: one local behavior with one state invariant
- Business rules and state: the existing task owns its status invariant
- Boundary and contract impact: no public contract changes
- Quality-attribute risks: compatibility with the existing command
- Depth rationale: one existing module and no cross-boundary behavior
## Existing Architecture Fit
Reuse src/main/existing.ts and the existing service/renderer boundary.
## Engineering Adaptation
- Delivery context: existing-system
- System shape: local-utility
- Project paradigm: mixed
- Paradigm rationale: preserve the existing TypeScript service and renderer split
- Object-model applicability: low
- Object-model rationale: one existing calculation has no independent object lifecycle
- Existing boundaries to preserve: src/main/existing.ts service boundary
- Existing patterns to reuse: src/main/existing.ts command handler
- Language/framework constraints: TypeScript and the existing bridge contract
- Integration and test seams: src/main/existing.test.ts focused service test
## Design Budget
- Expected modules changed: 2
- New modules allowed: 0
- New public contracts allowed: 0
- New dependencies allowed: 0
- New architectural patterns: none
## Architecture Decision
### ADR-001 Preserve the existing boundary
- Decision: preserve the current renderer-to-bridge-to-service dependency direction
- Status: accepted
- Decision drivers: RM-001 changes one result while compatibility remains required
- Alternatives considered: splitting the flow across additional boundaries was rejected as unnecessary
- Trade-offs: minimal change radius at the cost of retaining the existing synchronous boundary
- Evidence basis: requirement - requirements.md R-001; observed - src/main/existing.ts#computeCommandResult
## Requirement Model
### RM-001 Update behavior
- Actor and goal: the user invokes the command to obtain the updated result
- Business context: Who=user; What=request updated result; Why=complete the requested workflow; When=existing command invocation; Where=renderer command surface; How=invoke the established command
- Trigger and preconditions: the existing command is available
- Normal flow: invoke the command, compute the result, and display it
- Alternate or failure flow: preserve the existing error response
- Outcome: the updated result is visible
- Constraints: keep the existing bridge contract compatible
- Quality constraints: Compatibility=existing bridge contract; Reliability=preserve existing error behavior
- Evidence basis: requirement - requirements.md R-001
## Domain Model
### DOM-001 Task state
- Concept kind: entity
- Business meaning: current execution status of the task
- Identity and state: task identity and current supported status
- Behavior: accept valid status transitions and expose the current value
- Responsibilities: validate and expose the current status
- Rules and invariants: only supported status transitions are accepted
- Ownership and lifecycle: the existing task owns status for its lifecycle
- Relationships: the command reads the task status
- Software mapping: existing - src/main/existing.ts task state
- Evidence basis: observed - src/main/existing.ts#TaskState
## System Responsibility Allocation
### SYS-001 Existing command boundary
- Subsystem or boundary: renderer-to-bridge-to-service command path
- Allocated requirements: RM-001
- Owns: command result calculation and current error semantics
- Provides: compatible command response to the renderer
- Requires: DOM-001 current task status through the existing bridge
- Data and control boundary: renderer initiates control; the service returns result data through the bridge
- Failure ownership: DES-001 preserves and returns existing service failures
- Evidence basis: observed - src/main/existing.ts#computeCommandResult
## Design Model
### DES-001 Existing service responsibility
- Element: module - existing service
- System allocation: SYS-001
- Role stereotype: module
- Owned state: none; reads DOM-001 state
- Public operations: computeCommandResult
- Responsibilities: compute the command result
- Collaborators: existing bridge and renderer
- Dependencies: current task state
- Encapsulation boundary: private result computation
- Does not own: rendering or bridge transport
- Evidence basis: observed - src/main/existing.ts#computeCommandResult
### FLOW-001 Command flow
- Trigger: renderer invokes the command
- Participants: DES-001
- Steps: DES-001 reads DOM-001, computes the command result, and returns it through the existing bridge
- State changes: none
- Failure paths: preserve the existing service error
- Evidence basis: observed - src/main/existing.ts#computeCommandResult
## Change And Pattern Analysis
- Verified variation points: none
- Variation inventory: none
- Candidate patterns evaluated: none
- Simplest change mechanism: edit the existing result computation
- Selected patterns: none
## Implementation Model
### IMP-001 Focused implementation
- Project files and symbols: src/main/existing.ts result handler; src/main/existing.test.ts
- Design mapping: implements SYS-001, DES-001, and FLOW-001
- Integration constraints: preserve the existing bridge contract
- Verification: run the focused service test
- Evidence basis: observed - src/main/existing.ts#computeCommandResult
## Applicable Design Principles
- Cohesion decision: keep result calculation in the existing cohesive service
- Coupling and dependency decision: preserve renderer to bridge to service direction
- Encapsulation decision: keep result computation private to DES-001
- SOLID trade-offs: SRP applies; no new interface is justified
- Underdesign checks: DES-001 owns one calculation and is not a generic coordinator
## Rejected Complexity
- Reject a new event bus because this is a synchronous local flow.
## Risks And Evolution
The existing contract must remain compatible.
## Traceability
- RM-001 -> ADR-001 -> DOM-001 -> SYS-001 -> DES-001 -> FLOW-001 -> IMP-001
`;

const review = `Status: PASSED

The design is evidence-backed and remains within its local budget.
`;

const tasks = `# Implementation Plan

- [ ] 1. Implement

  - [ ] 1.1 Update existing service behavior
    - _Design: ADR-001, SYS-001, DES-001, FLOW-001, IMP-001_
    - _Requirements: R-001_
    - _Evidence: requirements.md and src/main/existing.ts_
    - _Done when: the existing command returns the expected result_
`;

function sectionRange(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : source.length;
  return source.slice(startIndex, endIndex < 0 ? source.length : endIndex).trim();
}

function buildV4Package(source = design) {
  const preArchitecture = source
    .slice(0, source.indexOf('## Architecture Decision'))
    .replace('Design-Contract: 3', 'Design-Contract: 4')
    .trim();
  const architectureDecision = sectionRange(source, '## Architecture Decision', '## Requirement Model');
  const changeAnalysis = sectionRange(source, '## Change And Pattern Analysis', '## Implementation Model');
  const closingSections = sectionRange(source, '## Applicable Design Principles');
  const designMarkdown = [
    preArchitecture,
    '## Architecture Candidates',
    '- Architecture baseline: preserve the observed renderer-to-bridge-to-service boundary',
    '- Candidate count: 1',
    '- Candidate comparison: existing boundary | exact fit | smallest radius | retains synchronous coupling | low migration risk',
    '- Selected architecture: existing renderer-to-bridge-to-service boundary',
    '- Selection rationale: observed project ownership and local scope make the current boundary the smallest complete choice',
    '- Rejected alternatives: new service layer rejected because it adds a boundary without a current variation',
    '- Evolution trigger: multiple independent result policies or an external transport requirement',
    architectureDecision,
    '## Model Package',
    '- Requirement model: requirement_model.md',
    '- Domain model: domain_model.md',
    '- Design model: design_model.md',
    '- Implementation model: implementation_model.md',
    changeAnalysis,
    closingSections,
  ].join('\n');
  const modelDocument = (title: string, kind: string, body: string) => [
    '# ' + title + ': Focused change',
    'Design-Contract: 4',
    'Design-Revision: 1',
    'Design-Root: design.md',
    'Model-Kind: ' + kind,
    '',
    body,
  ].join('\n');
  return {
    designMarkdown,
    requirementModelMarkdown: modelDocument(
      'Requirement Model',
      'requirement',
      sectionRange(source, '## Requirement Model', '## Domain Model'),
    ),
    domainModelMarkdown: modelDocument(
      'Domain Model',
      'domain',
      sectionRange(source, '## Domain Model', '## System Responsibility Allocation'),
    ),
    designModelMarkdown: modelDocument(
      'Design Model',
      'design',
      sectionRange(source, '## System Responsibility Allocation', '## Change And Pattern Analysis'),
    ),
    implementationModelMarkdown: modelDocument(
      'Implementation Model',
      'implementation',
      sectionRange(source, '## Implementation Model', '## Applicable Design Principles'),
    ),
  };
}

const tankDesign = design
  .replace('# Design: Focused change', '# Design: Interactive Tank Battle')
  .replace('Design-Depth: local', 'Design-Depth: standard')
  .replace('- Requirement evidence: requirement - requirements.md R-001 defines the requested command result', '- Requirement evidence: requirement - requirements.md R-001 defines the complete interactive battle lifecycle')
  .replace('- Project evidence: observed - src/main/existing.ts#computeCommandResult owns the current behavior', '- Project evidence: observed - project docs define the runtime and rendering boundary')
  .replace('- Design inferences: none - the cited requirement and source establish the complete local boundary', '- Design inferences: inferred - behavior-rich elements fit independent battle lifecycles and rules')
  .replace('- Delivery context: existing-system', '- Delivery context: greenfield')
  .replace('- System shape: local-utility', '- System shape: interactive-simulation')
  .replace('- Project paradigm: mixed', '- Project paradigm: object-oriented')
  .replace('- Paradigm rationale: preserve the existing TypeScript service and renderer split', '- Paradigm rationale: behavior-rich elements own gameplay state and rules while the renderer remains a boundary')
  .replace('- Object-model applicability: low', '- Object-model applicability: high')
  .replace('- Object-model rationale: one existing calculation has no independent object lifecycle', '- Object-model rationale: tanks, projectiles, policies, and battle states have distinct behavior and lifecycles')
  .replace('- Existing boundaries to preserve: src/main/existing.ts service boundary', '- Existing boundaries to preserve: src/game runtime boundary and the framework-owned renderer')
  .replace('- Existing patterns to reuse: src/main/existing.ts command handler', '- Existing patterns to reuse: project component lifecycle and frame update boundary')
  .replace('- Language/framework constraints: TypeScript and the existing bridge contract', '- Language/framework constraints: project-selected runtime and rendering framework')
  .replace('- Integration and test seams: src/main/existing.test.ts focused service test', '- Integration and test seams: src/game/BattleSession scenario tests and renderer-port tests')
  .replace('- New architectural patterns: none', '- New architectural patterns: PAT-001, PAT-002')
  .replace('### SYS-001 Existing command boundary', '### SYS-001 Battle runtime boundary')
  .replace('- Subsystem or boundary: renderer-to-bridge-to-service command path', '- Subsystem or boundary: deterministic battle runtime behind renderer and input ports')
  .replace('- Owns: command result calculation and current error semantics', '- Owns: battle lifecycle, entity rules, collision outcomes, and score state')
  .replace('- Provides: compatible command response to the renderer', '- Provides: immutable presentation snapshots and accepted input intents')
  .replace('- Requires: DOM-001 current task status through the existing bridge', '- Requires: clock, input, renderer, and level-definition ports')
  .replace('- Data and control boundary: renderer initiates control; the service returns result data through the bridge', '- Data and control boundary: ports supply events and ticks; SYS-001 owns all battle mutation')
  .replace('- Failure ownership: DES-001 preserves and returns existing service failures', '- Failure ownership: SYS-001 rejects invalid intents and preserves a valid battle state')
  .replace('- Element: module - existing service', '- Element: class - Tank')
  .replace('- System allocation: SYS-001', '- System allocation: SYS-001')
  .replace('- Role stereotype: module', '- Role stereotype: entity')
  .replace('- Owned state: none; reads DOM-001 state', '- Owned state: position, direction, health, cooldown')
  .replace('- Public operations: computeCommandResult', '- Public operations: move, fire, receiveHit, update')
  .replace('- Participants: DES-001', '- Participants: DES-001, DES-002, DES-003')
  .replace('- Variation inventory: none', '- Variation inventory: battle states menu/playing/game-over; player and enemy control policies')
  .replace('- Candidate patterns evaluated: none', '- Candidate patterns evaluated: State - selected for behavior-changing battle modes; Strategy - selected for control policies; Observer - rejected because HUD is the only consumer')
  .replace('- Selected patterns: none', [
    '- Selected patterns: PAT-001, PAT-002',
    '### PAT-001 State',
    '- Verified variation: menu, playing, paused, and game-over modes change accepted behavior',
    '- Evidence: requirements.md requires start, pause, resume, and restart behavior',
    '- Expected horizon: all modes are current requirements',
    '- Stable boundary: BattleSession input and update delegation',
    '- Encapsulated variation: mode-specific event handling and transitions',
    '- Participants and roles: DES-002 is context and SYS-001 battle-mode elements are states',
    '- Application scope: battle lifecycle modes only',
    '- Simpler alternative: one switch would mix transition and mode behavior in BattleSession',
    '- Benefit: each mode owns valid behavior and transitions',
    '- Cost and failure modes: transition coverage and one state indirection',
    '### PAT-002 Strategy',
    '- Verified variation: player input and enemy AI produce movement and firing intents',
    '- Evidence: requirements.md requires player and enemy tanks',
    '- Expected horizon: both policies are current requirements',
    '- Stable boundary: Tank consumes one control intent per update',
    '- Encapsulated variation: intent generation policy',
    '- Participants and roles: DES-001 is context; DES-003 player and enemy policies are strategies',
    '- Application scope: tank control intent generation only',
    '- Simpler alternative: type branches in Tank would couple entity rules to input and AI',
    '- Benefit: Tank keeps combat invariants while policies vary independently',
    '- Cost and failure modes: policy lifetime and invalid-intent handling',
  ].join('\n'))
  .replace('### DOM-001 Task state', '### DOM-001 Tank')
  .replace('- Concept kind: entity\n- Business meaning: current execution status of the task', '- Concept kind: entity\n- Business meaning: an armed mobile battle participant')
  .replace('- Identity and state: task identity and current supported status', '- Identity and state: tank identity, position, direction, health, and cooldown')
  .replace('- Behavior: accept valid status transitions and expose the current value', '- Behavior: move, fire, receive damage, and enforce alive/cooldown rules')
  .replace('## Design Model', [
    '### DOM-002 Battle session',
    '- Concept kind: entity',
    '- Business meaning: one battle lifecycle and its current mode',
    '- Identity and state: session identity, mode, score, and remaining enemies',
    '- Behavior: start, pause, resume, finish, and restart',
    '- Responsibilities: enforce battle-mode transitions',
    '- Rules and invariants: simulation advances only while playing',
    '- Ownership and lifecycle: owns one battle from menu through game over',
    '- Relationships: owns tanks and delegates control intent',
    '- Software mapping: new - src/game/BattleSession',
    '- Evidence basis: requirement - requirements.md R-001 battle lifecycle',
    '### DOM-003 Control policy',
    '- Concept kind: policy',
    '- Business meaning: source of movement and fire intent for one tank',
    '- Identity and state: policy type and policy-local timing state',
    '- Behavior: produce a validated control intent',
    '- Responsibilities: decide intent without mutating Tank state',
    '- Rules and invariants: intent remains inside legal direction/action values',
    '- Ownership and lifecycle: attached for the controlled Tank lifetime',
    '- Relationships: consumed by Tank through DES-003',
    '- Software mapping: new - src/game/ControlPolicy',
    '- Evidence basis: requirement - requirements.md R-001 player and enemy control',
    '## Design Model',
  ].join('\n'))
  .replace('### FLOW-001 Command flow', [
    '### DES-002 BattleSession',
    '- Element: class - BattleSession',
    '- System allocation: SYS-001',
    '- Role stereotype: controller',
    '- Owned state: battle mode, score, entity collection',
    '- Public operations: handleInput, update, restart',
    '- Responsibilities: coordinate one frame and lifecycle transitions',
    '- Collaborators: Tank and ControlPolicy',
    '- Dependencies: clock and renderer ports',
    '- Encapsulation boundary: battle lifecycle and entity ownership',
    '- Does not own: tank combat invariants or policy decisions',
    '- Evidence basis: requirement - requirements.md R-001 battle lifecycle',
    '### DES-003 ControlPolicy',
    '- Element: class - ControlPolicy',
    '- System allocation: SYS-001',
    '- Role stereotype: policy',
    '- Owned state: policy-local decision timing',
    '- Public operations: nextIntent',
    '- Responsibilities: create player or enemy control intent',
    '- Collaborators: BattleSession and Tank',
    '- Dependencies: input snapshot or world query',
    '- Encapsulation boundary: intent generation only',
    '- Does not own: movement, health, collision, or score',
    '- Evidence basis: requirement - requirements.md R-001 independent control policies',
    '### FLOW-001 Playing frame',
  ].join('\n'))
  .replace('- Trigger: renderer invokes the command', '- Trigger: a playing frame tick arrives')
  .replace('- Steps: DES-001 reads DOM-001, computes the command result, and returns it through the existing bridge', '- Steps: DES-002 -> DES-003 requests intent; DES-003 -> DES-001 returns intent; DES-001 validates and mutates only tank state; DES-002 resolves collisions and score')
  .replace('- State changes: none', '- State changes: tank position, cooldown, health, and score update through their owners')
  .replace('- Failure paths: preserve the existing service error', '- Failure paths: invalid intent is ignored and destroyed tanks cannot act')
  .replace('## Change And Pattern Analysis', [
    '### FLOW-002 Battle transition',
    '- Trigger: start, pause, game-over, or restart condition occurs',
    '- Participants: DES-002, DES-001',
    '- Steps: DES-002 -> DES-001 validates whether entities may act; DES-002 changes mode and initializes or freezes the collection',
    '- State changes: battle mode and session-owned collections change atomically',
    '- Failure paths: invalid transitions preserve the current mode',
    '- Evidence basis: requirement - requirements.md R-001 start, pause, finish, and restart scenarios',
    '## Change And Pattern Analysis',
  ].join('\n'))
  .replace('- Design mapping: implements SYS-001, DES-001, and FLOW-001', '- Design mapping: implements SYS-001, DES-001, DES-002, DES-003, FLOW-001, and FLOW-002')
  .replace('- RM-001 -> ADR-001 -> DOM-001 -> SYS-001 -> DES-001 -> FLOW-001 -> IMP-001', '- RM-001 -> ADR-001 -> DOM-001 -> DOM-002 -> DOM-003 -> SYS-001 -> DES-001 -> DES-002 -> DES-003 -> FLOW-001 -> FLOW-002 -> PAT-001 -> PAT-002 -> IMP-001');

const zookeeperDesign = design
  .replace('# Design: Focused change', '# Design: ZooKeeper read-path reconstruction')
  .replace('- Analysis direction: forward-design', '- Analysis direction: reverse-engineering')
  .replace('- Primary source of truth: mixed', '- Primary source of truth: source')
  .replace('- Requirement evidence: requirement - requirements.md R-001 defines the requested command result', '- Requirement evidence: none - this analysis reconstructs an observed read capability')
  .replace('- Project evidence: observed - src/main/existing.ts#computeCommandResult owns the current behavior', '- Project evidence: observed - zookeeper-server/src/main/java/org/apache/zookeeper/ZooKeeper.java#exists exposes the client capability')
  .replace('- Design inferences: none - the cited requirement and source establish the complete local boundary', '- Design inferences: inferred - request-processor boundaries explain responsibility handoff until verified by each cited symbol')
  .replace('- Actor and goal: the user invokes the command to obtain the updated result', '- Actor and goal: a ZooKeeper client checks whether a znode exists')
  .replace('- Evidence basis: requirement - requirements.md R-001', '- Evidence basis: observed - zookeeper-server/src/main/java/org/apache/zookeeper/ZooKeeper.java#exists')
  .replace('## Implementation Model', [
    '## Source Reconstruction',
    '### REV-001 Client exists request path',
    '- External capability: RM-001',
    '- Domain concepts: DOM-001',
    '- Responsibility path: SYS-001 -> DES-001',
    '- Runtime path: FLOW-001',
    '- Source symbols: zookeeper-server/src/main/java/org/apache/zookeeper/ZooKeeper.java#exists; zookeeper-server/src/main/java/org/apache/zookeeper/ClientCnxn.java#submitRequest; zookeeper-server/src/main/java/org/apache/zookeeper/server/PrepRequestProcessor.java#processRequest; zookeeper-server/src/main/java/org/apache/zookeeper/server/FinalRequestProcessor.java#processRequest; zookeeper-server/src/main/java/org/apache/zookeeper/server/DataTree.java#getNode',
    '- Contradiction checks: checked - ZooKeeper 3.6.2 overview, internals, and cited source agree on the client-to-server processor path',
    '- Confidence: high - public guarantees and exact 3.6.2 symbols agree',
    '## Implementation Model',
  ].join('\n'))
  .replace('- RM-001 -> ADR-001 -> DOM-001 -> SYS-001 -> DES-001 -> FLOW-001 -> IMP-001', '- RM-001 -> ADR-001 -> DOM-001 -> SYS-001 -> DES-001 -> FLOW-001 -> REV-001 -> IMP-001');

describe('Standard design quality', () => {
  it('accepts a Design-Contract 4 package with four separately owned model files', () => {
    const designPackage = buildV4Package();
    const result = validateAutocodeStandardDesignArtifacts({
      ...designPackage,
      designReviewMarkdown: review,
      tasksMarkdown: tasks,
    });

    expect(result.errors).toEqual([]);
    expect(result.contractVersion).toBe(4);
    expect(result.sections.map((section) => section.id)).toEqual([
      'ADR-001',
      'RM-001',
      'DOM-001',
      'SYS-001',
      'DES-001',
      'FLOW-001',
      'IMP-001',
    ]);
    expect(buildAutocodeDesignPackageMarkdown(designPackage)).toContain('requirement_model.md');
    expect(getAutocodeDesignPackageFingerprint(designPackage)).toHaveLength(64);
  });

  it('validates each v4 model stage before allowing downstream generation', () => {
    const designPackage = buildV4Package();
    expect(validateAutocodeStandardDesignStageArtifacts(
      designPackage,
      'requirement_model',
    ).errors).toEqual([]);
    expect(validateAutocodeStandardDesignStageArtifacts(
      designPackage,
      'design_model',
    ).errors).toEqual([]);
  });

  it('rejects model IDs written into the wrong v4 artifact', () => {
    const designPackage = buildV4Package();
    const result = validateAutocodeStandardDesignArtifacts({
      ...designPackage,
      domainModelMarkdown: designPackage.domainModelMarkdown.replace('DOM-001', 'RM-002'),
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors.some((error) => error.includes('domain_model.md may not define RM-002'))).toBe(true);
  });

  it('rejects shallow architecture candidate comparisons and placeholder decisions', () => {
    const designPackage = buildV4Package();
    const result = validateAutocodeStandardDesignArtifacts({
      ...designPackage,
      designMarkdown: designPackage.designMarkdown
        .replace(
          '- Candidate comparison: existing boundary | exact fit | smallest radius | retains synchronous coupling | low migration risk',
          '- Candidate comparison: current option',
        )
        .replace(
          '- Selection rationale: observed project ownership and local scope make the current boundary the smallest complete choice',
          '- Selection rationale: best',
        )
        .replace(
          '- Evolution trigger: multiple independent result policies or an external transport requirement',
          '- Evolution trigger: as needed',
        ),
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('must use five substantive pipe-delimited values'),
      expect.stringContaining('Selection rationale must be concrete and substantive'),
      expect.stringContaining('Evolution trigger must name observable future evidence'),
    ]));
  });

  it('accepts a compact local design and task traceability', () => {
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: design,
      designReviewMarkdown: review,
      tasksMarkdown: tasks,
    });
    expect(result.errors).toEqual([]);
    expect(result.sections.map((section) => section.id)).toContain('IMP-001');
  });

  it('accepts descriptive ASCII quality-dimension names', () => {
    const qualityDimensions = design.replace(
      '- Quality constraints: Compatibility=existing bridge contract; Reliability=preserve existing error behavior',
      '- Quality constraints: Correctness=invalid transitions have no effect; Consistency=state remains coherent; Clarity=failures remain diagnosable',
    );

    expect(validateAutocodeStandardDesignArtifacts({
      designMarkdown: qualityDimensions,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    }).errors).toEqual([]);
  });

  it('accepts a behavior-rich interactive design with bounded State and Strategy patterns', () => {
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: tankDesign,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.sections.filter((section) => section.kind === 'DES')).toHaveLength(3);
    expect(result.sections.filter((section) => section.kind === 'PAT').map((section) => section.title))
      .toEqual(['State', 'Strategy']);
  });

  it('accepts an outside-in ZooKeeper source reconstruction with exact symbols', () => {
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: zookeeperDesign,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toEqual([]);
    expect(result.analysisDirection).toBe('reverse-engineering');
    expect(result.sections.filter((section) => section.kind === 'REV').map((section) => section.id))
      .toEqual(['REV-001']);
  });

  it('rejects a shallow interactive design that hides all behavior in one manager', () => {
    const shallowTankDesign = design
      .replace('# Design: Focused change', '# Design: Shallow Tank Battle')
      .replace('Design-Depth: local', 'Design-Depth: standard')
      .replace('- Delivery context: existing-system', '- Delivery context: greenfield')
      .replace('- System shape: local-utility', '- System shape: interactive-simulation')
      .replace('- Project paradigm: mixed', '- Project paradigm: object-oriented')
      .replace('- Object-model applicability: low', '- Object-model applicability: high')
      .replace('### DES-001 Existing service responsibility', '### DES-001 GameManager')
      .replace('- Element: module - existing service', '- Element: class - GameManager')
      .replace('- Role stereotype: module', '- Role stereotype: controller')
      .replace('- Responsibilities: compute the command result', '- Responsibilities: input, simulation, collision, combat, spawn, score, rendering, and save persistence');

    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: shallowTankDesign,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('must inventory its state, policy, construction, or interaction variations'),
      expect.stringContaining('must evaluate applicable pattern candidates'),
      expect.stringContaining('must define at least three substantive DOM-*'),
      expect.stringContaining('must define at least three cohesive DES-*'),
      expect.stringContaining('must define at least two key FLOW-*'),
      expect.stringContaining('appears to be a God coordinator'),
    ]));
  });

  it('does not let a greenfield interactive product bypass depth checks as local', () => {
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: tankDesign.replace('Design-Depth: standard', 'Design-Depth: local'),
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toContain(
      'design.md greenfield or new-subsystem interactive-simulation must use standard or complex design depth.',
    );
  });

  it('requires Chinese review prose when the task language is Chinese', () => {
    const englishResult = validateAutocodeStandardDesignArtifacts({
      designMarkdown: design,
      designReviewMarkdown: review,
      language: 'zh-CN',
      requireTaskReferences: false,
    });
    const chineseResult = validateAutocodeStandardDesignArtifacts({
      designMarkdown: design,
      designReviewMarkdown: 'Status: PASSED\n\n设计有证据支持，职责边界清晰，并且没有过度设计。',
      language: 'zh-CN',
      requireTaskReferences: false,
    });

    expect(englishResult.errors).toContain(
      'design_review.md review prose must use Simplified Chinese for language zh-CN. Keep only the required Status token and technical identifiers in English.',
    );
    expect(chineseResult.errors).toEqual([]);
  });

  it('accepts an evidence-backed pattern and requires task coverage', () => {
    const patternSection = [
      '### PAT-001 Strategy',
      '- Verified variation: two confirmed result calculation policies',
      '- Evidence: requirements.md R-002 and src/main/existing.ts policy selection',
      '- Expected horizon: both policies are required by the current request',
      '- Stable boundary: result calculation input and output',
      '- Encapsulated variation: policy-specific calculation',
      '- Participants and roles: DES-001 is context; SYS-001 contains the calculation policy implementations',
      '- Application scope: only result calculation selected by the current command',
      '- Simpler alternative: a branch was rejected because policies have separate tests and lifecycle',
      '- Benefit: policy changes remain inside one implementation',
      '- Cost and failure modes: one indirection and unknown-policy validation',
    ].join('\n');
    const patterned = design
      .replace('Design-Depth: local', 'Design-Depth: standard')
      .replace('- New architectural patterns: none', '- New architectural patterns: PAT-001 Strategy')
      .replace('- Selected patterns: none', `- Selected patterns: PAT-001\n${patternSection}`)
      .replace('FLOW-001 -> IMP-001', 'FLOW-001 -> PAT-001 -> IMP-001');
    const patternedTasks = tasks.replace('FLOW-001, IMP-001', 'FLOW-001, PAT-001, IMP-001');

    expect(validateAutocodeStandardDesignArtifacts({
      designMarkdown: patterned,
      designReviewMarkdown: review,
      tasksMarkdown: patternedTasks,
    }).errors).toEqual([]);
    expect(validateAutocodeTaskDesignReferences(tasks, patterned)).toContain(
      'design.md selected pattern PAT-001 is not covered by any executable task.',
    );
  });

  it('rejects a selected pattern without a complete decision record', () => {
    const incompletePattern = design
      .replace('Design-Depth: local', 'Design-Depth: standard')
      .replace('- New architectural patterns: none', '- New architectural patterns: PAT-001 Strategy')
      .replace(
        '- Selected patterns: none',
        [
          '- Selected patterns: PAT-001',
          '### PAT-001 Strategy',
          '- Verified variation: two current policies',
          '- Evidence: requirements.md R-002',
          '- Expected horizon: current request',
          '- Stable boundary: calculation contract',
          '- Encapsulated variation: policy calculation',
          '- Participants and roles: result service context and policy strategies',
          '- Application scope: result calculation only',
          '- Benefit: isolates policy edits',
          '- Cost and failure modes: one dispatch step',
        ].join('\n'),
      )
      .replace('FLOW-001 -> IMP-001', 'FLOW-001 -> PAT-001 -> IMP-001');
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: incompletePattern,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });

    expect(result.errors).toContain(
      'design.md PAT-001 must contain machine field - Simpler alternative: <value>.',
    );
  });

  it('returns the exact budget repair format when a designer uses headings', () => {
    const headingBudget = design.replace(
      [
        '- Expected modules changed: 2',
        '- New modules allowed: 0',
        '- New public contracts allowed: 0',
        '- New dependencies allowed: 0',
        '- New architectural patterns: none',
      ].join('\n'),
      [
        '### DES-004 Design budget',
        '#### Expected modules changed',
        '2 modules.',
        '#### New modules allowed',
        '0 modules.',
        '#### New public contracts allowed',
        '0 contracts.',
        '#### New dependencies allowed',
        '0 dependencies.',
        '#### New architectural patterns',
        'None.',
      ].join('\n'),
    );
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: headingBudget,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });
    const retryPrompt = buildAutocodeDesignQualityRetryPrompt(result.errors);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('- Expected modules changed: <non-negative integer>'),
      expect.stringContaining('- New architectural patterns: <none or PAT-* IDs>'),
    ]));
    expect(retryPrompt).toContain('Keep the English field names, list markers, and ASCII colons');
    expect(retryPrompt).toContain('- New dependencies allowed: <non-negative integer>');
    expect(retryPrompt).toContain('do not use headings for these fields');
  });

  it('returns a complete repair contract for localized machine fields and short stable IDs', () => {
    const malformed = design
      .replace('# Design: Focused change', '# C++ \u4fc4\u7f57\u65af\u65b9\u5757\u6e38\u620f\u8bbe\u8ba1')
      .replace(/-001\b/g, '-1')
      .replace('- Analysis direction: forward-design', '- Analysis direction: forward-design - \u6b63\u5411\u8bbe\u8ba1')
      .replace('- Primary source of truth: mixed', '- Primary source of truth: \u6df7\u5408')
      .replace('- Requirement evidence: requirement - requirements.md R-1 defines the requested command result', '- Requirement evidence: requirements.md R-1')
      .replace('- Project evidence: observed - src/main/existing.ts#computeCommandResult owns the current behavior', '- Project evidence: src/main/existing.ts#computeCommandResult')
      .replace('- Design inferences: none - the cited requirement and source establish the complete local boundary', '- Design inferences: \u65e0')
      .replace('- Unresolved evidence: none', '- Unresolved evidence: \u5f85\u786e\u8ba4')
      .replace('- Delivery context: existing-system', '- Delivery context: \u73b0\u6709\u7cfb\u7edf')
      .replace('- System shape: local-utility', '- System shape: \u672c\u5730\u5de5\u5177')
      .replace('- Project paradigm: mixed', '- Project paradigm: \u6df7\u5408')
      .replace('- Object-model applicability: low', '- Object-model applicability: \u4f4e')
      .replace('- Cohesion decision:', '- \u5185\u805a\u51b3\u7b56:')
      .replace('- Coupling and dependency decision:', '- \u8026\u5408\u4e0e\u4f9d\u8d56\u51b3\u7b56:')
      .replace('- Encapsulation decision:', '- \u5c01\u88c5\u51b3\u7b56:')
      .replace('- SOLID trade-offs:', '- SOLID \u6743\u8861:')
      .replace('- Underdesign checks:', '- \u8bbe\u8ba1\u4e0d\u8db3\u68c0\u67e5:');
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: malformed,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });
    const retryPrompt = buildAutocodeDesignQualityRetryPrompt(result.errors);

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('# Design: <localized title>'),
      expect.stringContaining('heading ADR-1 is invalid'),
      expect.stringContaining('Analysis direction must be exactly one unquoted token'),
      expect.stringContaining('Unresolved evidence must be exactly'),
    ]));
    expect(retryPrompt).toContain('# Design: <localized task title>');
    expect(retryPrompt).toContain('### ADR-001 <localized decision title>');
    expect(retryPrompt).toContain('ADR-1 and DES-01 are invalid');
    expect(retryPrompt).toContain('- Analysis direction: forward-design|reverse-engineering|mixed');
    expect(retryPrompt).toContain('- Requirement evidence: requirement - <source and claim> | none - <reason>');
    expect(retryPrompt).toContain('Unresolved evidence must be exactly');
    expect(retryPrompt).toContain('Underdesign checks');
  });

  it('provides exact DOM and DES token formats and retains more than thirty errors', () => {
    const malformed = design
      .replace('- Concept kind: entity', '- Concept kind: \u805a\u5408\u5b9e\u4f53')
      .replace('- Software mapping: existing - src/main/existing.ts task state', '- Software mapping: DES-001 task state')
      .replace('- Element: module - existing service', '- Element: `ExistingService` \u7c7b')
      .replace('- Role stereotype: module', '- Role stereotype: \u9886\u57df\u670d\u52a1');
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: malformed,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });
    const retryPrompt = buildAutocodeDesignQualityRetryPrompt(result.errors);
    const manyErrors = Array.from({ length: 32 }, (_, index) => `design.md synthetic error ${index + 1}.`);
    const completeRetryPrompt = buildAutocodeDesignQualityRetryPrompt(manyErrors);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('Concept kind must be exactly one English token'),
      expect.stringContaining('Software mapping must use <existing|new|none>'),
      expect.stringContaining('Element must use <module|class|component|function|store|process|data-structure|other>'),
      expect.stringContaining('Role stereotype must be exactly one English token'),
    ]));
    expect(retryPrompt).toContain('- DOM Concept kind: entity|value-object|domain-service|policy|event|technical|other');
    expect(retryPrompt).toContain('- DOM Software mapping: existing|new|none - <localized concrete path/symbol mapping or reason>');
    expect(retryPrompt).toContain('- DES Element: module|class|component|function|store|process|data-structure|other - <localized concrete element or symbol>');
    expect(retryPrompt).toContain('- DES Role stereotype: entity|value-object|controller|application-service|domain-service|policy|adapter|repository|view|component|system|port|module|other');
    expect(completeRetryPrompt).toContain('design.md synthetic error 32.');
    expect(completeRetryPrompt).not.toContain('more error(s) omitted');
    expect(AUTOCODE_STANDARD_DESIGN_MACHINE_CONTRACT_PROMPT).toContain('Every SYS has at least one DES implementation responsibility');
  });

  it('does not treat traceability references as duplicate definitions', () => {
    expect(parseAutocodeDesignSections(design).filter((section) => section.id === 'RM-001')).toHaveLength(1);
    expect(validateAutocodeStandardDesignArtifacts({ designMarkdown: design, designReviewMarkdown: review }).errors)
      .not.toContain('design.md defines RM-001 more than once.');
  });

  it('rejects speculative local architecture', () => {
    const overdesigned = design.replace(
      '- Decision: preserve the current renderer-to-bridge-to-service dependency direction',
      '- Decision: introduce a new service layer and event bus for the command',
    );
    const result = validateAutocodeStandardDesignArtifacts({
      designMarkdown: overdesigned,
      designReviewMarkdown: review,
      requireTaskReferences: false,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.includes('speculative complexity'))).toBe(true);
  });

  it('rejects missing and unknown task design references', () => {
    const invalidTasks = tasks.replace(
      'ADR-001, SYS-001, DES-001, FLOW-001, IMP-001',
      'ADR-999',
    );
    const errors = validateAutocodeTaskDesignReferences(invalidTasks, design);
    expect(errors).toEqual([
      'tasks.md task 1.1 references unknown design ID ADR-999.',
      'design.md system allocation SYS-001 is not covered by any executable task.',
      'design.md implementation unit IMP-001 is not covered by any executable task.',
    ]);
    expect(errors.some((error) => error.includes('IMP-001 is not covered'))).toBe(true);
  });

  it('accepts flat executable task IDs and external-colon design metadata', () => {
    const flatTasks = [
      '# Tasks',
      '',
      '- [ ] 1.1 更新现有服务行为',
      '  - _Design_: ADR-001；DES-001；FLOW-001；IMP-001',
      '  - _Requirements_: R-001',
      '  - _Evidence_: requirements.md 与 src/main/existing.ts',
      '',
    ].join('\n');

    const tasksWithSystemAllocation = flatTasks.replace('IMP-001', 'SYS-001, IMP-001');
    expect(validateAutocodeTaskDesignReferences(tasksWithSystemAllocation, design)).toEqual([]);
  });

  it('builds a stable fingerprint from only referenced sections', () => {
    const excerpt = extractAutocodeDesignReferenceExcerpt(design, ['DES-001', 'IMP-001']);
    expect(excerpt).toContain('### DES-001');
    expect(excerpt).toContain('### IMP-001');
    expect(excerpt).not.toContain('### ADR-001');
    expect(getAutocodeDesignReferenceFingerprint(design, ['IMP-001', 'DES-001']))
      .toBe(getAutocodeDesignReferenceFingerprint(design, ['DES-001', 'IMP-001']));
  });
});
