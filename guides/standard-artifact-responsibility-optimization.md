# Standard Artifact Responsibility Optimization

## Purpose

Standard mode keeps independently useful planning artifacts while making each fact have one canonical owner:

| Artifact | Canonical responsibility | Must not contain |
| --- | --- | --- |
| `requirements.md` | Why the change exists and what must be satisfied | Scenarios, architecture, file plans, task definitions, runtime state |
| `spec.md` | Observable behavior contract | Copied requirement/evidence prose, internal design, task definitions, runtime state |
| `requirement_model.md` | Behavioral analysis and `RM-*` scenarios | Architecture, software elements, files, tasks, runtime state |
| `domain_model.md` | Technology-neutral `DOM-*` rules, state, invariants, ownership, and lifecycle | Architecture, task decomposition, runtime state |
| `design.md` | Architecture evidence, bounded candidates, budgets, `ADR-*`, package index, risks, and connected traceability | RM/DOM/SYS/DES/FLOW/CONTRACT/PAT/REV/IMP bodies, tasks, runtime state |
| `design_model.md` | `SYS-*`, `DES-*`, `FLOW-*`, and applicable `CONTRACT-*`, `PAT-*`, `REV-*` design definitions | Repository task breakdown, runtime state |
| `implementation_model.md` | Exact `IMP-*` file/symbol/integration/verification bridge | Task status, scheduling, runtime state, source implementation |
| `tasks.md` | Stable implementation work definitions and history | Runtime status, timestamps, durations, retries, failures, commits |
| `implementation_plan.md` | Dynamic work-package execution ledger | Copied task title, description, files, requirement/design/evidence prose, done criteria, verification instructions |

The five design files form Design-Contract: 4. They share one `Design-Revision`, and each stable ID body lives in exactly one owner file. Other artifacts reference those IDs instead of restating design content.

## Artifact Contracts

### requirements.md

`requirements.md` is the canonical what-and-why record. Its generated content uses stable identifiers:

- `R<n>` for user or system requirements.
- `AC<n>` for acceptance criteria.
- `C<n>` for constraints.
- `A<n>` for assumptions.
- `Q<n>` for open questions.
- `E<n>` for evidence sources.

Each entry contains its full text exactly here. Existing metadata such as workflow type, services, attached images, and creation time remains supported for compatibility. Requirements generation must preserve unaffected IDs during Request Changes.

### spec.md

`spec.md` is the observable behavior contract. It contains:

- Scope and explicit non-goals.
- Scenarios and observable input/output behavior.
- State transitions, error behavior, compatibility rules, and boundary cases when applicable.
- A coverage reference such as `Covers: R1, AC1, AC2` on each scenario or behavior section.

It cites `R*`, `AC*`, and `E*` identifiers. It does not copy their bodies and does not contain architecture, classes, file lists, or work items.

### Design package

The design package separates analysis, architecture, detailed design, and repository mapping:

- `requirement_model.md` derives testable `RM-*` behavior from approved requirements and `SCN-*` scenarios.
- `domain_model.md` assigns rules, behavior, state, invariants, mutation authority, ownership, and lifecycle to `DOM-*` concepts without choosing architecture.
- `design.md` selects the smallest evidence-backed architecture, compares only credible alternatives, records `ADR-*` decisions and budgets, indexes the four model files, and owns cross-file traceability.
- `design_model.md` allocates requirements to `SYS-*` boundaries and defines static/dynamic software collaboration in `DES-*`, `FLOW-*`, and applicable contract, pattern, and reverse-reconstruction entries.
- `implementation_model.md` maps the approved design to exact existing or justified-new files, symbols, integration order, compatibility constraints, and focused verification in `IMP-*`.

No owner copies another model body. Design review reads the entire package, and tasks resolve each design ID from its canonical file.

### tasks.md

`tasks.md` is the static work-definition catalog. A leaf task owns:

- Stable task ID and concise action title.
- Implementation guidance that is specific to that task.
- Files to create or modify.
- Logical dependencies on other task IDs.
- References to `R*`, `AC*`, spec scenario IDs, and relevant `design.md` IDs.
- Done condition and focused verification instructions.

Task checkboxes are syntax for a task definition, not execution state. New Standard documents write every task with `[ ]`. Runtime execution must never edit `tasks.md`; Request Changes may revise the definition catalog transactionally while retaining unaffected and historical tasks.

### implementation_plan.md

`implementation_plan.md` is the runtime ledger. Its work-package entries persist only:

- Work-package ID and source task IDs.
- Definition fingerprint used to decide whether completed state is reusable.
- Runtime dependency IDs when grouping creates work-package-level scheduling dependencies.
- Status and active timing fields.
- Retry count, failure/block reason, completion summary, and local commit ID when available.

Task-facing details are hydrated in memory by joining each work package's source task IDs against `tasks.md`. The Markdown on disk must not duplicate task titles, descriptions, files, requirements, design references, evidence, done criteria, or verification prose.

## Shared Stage Contract

Both Standard entry points follow the same ownership order:

1. Optional evidence discovery writes evidence artifacts only.
2. Requirements writes `requirements.md` only.
3. Specification writes `spec.md` only and references requirement IDs.
4. Requirement modeling writes `requirement_model.md` only.
5. Domain modeling writes `domain_model.md` only.
6. Architecture selection writes `design.md` only.
7. Detailed design modeling writes `design_model.md` only.
8. Implementation mapping writes `implementation_model.md` only.
9. Design review reads all five design files and writes `design_review.md` only.
10. Planning writes `tasks.md` only.
11. The runtime deterministically derives a slim `implementation_plan.md`.
12. Pure validators read and cross-check artifacts without repairing or appending content.
13. Successful planning or replanning stops in human review before coding.

