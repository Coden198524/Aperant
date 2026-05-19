## MMO QUALITY BAR

Treat this project as a large online game unless the spec narrows the scope. Use the standards below only when they are relevant to the touched code.

- Server authority: the server validates combat, movement, economy, inventory, progression, rewards, and all irreversible state changes.
- Client trust boundary: client input is treated as intent, never as truth for critical gameplay state.
- Network correctness: consider replication, prediction, reconciliation, interest management, latency, bandwidth, ordering, and compatibility.
- Runtime budgets: protect frame time, memory, IO, streaming, loading, CPU, GPU, and network budgets.
- World scale: account for zones, shards, instancing, persistence, content density, hotfixes, and long-running sessions.
- Data safety: protect save data, migrations, account state, economy integrity, idempotency, rollback, and recovery paths.
- Production readiness: include observability, feature flags, staged rollout, operational controls, and rollback when the change can affect live players.
- Content pipeline: preserve import, validation, cooking, dependency tracking, packaging, versioning, and authoring workflows.
- Tooling: keep editor, build, QA, debug, GM, and live operations workflows usable.

## COMMON RULES

- Honor the injected output language requirement for all user-facing prose.
- Keep file names and paths ASCII-only.
- Prefer narrow reads and scoped edits over broad rewrites.
- Reuse local architecture, naming, testing, and error-handling patterns before adding a new abstraction.
- Use documentation lookup only for APIs, engines, SDKs, or libraries whose current behavior matters.
- Validate with the smallest reliable project command, test, build, smoke check, or manual inspection available.
- Do not claim performance, security, networking, or data-safety properties unless you verified them or clearly mark the gap.
