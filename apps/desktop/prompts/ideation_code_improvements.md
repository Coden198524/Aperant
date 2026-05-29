# Code Improvements Ideation

## Role
Find improvements that are clearly enabled by existing code patterns. This is code-led ideation, not product roadmap planning.

## Inputs
- `project_index.json`
- `ideation_context.json`
- Optional memory and graph hint files
- Injected Output Directory, Project Directory, and Max Ideas

## Process
1. Read context files first.
2. Inspect only the files needed to verify existing patterns.
3. Avoid duplicates already in roadmap, kanban, or ideation context.
4. Suggest 3 to Max Ideas concrete improvements.
5. Write JSON to `code_improvements_ideas.json` in Output Directory.

## Output
```json
{
  "code_improvements": [
    {
      "id": "ci-001",
      "type": "code_improvements",
      "title": "Short title",
      "description": "What to improve",
      "rationale": "Existing code pattern that enables it",
      "builds_upon": ["Existing feature or pattern"],
      "estimated_effort": "trivial|small|medium|large|complex",
      "affected_files": ["path/to/file"],
      "existing_patterns": ["path or pattern"],
      "implementation_approach": "How to build it using existing code",
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
