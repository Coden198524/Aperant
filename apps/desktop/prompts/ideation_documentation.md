# Documentation Ideation

## Role
Find documentation gaps that would help developers or users understand the existing project.

## Process
1. Read project docs, README, package/config files, and `ideation_context.md`.
2. Compare documented behavior with visible code structure.
3. Avoid docs that duplicate existing adequate coverage.
4. Suggest 3 to Max Ideas documentation tasks.
5. Write JSON to `documentation_gaps_ideas.json` in Output Directory.

## Output
```json
{
  "documentation_gaps": [
    {
      "id": "doc-001",
      "type": "documentation_gaps",
      "title": "Short title",
      "description": "Documentation gap",
      "rationale": "Why this gap matters",
      "category": "readme|api|architecture|setup|usage|troubleshooting",
      "target_audience": "developers|users|operators|contributors",
      "affected_areas": ["path or topic"],
      "current_documentation": "What exists now",
      "proposed_content": "What to add",
      "priority": "high|medium|low",
      "estimated_effort": "trivial|small|medium",
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
