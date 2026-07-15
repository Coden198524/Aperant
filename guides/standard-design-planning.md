# Standard Design-First Planning

## Purpose

Standard mode must produce an evidence-backed design before it creates executable tasks. The design is a binding upstream contract for task generation, coding, QA, incremental planning, and human review. The goal is not to maximize abstraction or minimize object count. The goal is the smallest complete design that satisfies current requirements, fits the project, and avoids both speculative architecture and shallow procedural decomposition.

This design method is distilled from the user-provided architecture/programming summaries and public material for Li Yunhua's *The Logic of Programming: How to Implement Complex Business Requirements with Object-Oriented Methods*. Runtime behavior does not depend on the original local files or online availability.

Public references used for the method, not copied as prompt content:

- [Broadview book page and contents](http://www.broadview.com.cn/book/6607)
- [Publishing House of Electronics Industry book page](https://www.phei.com.cn/module/goods/wssd_content.jsp?bookid=56616)
- [Public notes for the Moments "Dislike" case](https://blog.csdn.net/super_scan/article/details/121073139)
- [Apache ZooKeeper overview](https://zookeeper.apache.org/doc/r3.6.2/zookeeperOver.html)
- [Apache ZooKeeper internals](https://zookeeper.apache.org/doc/r3.6.2/zookeeperInternals.html)

## Core Principles

1. Preserve the existing architecture unless evidence shows it cannot satisfy the requirement.
2. Prefer a suitable, simple, evolvable design over a fashionable or theoretically maximal design.
3. Identify the actual complexity driver before selecting an architecture or pattern.
4. Derive the requirement, domain, design, and implementation models in order.
5. Apply SOLID and design patterns only to verified responsibilities, boundaries, or variation points.
6. Treat speculative extensibility and unused abstraction as design defects.
7. Keep every design decision traceable to requirements, project evidence, or an explicit assumption.
8. Stop for planning review when implementation would materially deviate from the approved design.
9. Derive responsibilities from business scenarios and assign rules to the object/module that owns the needed information.
10. Adapt the design model to the project's established paradigm; object-oriented analysis does not require every implementation to become classes and services.
11. Find a verified change before encapsulating it, and apply NOP (No Overdesign Principle) when a simpler direct mechanism is sufficient.
12. Treat God coordinators, anemic domain objects, implicit state/lifetime ownership, and scattered state/type/policy dispatch as underdesign defects.
13. For greenfield or new-subsystem work, infer the target paradigm from system shape, lifecycle, behavior, quality constraints, framework ownership, and credible variation instead of copying the emptiness of the starting repository.
14. For a stateful interactive product, make state, behavior, mutation, lifetime, and ordered collaboration explicit in the most suitable object, component, data-oriented, functional, procedural, or mixed model.
15. Never select architecture, depth, patterns, or modeling rules from the programming language alone.
16. Keep requirement facts, observed project facts, design inferences, and unresolved questions visibly distinct.

## Planning Pipeline

Standard planning remains one user-visible Plan phase with internal checkpoints:

```text
requirements -> observable specification
       |
       v
requirement model -> domain model
       |
       v
architecture/ADR -> detailed design model -> implementation model
       |
       v
per-owner validation -> independent package critique
       |
       v
tasks generation -> cross-artifact validation -> runtime-plan derivation
       |
       v
human review
```

Each arrow is an owner boundary. A failed owner is retried without asking another stage to rewrite its artifact. Coding cannot begin until all five design-package files, design review, tasks, and the derived runtime plan form one validated planning transaction.

## Adaptive Design Depth

| Depth | Typical scope | Required treatment |
| --- | --- | --- |
| `local` | One bounded module and no material public-contract change | Model only the affected slice. Preserve the architecture. Do not introduce a named pattern by default. |
| `standard` | Cross-module behavior, state, data, or interface changes | Compare the selected design with the simplest viable alternative. Model static responsibilities and key runtime collaboration. |
| `complex` | Cross-system work, migration, concurrency, security, persistence, platform architecture, or high-risk refactoring | Compare no more than three meaningful options. Include quality-attribute trade-offs, failure risks, rollout or migration concerns, and explicit boundaries. |

Repository size is only a modifier. A local change in a large repository remains local unless its behavior or contracts cross boundaries.

Pattern limits are zero for Local, two for Standard, and three for Complex. These are upper bounds, not targets. Many local changes select none; stateful or interactive work must still select a fitting pattern when its current variants and stable boundary make the direct mechanism less cohesive.

## Analysis Directions

Every design declares one direction:

- `forward-design` for intended new or changed behavior;
- `reverse-engineering` for explaining or preserving an existing implementation;
- `mixed` when a change first requires reconstructing uncertain existing behavior.

The Moments "Dislike" case supplies the forward workflow: `5W1H/8C -> scenarios -> domain -> system allocation -> detailed design -> implementation`. It demonstrates that a request should be decomposed through observable scenarios and rule ownership before code elements are chosen.

The ZooKeeper case supplies the reverse workflow: `external capability -> domain concepts -> subsystem responsibility -> runtime flow -> exact source symbols`. It demonstrates outside-in reconstruction: begin with externally promised behavior and responsibility boundaries, then verify the conclusion against concrete packages, classes, and methods. Reading source linearly from one entry point is not architecture analysis.

Forward design proceeds as follows:

1. Clarify only relevant 5W1H context: actor, time, place/channel, requested behavior, business value, and the business process. The last item is not an implementation proposal.
2. Record only relevant quality constraints: performance, cost, delivery time, reliability, security, compliance, technology, and compatibility.
3. Write use-case scenarios with triggers, preconditions, normal flow, alternate/failure flow, outcome, and observable effects.
4. Build the domain model by finding candidate nouns, adding business attributes, and connecting meaningful relations. Filter nouns that do not need software representation.
5. Record business rules and invariants, then assign each one to the concept that owns the information and lifecycle needed to enforce it.
6. Map necessary concepts to the repository's native elements: modules, classes, functions, stores, processes, or framework components. Derive operations and collaboration from scenario verbs.
7. Improve demonstrated cohesion/coupling problems with SOLID or a pattern. Split technical helpers only for actual IO, framework, protocol, persistence, or integration needs.
8. Allocate each scenario and rule to a cohesive system boundary that states ownership, provided and required interfaces, data/control boundaries, and failure ownership.
9. Map each accepted system responsibility to exact elements, files, symbols, integration constraints, and focused verification.

This sequence prevents database tables, UI nouns, external actors, and framework terms from becoming classes mechanically. It also prevents an anemic model where all business rules drift into a generic service.

Reverse engineering proceeds as follows:

1. State the external capability, observable guarantees, failure behavior, and source of that claim.
2. Recover the domain concepts required to explain the capability without treating source names as domain truth automatically.
3. Allocate responsibilities to subsystems and identify their provided/required interfaces and failure ownership.
4. Trace representative runtime paths, state transitions, persistence, recovery, and concurrency where relevant.
5. Map every conclusion to exact source symbols and record contradiction checks and confidence.
6. Mark unsupported conclusions as inferred or unresolved; never present them as observed facts.

## Required Design Package Contract

Design-Contract: 4 splits analysis and design across five canonical files. They share one non-negative `Design-Revision`; each model file declares `Design-Root: design.md` and its exact `Model-Kind`. An ID body appears only in its owning file:

| File | Canonical ownership |
| --- | --- |
| `requirement_model.md` | `RM-*` behavioral analysis: actors, goals, context, flows, outcomes, constraints, and quality needs |
| `domain_model.md` | `DOM-*` concepts: identity/state, behavior, rules, invariants, ownership, lifecycle, and relationships |
| `design.md` | Architecture evidence, bounded candidates, Design Budget, `ADR-*`, pattern budget/index, risks, package index, and connected traceability |
| `design_model.md` | `SYS-*`, `DES-*`, `FLOW-*`, and applicable `CONTRACT-*`, `PAT-*`, and `REV-*` definitions |
| `implementation_model.md` | `IMP-*` exact repository bridge: files, symbols, integration constraints, and verification |

### `requirement_model.md`

```markdown
# Requirement Model: [task name]
Design-Contract: 4
Design-Revision: 1
Design-Root: design.md
Model-Kind: requirement

## Requirement Model
### RM-001 [scenario]
- Actor and goal / Business context / Trigger and preconditions / Normal flow
- Alternate or failure flow / Outcome / Constraints / Quality constraints / Evidence basis
```

### `domain_model.md`

```markdown
# Domain Model: [task name]
Design-Contract: 4
Design-Revision: 1
Design-Root: design.md
Model-Kind: domain

## Domain Model
### DOM-001 [concept]
- Concept kind / Business meaning / Identity and state / Behavior / Responsibilities / Rules and invariants
- Ownership and lifecycle / Relationships / Software mapping / Evidence basis
```

### `design.md`

```markdown
# Design: [task name]
Design-Contract: 4
Design-Depth: local | standard | complex
Design-Revision: 1

## Scope And Evidence
- Analysis direction / Primary source of truth / Requirement evidence / Project evidence
- Design inferences / Unresolved evidence
## Complexity Assessment
- Primary complexity driver / Business rules and state / Boundary and contract impact
- Quality-attribute risks / Depth rationale
## Existing Architecture Fit
## Engineering Adaptation
- Delivery context / System shape / Project paradigm / Paradigm rationale
- Object-model applicability / Object-model rationale / Existing boundaries to preserve
- Existing patterns to reuse / Language/framework constraints / Integration and test seams
## Design Budget
## Architecture Candidates
- Architecture baseline / Candidate count / Candidate comparison / Selected architecture
- Selection rationale / Rejected alternatives / Evolution trigger
## Architecture Decision
### ADR-001 [decision]
- Decision / Status / Decision drivers / Alternatives considered / Trade-offs / Evidence basis
## Model Package
- Requirement model: requirement_model.md
- Domain model: domain_model.md
- Design model: design_model.md
- Implementation model: implementation_model.md
## Change And Pattern Analysis
## Applicable Design Principles
## Rejected Complexity
## Risks And Evolution
## Traceability
```

`design.md` is an architecture decision record and package index. It references model IDs but must not contain RM, DOM, SYS, DES, FLOW, CONTRACT, PAT, REV, or IMP bodies.

### `design_model.md`

```markdown
# Design Model: [task name]
Design-Contract: 4
Design-Revision: 1
Design-Root: design.md
Model-Kind: design

## System Responsibility Allocation
### SYS-001 [subsystem or boundary]
- Subsystem or boundary / Allocated requirements / Owns / Provides / Requires
- Data and control boundary / Failure ownership / Evidence basis

## Design Model
### DES-001 [modules/classes, responsibilities, dependency direction]
- Element / System allocation / Role stereotype / Owned state / Public operations / Responsibilities
- Collaborators / Dependencies / Encapsulation boundary / Does not own / Evidence basis
### FLOW-001 [important runtime interaction or state transition]
- Trigger / Participants / Steps / State changes / Failure paths / Evidence basis
### CONTRACT-001 [interface, data, lifecycle, error contract]
- Inputs and outputs / Compatibility / Errors / Lifecycle / Evidence basis

## Change And Pattern Analysis
- Verified variation points: none | ...
- Variation inventory: none | ...
- Candidate patterns evaluated: none | pattern - selected/rejected with reason
- Simplest change mechanism: ...
- Selected patterns: none | PAT-001[, PAT-002]
### PAT-001 [selected pattern only]
- Verified variation / Evidence / Expected horizon / Stable boundary
- Encapsulated variation / Participants and roles / Application scope
- Simpler alternative / Benefit / Cost and failure modes

## Source Reconstruction
### REV-001 [outside-in reconstruction; reverse or mixed only]
- External capability / Domain concepts / Responsibility path / Runtime path
- Source symbols / Contradiction checks / Confidence
```

### `implementation_model.md`

```markdown
# Implementation Model: [task name]
Design-Contract: 4
Design-Revision: 1
Design-Root: design.md
Model-Kind: implementation

## Implementation Model
### IMP-001 [mapping to project files, symbols, tests, and integration points]
- Project files and symbols / Design mapping / Integration constraints / Verification / Evidence basis
```

Sections may be concise. A read-only or documentation task may mark a model slice as not applicable only with a concrete reason. Models must not copy requirements, database tables, or source code mechanically.

The full field names shown in the bundled owner prompts are machine-readable and remain in English. Enum tokens and evidence prefixes are also machine-readable: keep them in English, unquoted, and exact, and localize only descriptive prose. `Quality constraints` accepts relevant ASCII `Dimension=value` entries separated by ASCII semicolons, or `none - reason`; it is syntax-checked rather than restricted to a closed list. Every stable ID uses at least three digits (`ADR-001`, not `ADR-1`). `Source Reconstruction` and `REV-*` are required only for reverse-engineering or mixed analysis and must be omitted for forward-only work. Deterministic validation checks file ownership, shared revision, field presence, evidence provenance, engineering enums, requirement-to-system allocation, static/dynamic consistency, source-symbol reconstruction, exact project mapping, pattern alignment/limits, and ordered cross-file traceability.

## Design Budget

Every design declares a bounded change budget, for example:

```markdown
- Expected modules changed: 2
- New modules allowed: 0
- New public contracts allowed: 1
- New dependencies allowed: 0
- New architectural patterns: none
```

The budget is reviewed against the task scope. It is not a target that the coder should consume.

## Pattern Decision Gate

A selected pattern is represented by one PAT-* section and must answer:

- What current or confirmed near-term behavior actually varies?
- What evidence proves the variants and their credible time horizon?
- What remains stable, and what changing behavior will be encapsulated?
- Why are a direct branch, helper, lookup table, configuration value, composition, or existing project mechanism insufficient?
- What concrete change radius or duplication does the pattern reduce?
- What indirection, lifecycle, ordering, compatibility, debugging, or failure cost does it add?

The same PAT-* IDs must appear in the Design Budget, Change And Pattern Analysis, PAT sections, Traceability, and implementing tasks. A pattern that merely resembles a requirement keyword fails review.

Extending an established pattern inside its current boundary is ordinary project-pattern reuse, recorded in Engineering Adaptation and DES/IMP. It does not consume the new-pattern budget or create PAT-*.

## Anti-Overdesign Rules

The design review must reject a design when any of these conditions holds without concrete evidence:

- It adds a service, layer, repository, event bus, plugin system, generic framework, or external dependency.
- It adds an interface for one implementation without an external boundary, testing seam, platform adaptation, or verified variation point.
- It adds configuration or extension points only for hypothetical future requirements.
- It applies a named pattern without current/confirmed variation evidence, credible horizon, stable boundary, simpler alternative, benefit, and cost.
- It converts every domain noun into a class or moves all business rules into a generic service.
- It ignores established functional, data-oriented, procedural, framework, module, or process boundaries.
- It restructures unrelated modules to implement a local behavior.
- Its implementation model touches substantially more files or contracts than the requirement needs.
- Its diagrams restate code without exposing a decision, responsibility, or runtime interaction.
- A simpler project-consistent solution exists and the design does not explain why it is insufficient.

The accepted design must be the simplest viable option, not merely a technically valid option.

## Anti-Underdesign Rules

The design review must also reject a design when:

- one application/game manager owns unrelated input, simulation, collision, combat, spawning, scoring, persistence, and presentation behavior;
- domain entities are passive records while a generic service owns their state-dependent rules;
- identity, owned state, public operations, invariant ownership, lifetime, or mutation authority is unclear;
- several states, entity types, construction paths, or policies are handled by scattered branches without one variation decision;
- an object-oriented or high-applicability design has no meaningful collaborating classes or ordered flows;
- a greenfield/new-subsystem interactive model uses token DOM/SYS/DES/FLOW entries that do not cover principal scenarios;
- requirements bypass system allocation, or detailed elements do not name their `SYS-*` owner;
- static elements are absent from runtime flows without a contract-based reason, or flow participants do not act in ordered steps;
- a reverse reconstruction lacks exact source symbols, contradiction checks, or honest confidence;
- Traceability lists IDs without connecting each RM through DOM, SYS, DES, FLOW/CONTRACT, and IMP in that order.

For a stateful or interactive design, Candidate patterns evaluated records both selected and rejected candidates. This is an analysis requirement, not a quota: direct composition may still win when its responsibility and change radius are demonstrably smaller.

## Design Critic Contract

The critic runs in a fresh model session as an independent senior designer and checks both overdesign and underdesign. It reads `requirements.md`, `spec.md`, `context.md`, all five design-package files, and only the source files needed to verify important claims. It writes `design_review.md` with one exact status:

```markdown
Status: PASSED
```

or:

```markdown
Status: REVISE
```

The review covers requirement fit, evidence, project fit, simplicity, responsibility allocation, dependency direction, static/dynamic consistency, implementation feasibility, testability, and traceability. A revise result must contain blocking findings and a simpler recommended correction. Planning may request at most two design revisions before it stops for human review with an error.

Each independent review starts without the previous `design_review.md`. A failed or interrupted critic session therefore cannot reuse an older `Status: PASSED`; the planning transaction restores the previous reviewed pair only when the new iteration fails.

## Task Traceability

Every executable code-writing task includes design references:

```markdown
- _Design: ADR-001, DOM-001, SYS-001, DES-002, FLOW-001, PAT-001, REV-001, IMP-003_
```

All referenced IDs must exist in their canonical design-package owner; `PAT-*` is included only when selected and `REV-*` only when applicable. Every implementation task names its `SYS-*` allocation. Every required `SYS-*` and `IMP-*`, selected `PAT-*`, and applicable `REV-*` unit must be covered by at least one executable task. The derived runtime plan stores `design_refs` and a fingerprint of the referenced sections across all five files.

## Coding Contract

The runtime injects only the current work package's referenced sections from the five-file design package into the coding prompt. Before editing, the coder performs a design preflight that maps the target symbol to its `IMP-*`, `SYS-*` owner/interface, `DES-*` state or rule owner, `FLOW-*`/`CONTRACT-*` position, and any `REV-*` source constraints.

Binding design constraints include module boundaries, owned state, public operations, invariant ownership, responsibilities, dependency direction, public contracts, data formats, persistence behavior, lifecycle, error behavior, and key runtime collaboration. Coders retain freedom over private helpers, local names, and internal control flow that do not alter those constraints.

Coders must not add an unplanned layer, service, public interface, named pattern, dependency, persistence shape, or cross-module refactor. If the target symbol is absent from `IMP-*`, observed source contradicts `REV-*`, or a material design change is required, the work package is blocked and returned to planning instead of improvising.

A referenced PAT-* is implemented only for its documented variation and stable boundary. The coder cannot broaden it into a reusable framework or apply it elsewhere by analogy.

Completion evidence records the design references followed and any deviation. QA checks the diff against the design budget and referenced contracts.

## Incremental Planning And Recovery

- Stable design IDs are preserved across Request Changes.
- Only affected owner files and sections are edited. A replaced architecture decision is superseded by a new ADR rather than silently rewritten.
- Completed work remains completed when its task content and referenced design fingerprints are unchanged.
- Only work packages whose referenced design sections changed are reset to pending.
- Planning transactions checkpoint each design owner, package validation, `design_reviewed`, `tasks_validated`, `plan_derived`, and `plan_validated`.
- A failed tasks stage keeps a validated design and retries only task generation.
- A failed planning transaction saves failed artifacts and restores the last validated set atomically.
- Interrupted planning resumes from the latest valid checkpoint instead of restarting from scratch.

## Compatibility

New and replanned Standard tasks use Design-Contract: 4 and never route through QuickSpec. Existing Design-Contract: 3 tasks remain readable and may finish with their stored design fingerprint. Their next replan or Request Changes pass upgrades them to the five-file package. Direct mode is unchanged.

## Acceptance Criteria

- Every new or replanned Standard task produces all five valid, revision-aligned design-package files and a passing `design_review.md` before `tasks.md` is accepted.
- Every executable write task references valid design IDs.
- Requirement, domain, system-allocation, responsibility/collaboration, dynamic, source-reconstruction when applicable, and implementation models use the required machine fields and trace every stable ID.
- Forward designs follow scenario-to-system-to-code reasoning; reverse designs follow external-capability-to-source-symbol reasoning with contradiction checks.
- Material claims remain classified as requirement, observed, inferred, or unresolved.
- Engineering adaptation cites actual project files/symbols and preserves the repository's established paradigm and boundaries.
- Greenfield/new-subsystem interactive designs declare system shape and model applicability, contain substantive collaborating elements and flows in the selected paradigm, and do not collapse behavior into a generic manager.
- Architecture and paradigm selection remain language-neutral; the same behavioral fixture yields the same design obligations across implementation languages.
- Stateful and interactive designs inventory real variations and compare applicable selected/rejected pattern candidates without imposing a pattern quota.
- Pattern IDs align across design budget, pattern decisions, traceability, and implementing tasks; depth limits and full decision evidence are enforced.
- Missing, stale, or unresolved design contracts block coding.
- Local tasks do not introduce architecture layers, named patterns, or dependencies without an approved evidence-backed exception.
- The critic rejects both speculative architecture and underdesign fixtures containing God coordinators, anemic records, implicit ownership, shallow flows, or scattered variant dispatch.
- Request Changes preserve unaffected completed work and reset only work affected by changed design sections.
- Initial planning and incremental planning stop for human review before coding.
