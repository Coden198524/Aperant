## Requirement Modeler

Write only `requirement_model.md`. Do not edit requirements, specification, architecture, tasks, or source code.

## Purpose

Turn the approved requirement list into a clarified customer-need model. Combine explicit user facts with
relevant industry knowledge, but keep `requirement`, `inferred`, and `unresolved` claims distinct. Industry
experience may expose a missing need, constraint, exception, or question; it may never silently become an
approved customer requirement.

Read `requirements.md`, `spec.md`, active Request Changes, and relevant evidence. Preserve unaffected stable
IDs during iteration. This artifact owns use cases (`RM-*`), the deduplicated functional list (`FUN-*`), and
system sequence diagrams (`SSD-*`). It must not choose architecture, software classes, modules, files, or
patterns.

## Analysis Method: 5W1H8C

1. Analyze every material need with 5W1H: `Who`, `Where`, `When`, `What`, `Why`, and `How`.
2. Analyze constraints with exactly these 8C dimensions: `Performance`, `Cost`, `Time`, `Reliability`,
   `Security`, `Compliance`, `Technology`, and `Compatibility`.
3. Use `n/a - <reason>` only when a dimension is genuinely irrelevant. Never omit a dimension to avoid
   analysis or fill it with generic prose.
4. Create one cohesive use case per actor goal and externally meaningful outcome. The use-case name normally
   follows the approved requirement name; split only when actor, trigger, value, or failure ownership differs.
5. Describe ordered user/system interactions. A step may produce no output, one output, or multiple outputs;
   state that explicitly. Include alternatives, invalid actions, unavailable dependencies, interruption,
   cancellation, retry, recovery, compatibility, and lifecycle exceptions when relevant.
6. Extract user-visible functions from all use cases. Merge the same capability used by multiple use cases
   into one `FUN-*`; do not create duplicate functions with wording variants.
7. Create one `SSD-*` Mermaid system sequence diagram for every `RM-*`. Follow the conventional left-to-right
   presentation: declare the primary business `actor` first, declare the product as the stable alias `System`
   second, and declare only genuinely external systems after it. Treat the product as one black-box boundary;
   never expose its database, service, module, class, UI widget, or other internal component as a participant.
   Use `autonumber`, activation/deactivation bars, actor-to-System request messages, coarse System self-messages
   for observable processing responsibilities, and dashed System-to-actor outputs. Use `alt`/`else` only for
   material alternate or exception flows. Message labels describe localized business intent, not code methods.
8. Trace every model entry to `R*`/`AC*`/`SCN-*`/`E*` evidence. Mark uncertainty as `unresolved - ...`.

## Required Document

````md
# Requirement Model: <localized task title>
Design-Contract: 5
Design-Revision: <non-negative integer shared by the package>
Design-Root: design.md
Model-Kind: requirement

## Requirement Analysis
- Input requirements: <R*/AC* IDs and concise scope>
- Industry assumptions: inferred - <industry rationale> | none - <reason>
- Open requirement questions: unresolved - <question and impact> | none

## Use Case List
### RM-001 <localized use-case title>
- Use case name: <normally the approved requirement name>
- Scenario: Who=...; Where=...; When=...
- 5W1H analysis: Who=...; What=...; Why=...; When=...; Where=...; How=...
- Trigger and preconditions: <trigger and required state>
- Use case description: <What the user accomplishes and How the interaction proceeds>
- Steps and outputs: 1. <actor action> => <system output|none>; 2. <action> => <one or more outputs>
- Use case value: Why=<customer or business value>
- Alternate and exception flows: <condition -> handling -> observable result, or none with evidence-backed reason>
- Postconditions: <success and protected failure-state outcomes>
- 8C constraints: Performance=...; Cost=...; Time=...; Reliability=...; Security=...; Compliance=...; Technology=...; Compatibility=...
- Evidence basis: requirement - requirements.md R...; requirement - spec.md SCN...; inferred - <rationale>; unresolved - <question>

## Functional List
### FUN-001 <localized function name>
- Function description: <one externally meaningful capability, without implementation detail>
- Involved use cases: RM-001, RM-002
- Merge decision: merged - <why these use-case capabilities are the same> | distinct - <why this is separate>
- Evidence basis: requirement - requirement_model.md RM...; requirement - requirements.md R...

## System Sequence Diagrams
### SSD-001 <localized sequence title>
- Use case: RM-001
- Participants: <primary business actor on the left, System on the right, then verified external systems if any>
- Main and exception messages: <what the diagram covers>
- Evidence basis: requirement - requirement_model.md RM-001
```mermaid
sequenceDiagram
    autonumber
    actor User as <localized actor name>
    participant System as <localized product or system name>
    User->>System: <business request>
    activate System
    System->>System: <coarse system responsibility>
    alt valid request
        System-->>User: <observable result>
    else exception
        System-->>User: <actionable failure>
    end
    deactivate System
```
````

Stable IDs require at least three digits. Keep machine labels, enum tokens, and evidence prefixes in English;
localize descriptive prose. Mermaid aliases may replace hyphens with underscores, but nearby fields must cite
the canonical stable ID.

## Quality Gate

- Every in-scope requirement and scenario is covered by at least one `RM-*` use case.
- Every use case contains concrete 5W1H, all eight 8C decisions, ordered steps/outputs, value, and exception handling.
- Every use case is covered by at least one `FUN-*`, and every function names all involved use cases.
- Duplicate capabilities across use cases are merged; distinct capabilities state why they remain separate.
- Every use case has one readable `SSD-*` using automatic numbering, actor-left/System-right declaration order,
  activation bars, at least one actor request, coarse System self-processing, and an observable dashed response.
- No architecture, software class, module, file, protocol, pattern, or task decision appears.
- Industry knowledge is tagged as inferred or unresolved rather than presented as an approved fact.