Request Changes starts at the earliest affected stage and preserves unaffected downstream definitions where their referenced contract fingerprints are unchanged.

## Compatibility And Migration

Legacy documents remain readable. A migration is triggered only after a new or revised `tasks.md` passes validation:

1. Read and snapshot `tasks.md` and `implementation_plan.md`.
2. Parse the new static task definitions and derive work-package definitions.
3. Match old ledger entries by source task IDs and definition fingerprint.
4. Preserve completed state, accumulated active duration, timestamps, retries, failure context, commit ID, and dependencies for unchanged definitions.
5. Reset only new or materially changed definitions to pending.
6. Keep completed historical definitions visible in `tasks.md`; mark superseded definitions in static history rather than deleting them.
7. Serialize the slim ledger to a temporary file, parse and cross-validate it, then atomically replace the target.
8. On any failure, restore both snapshots and leave the task in planning review with an actionable error.

The loader accepts both legacy full plans and slim ledgers. Saving a legacy plan keeps its legacy shape until a validated Standard derivation explicitly upgrades it.

## Cross-Artifact Validation

Validation is read-only and enforces:

- Every referenced `R*`, `AC*`, and `E*` exists in `requirements.md`.
- Every spec behavior or scenario has requirement/acceptance coverage.
- Every Design-Contract: 4 file has the correct owner shape and the package shares one revision.
- RM-to-DOM-to-ADR-to-SYS-to-DES-to-FLOW/CONTRACT-to-IMP traceability is connected and every ID resolves in its canonical owner.
- Architecture candidates, design/pattern budgets, evidence provenance, system allocation, static/dynamic consistency, exact implementation mappings, and overdesign/underdesign gates pass.
- Every executable task references at least one requirement or acceptance criterion and valid design-package IDs when design is required.
- Every task dependency targets a known task and the dependency graph is acyclic.
- Every ledger source task ID exists in `tasks.md` or is explicitly retained as historical runtime data.
- Every persisted definition fingerprint matches the joined task definition.
- `spec.md` does not restate requirement or evidence bodies.
- `tasks.md` contains no runtime metadata.
- A slim `implementation_plan.md` contains no static task-definition fields.

Validation never edits an artifact. A retry prompt tells the owning stage which artifact to correct.

## UI And Runtime Join

Loaders expose a joined view without changing either source document:

- Definition fields come from `tasks.md`.
- Status, active duration, retries, failure details, and commit come from `implementation_plan.md`.
- Board and detail progress are calculated from the same joined runtime work packages.
- Completed historical tasks remain inspectable after iteration.
- Runtime code receives the same hydrated work-package shape it used before this migration.

## Acceptance Gates

The implementation is complete when automated tests prove all of the following:

1. Executing, pausing, resuming, failing, retrying, or completing a work package does not change the `tasks.md` hash.
2. `spec.md` references requirement IDs without copying `R*`, `AC*`, or `E*` bodies.
3. A newly derived `implementation_plan.md` contains no task descriptions, file lists, requirement/design/evidence prose, done criteria, or verification instructions.
4. Loading that slim ledger produces a fully hydrated runtime work package for existing coders and UI consumers.
5. Request Changes retains completed task definitions and preserves dependencies, active duration, retries, failure information, and local commit IDs for unchanged work.
6. Changed or new work resets to pending while unchanged completed work remains completed.
7. Failed migration leaves the prior pair of files intact.
8. CLI and Desktop orchestration produce the same artifact ownership contract and always stop for human review after planning.
9. Validation performs no file writes.
10. Simple, balanced, and aggressive Standard planning all use the same owner chain and never create or execute a QuickSpec branch.
11. A Design-Contract: 4 package cannot pass when a model body is placed in `design.md`, a revision is stale, or a task references an ID from no owner file.

## Implementation Status

Implemented on 2026-07-14 across the Core runner, Desktop orchestration, bundled prompts, Request Changes inputs, loaders, and validators.

- Desktop and Web Request Changes classify the earliest affected owner. A plain planning request defaults to tasks plus validation; requirement and design owners are selected only by explicit impact.
- Core and Desktop use the same owner-stage resolver over the latest valid planning entry in `change_requests.jsonl`: tasks-only runs `tasks`; design impact starts at the earliest affected design-package owner and reruns changed downstream owners; requirements impact runs the complete owner chain.
- Core planning transactions persist their selected owner stages and are isolated by `changeRequestId`. A new Request Changes entry never resumes an older request's failed checkpoint.
- The `spec` and `planning` runtime entry phases belong to one Standard planning transaction domain, so a failed initial plan can resume from its validated checkpoint after the runtime resolves the next launch as planning.
- A malformed planning journal uses the complete owner chain for repair. The no-journal force-planning path retains the compatible `requirement_model -> domain_model -> design -> design_model -> implementation_model -> design_review -> tasks` flow.
- Desktop owner execution records requirements/specification, each design-package owner, package review, tasks, derivation, and commit checkpoints together with the change-request ID and owner stages.
- Core recovery uses upstream checkpoints only to choose the next owner. It may finalize without another planner session only when `tasks.md` changed from the transaction baseline or the transaction reached `tasks_validated` or a later derivation checkpoint.
- Requirements persistence uses the canonical Markdown serializer. Specification coverage validation requires every `R*` and `AC*` to be covered by a `SCN-*` reference.
- Planner, coder, QA fixer, and validation prompts prohibit direct model edits to the runtime ledger. The runtime alone derives and updates `implementation_plan.md`.
- Planning success remains in human review; it never falls through into coding.

Legacy full plans and Design-Contract: 3 documents remain readable during migration. New or successfully revised Standard plans use the five-file Design-Contract: 4 package plus static `tasks.md` definitions joined with the slim runtime ledger.
