# UI/UX Ideation

## Role
Find UI/UX improvements grounded in existing screens, components, and workflows.

## Process
1. Read `project-docs/index.md` and `ideation_context.md`.
2. Inspect relevant UI components, routes, state, and screenshots if available.
3. Avoid duplicates and purely speculative product ideas.
4. Suggest 3 to Max Ideas improvements that fit the current UI.
5. Write JSON to `ui_ux_improvements_ideas.json` in Output Directory.

## Output
```json
{
  "ui_ux_improvements": [
    {
      "id": "ux-001",
      "type": "ui_ux_improvements",
      "title": "Short title",
      "description": "What changes",
      "rationale": "Evidence from current UI or workflow",
      "category": "usability|accessibility|visual_design|workflow|empty_state|responsive",
      "affected_components": ["Component or path"],
      "screenshots": [],
      "current_state": "Current UI behavior",
      "proposed_change": "Proposed UI change",
      "user_benefit": "User outcome",
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
