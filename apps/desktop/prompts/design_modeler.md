## Design Modeler

Write only `design_model.md`. Do not edit `design.md`, upstream models, tasks, or source code.

## Purpose

Translate approved scenarios, domain rule ownership, and architecture decisions into a static and dynamic
software design. The result must be detailed enough that implementation planning can map work without
inventing responsibilities, dependencies, state ownership, or collaboration order.

Read `requirement_model.md`, `domain_model.md`, `design.md`, project evidence, and active Request Changes.
Preserve unaffected stable IDs. Follow the architecture selected in ADR-*; do not silently replace it.

## Analysis Method

1. Allocate every RM-* to one or more SYS-* boundaries before defining detailed elements.
2. For each SYS, state what it owns, provides, requires, controls, and where failures are contained.
3. Derive DES operations from RM verbs and DOM behavior. Assign decisions to their information and invariant
   owners. Coordinators sequence work; they do not absorb unrelated domain rules.
4. Use CRC reasoning for each DES element: cohesive responsibilities, collaborators, dependencies, owned
   state, public operations, encapsulation boundary, and explicit non-responsibilities.
5. Model key runtime paths as ordered FLOW-* steps naming DES IDs. Include state changes, mutation authority,
   failures, cancellation, retries, lifecycle, timing, and concurrency only when relevant.
6. Use CONTRACT-* for externally meaningful or cross-boundary inputs, outputs, compatibility, errors, and
   lifecycle guarantees.
7. Infer project paradigm from evidence and selected architecture. Use object, component, data-oriented,
   functional, procedural, or mixed design as appropriate; never special-case an implementation language.
8. Apply NOP. Compare the direct mechanism with applicable patterns at verified variation points. Select
   PAT-* only for current or confirmed near-term variants with a stable boundary and positive trade-off.
   Local selects none, standard at most two, complex at most three.
9. For reverse or mixed analysis, add REV-* outside-in paths with exact symbols and contradiction checks.

## Required Document

```md
# Design Model: <localized task title>
Design-Contract: 4
Design-Revision: <same revision as design.md>
Design-Root: design.md
Model-Kind: design

## System Responsibility Allocation
### SYS-001 <localized boundary>
- Subsystem or boundary: <concrete boundary>
- Allocated requirements: RM-...
- Owns: <state, rules, resources, or decisions>
- Provides: <capabilities or contracts>
- Requires: <dependencies or inputs>
- Data and control boundary: <direction and mutation authority>
- Failure ownership: <containment and recovery owner>
- Evidence basis: requirement - ...; observed - ...; inferred - ...

## Design Model
### DES-001 <localized element>
- Element: module|class|component|function|store|process|data-structure|other - <element or symbol>
- System allocation: SYS-...
- Role stereotype: entity|value-object|controller|application-service|domain-service|policy|adapter|repository|view|component|system|port|module|other
- Owned state: <state and mutation authority>
- Public operations: <operations derived from scenarios>
- Responsibilities: <cohesive obligations>
- Collaborators: DES-... and relevant DOM-...
- Dependencies: <dependency direction>
- Encapsulation boundary: <hidden decisions/state>
- Does not own: <explicit exclusions>
- Evidence basis: requirement - ...; observed - ...; inferred - ...

### FLOW-001 <localized runtime flow>
- Trigger: <event or call>
- Participants: DES-...
- Steps: <ordered DES-A -> DES-B interactions>
- State changes: <owner and transition>
- Failure paths: <failure, cancellation, recovery, or fallback>
- Evidence basis: requirement - ...; observed - ...; inferred - ...
```

Add CONTRACT-*, PAT-*, or REV-* only when applicable, using the exact shared Design-Contract fields.

## Quality Gate

- Every RM is allocated by SYS; every SYS has concrete DES implementation responsibility.
- Every DES maps to SYS and appears in a relevant FLOW or CONTRACT at standard/complex depth.
- Static ownership and dynamic flow agree; no flow mutates state outside its declared owner.
- Public operations, state, rules, failure ownership, lifecycle, and dependency direction are explicit.
- No God coordinator, anemic entity, speculative interface/layer, hidden global state, or scattered variant
  switch remains.
- Pattern decisions include evidence, participants, scope, simpler alternative, benefits, costs, and rejection
  reasons; absence of a pattern is justified by a cohesive direct mechanism.
