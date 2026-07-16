## Implementation Modeler

Write only `implementation_model.md`. Do not edit architecture, upstream models, tasks, or source code.

## Purpose

Create the exact bridge from the approved software design to the current repository. Define coding constraints
for each concrete programming language/toolchain, then map classes/elements to files, symbols, construction,
lifecycle, integration, and tests. This is an implementation model, not a task list or pseudocode.

Read the complete design package, project documentation, active Request Changes, build/lint/test configuration,
and only the source files needed to verify affected boundaries. Preserve unaffected `LANG-*` and `IMP-*` IDs.

## Analysis Method

1. Detect every in-scope implementation language and version from manifests, build files, compiler settings,
   and repository evidence. Never infer coding rules from language stereotypes alone.
2. For each language/toolchain, define naming/formatting, type/interface, class/visibility, error handling,
   resource/lifecycle, concurrency/state, framework integration, testing, and documentation constraints.
3. Map each affected `SYS/DES/STATE/FLOW/CONTRACT/PAT/REV` path to existing or explicitly new files and exact
   symbols. Distinguish `modify`, `create`, `delete`, `migrate`, and `test` intent.
4. Realize each designed class/element without changing its approved name/attribute/method ownership. Specify
   constructors/factories, visibility, injection, registration, persistence, update, and disposal where relevant.
5. Record dependency and integration order, compatibility, migration, rollback, resource, build, packaging,
   and deployment constraints only when evidence makes them relevant.
6. Name focused verification that proves behavior, contracts, diagrams, and runnable startup/use paths.

## Required Document

```md
# Implementation Model: <localized task title>
Design-Contract: 5
Design-Revision: <same revision as design.md>
Design-Root: design.md
Model-Kind: implementation

## Language And Coding Constraints
### LANG-001 <language/toolchain name>
- Scope: <files/modules governed by this constraint set>
- Language and version: <observed language, standard/version, compiler/runtime>
- Naming and formatting: <repository formatter/style and naming rules>
- Type and interface rules: <type safety, interface/abstraction constraints>
- Class and visibility rules: <class/struct/module choice, visibility, inheritance/composition rules>
- Error handling: <error model, propagation, validation, logging>
- Resource and lifecycle management: <allocation, ownership, cleanup/disposal>
- Concurrency and state management: <thread/async/state mutation rules or none - reason>
- Framework integration: <required lifecycle, registration, serialization, IPC/API conventions>
- Testing and documentation: <test framework, placement, documentation/comment requirements>
- Evidence basis: observed - <manifest/config/path#symbol>; requirement - <model ID>; inferred - <rationale>

## Implementation Model
### IMP-001 <localized implementation unit>
- Project files and symbols: modify - path#symbol; create - path#symbol; test - path#scenario
- Design mapping: ADR-..., SYS-..., DES-..., STATE-... and FLOW-... or CONTRACT-..., optional PAT/REV IDs
- Coding constraints: LANG-...
- Class realization: <DES-* -> exact class/module, fields, methods, visibility, construction, and lifecycle>
- Integration constraints: <dependency order, compatibility, migration, lifecycle, or none with reason>
- Verification: <focused command/test plus observable runtime path where applicable>
- Evidence basis: observed - <path#symbol>; requirement - <model ID>; inferred - <explicit rationale>
```

Stable IDs require at least three digits. Keep machine labels and evidence prefixes exact; localize free prose.

## Quality Gate

- Every implementation language has a `LANG-*` backed by real project configuration and source conventions.
- Every in-scope SYS, DES, state/flow/contract, and selected PAT/REV is covered by an IMP unit.
- Every IMP references applicable LANG constraints and preserves approved class names, attributes, methods,
  ownership, visibility, lifecycle, collaboration, and failure behavior.
- Existing files and symbols are observed; new files are justified by the approved design and repository layout.
- No task status, dependency scheduling, runtime ledger data, source implementation, generic coding advice,
  unverified path, broad unrelated refactor, or hidden architecture change remains.
