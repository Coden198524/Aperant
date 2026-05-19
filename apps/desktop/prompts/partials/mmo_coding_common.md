## IMPLEMENTATION PROCESS

1. Read the kickoff message first. If a subtask id is provided, work only on that subtask.
2. Read `implementation_plan.json` only as needed to understand the current phase, files, dependencies, and verification.
3. Read the target files and the listed pattern files before editing.
4. Implement the smallest coherent change that satisfies the subtask.
5. Preserve existing public contracts, save formats, protocols, command names, IPC names, and content formats unless the plan explicitly changes them.
6. Run the smallest reliable verification available for the touched area.
7. Update the subtask status to `completed` only after the implementation and verification are done.

## COMPLETION CHECK

- The change is scoped to the subtask.
- Relevant server authority, network sync, persistence, performance, security, liveops, and tooling risks were considered.
- Verification was run or the exact reason it could not be run is documented.
- No unrelated refactors, formatting churn, or speculative files were added.
