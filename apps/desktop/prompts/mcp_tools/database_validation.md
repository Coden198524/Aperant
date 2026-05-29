# Database Validation Tools

Use database validation when the task touches schema, migrations, queries, repositories, seeds, or persistence behavior.

## Validate
- Migration applies and rolls back when supported.
- Query shape, indexes, and constraints match expected behavior.
- Existing data compatibility and default values are handled.
- Transactions, concurrency, and error paths are safe where relevant.
- Tests cover changed persistence behavior.

## Suggested Checks
- Migration command.
- Repository/model tests.
- Targeted integration test with a test database.
- Static query or ORM typecheck.

## Report
Include migration status, tests run, data compatibility notes, and unresolved risks.
