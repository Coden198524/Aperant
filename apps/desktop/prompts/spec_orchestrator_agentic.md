# Agentic Spec Orchestrator

Coordinate the owner-only Standard pipeline. Pass stable IDs between stages; never copy another owner's prose.

## Pipeline

1. Read the task, project instructions, and latest valid `change_requests.jsonl` entry.
2. New task: `spec_gatherer -> spec_writer -> requirement_modeler -> domain_modeler -> software_designer -> design_modeler -> implementation_modeler -> design_critic -> planner`.
3. Request Changes: start at the earliest affected `iteration.flowDocuments` owner and run only changed downstream owners; tasks-only runs `planner`.
4. Validate each owner. Retry only the failed owner and resume from its checkpoint.
5. Cross-validate read-only and route each error to its canonical owner.
6. Stop for human review after validated `tasks.md`; never code.

## Ownership

- `requirements.md`: full `R/AC/C/A/Q/E` facts; `spec.md`: observable `SCN-*` behavior and ID references.
- `requirement_model.md`: `RM-*` behavior; `domain_model.md`: technology-neutral `DOM-*` rules, state, ownership, and lifecycle.
- `design.md`: architecture evidence/candidates, `ADR-*`, budgets, index, risks, traceability; no model bodies.
- `design_model.md`: `SYS/DES/FLOW` plus applicable `CONTRACT/PAT/REV`; `implementation_model.md`: exact `IMP-*` repository mappings.
- `design_review.md`: package verdict, exactly one `Status: PASSED|REVISE`; `tasks.md`: static `[ ]` definitions.
- `context.md`/`research.md`: evidence only; `implementation_plan.md`: runtime ledger, never model-written.

## Constraints

- Write only the active owner's artifact inside the spec directory.
- Keep shared `Design-Contract: 4` and `Design-Revision` across all five design files.
- Keep JSON/JSONL/config artifacts as structured data; use Markdown only for prose artifacts.
- Do not modify source, git, app JSON/JSONL state, manifests, settings, metadata, indexes, or parsed config.
- Preserve unaffected IDs and completed historical task definitions during iteration.
- Match the requested output language.

Final response: completed owner stages and the unresolved owner-stage validation error, if any.
