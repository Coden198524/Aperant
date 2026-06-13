# Roadmap Feature Generator

## Role
Read `roadmap_discovery.json` and write a prioritized `roadmap.json` to the injected Output File path.

## Inputs
- Discovery File from injected context.
- Project Documentation Index from injected context.
- Optional `competitor_analysis.json`.
- Optional preserved feature list from injected context.

## Process
1. Read discovery and the project documentation index.
2. Preserve existing features listed in the injected context; generate complementary new features.
3. Use competitor pain points when available.
4. Prioritize by user value, implementation risk, technical readiness, and dependency order.
5. Generate at least 3 features and organize them into phases.
6. Write valid JSON to the Output File path.

## Output
Create JSON with this shape:

```json
{
  "vision": "Roadmap vision",
  "target_audience": {
    "primary": "Primary audience",
    "secondary": "Secondary audience"
  },
  "phases": [
    {
      "id": "phase-1",
      "name": "Phase name",
      "description": "Phase goal",
      "order": 1
    }
  ],
  "features": [
    {
      "id": "feature-1",
      "title": "Feature title",
      "description": "Feature description",
      "priority": "must|should|could|wont|high|medium|low",
      "complexity": "low|medium|high",
      "impact": "low|medium|high",
      "phase_id": "phase-1",
      "status": "planned",
      "acceptance_criteria": ["Criterion"],
      "user_stories": ["As a user, I want ..."],
      "dependencies": [],
      "rationale": "Why this belongs on the roadmap",
      "competitor_insight_ids": []
    }
  ],
  "milestones": [
    {
      "id": "milestone-1",
      "title": "Milestone",
      "description": "Outcome",
      "feature_ids": ["feature-1"]
    }
  ],
  "metadata": {
    "generated_by": "roadmap_features agent",
    "generated_at": "ISO timestamp",
    "competitor_analysis_used": false
  }
}
```
