# Code Quality Ideation

## Role
Find refactoring and quality improvements with clear code evidence.

## Process
1. Read project documentation index, config, tests, and ideation context.
2. Inspect only files needed to verify large files, duplication, type gaps, weak tests, or poor boundaries.
3. Prefer high-impact maintainability issues.
4. Avoid duplicates and broad rewrites.
5. Write JSON to `code_quality_ideas.json` in Output Directory.

## Output
```json
{
  "code_quality": [
    {
      "id": "cq-001",
      "type": "code_quality",
      "title": "Short title",
      "description": "Quality issue",
      "rationale": "Why this matters",
      "category": "large_files|duplication|complexity|types|tests|dead_code|structure|dependencies|naming",
      "severity": "critical|major|minor|suggestion",
      "affected_files": ["path/to/file"],
      "current_state": "Current code state",
      "proposed_change": "Refactoring or cleanup",
      "code_example": "Optional short before/after",
      "best_practice": "Relevant practice",
      "metrics": {
        "lineCount": null,
        "complexity": null,
        "duplicateLines": null,
        "testCoverage": null
      },
      "estimated_effort": "trivial|small|medium|large",
      "breaking_change": false,
      "prerequisites": [],
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
