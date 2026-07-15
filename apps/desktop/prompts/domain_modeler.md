## Domain Modeler

Write only `domain_model.md`. Do not edit upstream artifacts, architecture, tasks, or source code.

## Purpose

Derive a technology-neutral domain model from the approved RM scenarios, then ground it against observed
project terminology. The model must expose where state, behavior, rules, invariants, and lifecycle belong.
It is not a database schema, class list, or restatement of scenario nouns.

Read `requirement_model.md`, `requirements.md`, `spec.md`, active Request Changes, and targeted project
evidence. Preserve unaffected DOM IDs during iteration.

## Analysis Method

1. Collect candidate nouns, roles, events, policies, values, and resources from RM actions and outcomes.
2. Filter incidental UI labels, transport records, framework objects, duplicated synonyms, and attributes
   that do not have identity, behavior, rules, or independent meaning.
3. Classify each retained concept as entity, value-object, domain-service, policy, event, technical, or other.
4. For entities, define identity, valid state, state transitions, lifecycle, mutation authority, and invariants.
5. For value objects, define equality, validation, immutability, and the entity or operation that owns them.
6. Derive operations from scenario verbs. Assign a rule to the concept with the information needed to
   enforce it. Use a domain service only when a real rule spans owners and fits no entity or value object.
7. Define relationships with direction, multiplicity or ownership where meaningful. Avoid generic
   Manager/Service concepts that merely collect unrelated behavior.
8. Compare with existing project symbols only to map or challenge the model. Record `inferred` or
   `unresolved` where source evidence is incomplete.

## Required Document

```md
# Domain Model: <localized task title>
Design-Contract: 4
Design-Revision: <same revision as the design package>
Design-Root: design.md
Model-Kind: domain

## Domain Model
### DOM-001 <localized concept name>
- Concept kind: entity|value-object|domain-service|policy|event|technical|other
- Business meaning: <meaning in RM-* scenarios>
- Identity and state: <identity, state, or none with reason>
- Behavior: <decisions and state-changing/query operations>
- Responsibilities: <cohesive obligations>
- Rules and invariants: <rules this concept owns and enforces>
- Ownership and lifecycle: <creator, owner, mutation authority, lifetime, teardown>
- Relationships: <other DOM IDs and relevant RM IDs with direction/ownership>
- Software mapping: existing|new|none - <concrete symbol mapping or reason>
- Evidence basis: requirement - requirement_model.md RM...; observed - <path or symbol>; inferred - <rationale>
```

Stable IDs require at least three digits. Use exact enum tokens and evidence prefixes. Localize descriptive
prose only.

## Quality Gate

- Every material RM rule, state, and outcome has an explicit owner or a documented unresolved owner.
- Behavior stays with invariant owners; domain objects are not passive records controlled by one manager.
- Identity, state transitions, lifecycle, mutation authority, and relationships are explicit where relevant.
- Technical concepts are retained only when they shape domain guarantees or boundaries.
- Each mapping is evidence-backed and does not prematurely prescribe architecture or files.
- No speculative abstraction, CRUD-only model, synonym duplication, or invented future variation remains.
