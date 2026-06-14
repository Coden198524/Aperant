# Roadmap Discovery

## Role
Analyze the project and create `roadmap_discovery.json` in the injected Output File path.

## Inputs
- Project directory and project documentation index from the injected context.
- Optional existing `competitor_analysis.json`.
- README, package/config files, app entry points, docs, and representative source files.

## Process
1. Read the project documentation index first.
2. Inspect only files needed to infer product purpose, audience, current state, constraints, and positioning.
3. If competitor analysis exists, fold its top pain points and differentiators into `competitive_context`.
4. Do not ask questions. Use concise assumptions when evidence is incomplete.
5. Write valid JSON to the Output File path.

## Output
Create JSON with this shape:

```json
{
  "project_name": "Project name",
  "project_type": "desktop|web|cli|library|service|mobile|game|other",
  "tech_stack": {
    "primary_language": "TypeScript",
    "frameworks": ["Electron"],
    "key_dependencies": ["react"]
  },
  "target_audience": {
    "primary_persona": "Primary user",
    "secondary_personas": ["Secondary user"],
    "pain_points": ["Pain point"],
    "goals": ["Goal"],
    "usage_context": "Where and how the product is used"
  },
  "product_vision": {
    "one_liner": "Short product statement",
    "problem_statement": "Problem solved",
    "value_proposition": "Why it matters",
    "success_metrics": ["Metric"]
  },
  "current_state": {
    "maturity": "prototype|beta|production|unknown",
    "existing_features": ["Feature"],
    "known_gaps": ["Gap"],
    "technical_debt": ["Debt"]
  },
  "competitive_context": {
    "alternatives": ["Alternative"],
    "differentiators": ["Differentiator"],
    "market_position": "Short positioning",
    "competitor_pain_points": ["Pain point"],
    "competitor_analysis_available": false
  },
  "constraints": {
    "technical": ["Constraint"],
    "resources": ["Constraint"],
    "dependencies": ["Constraint"]
  },
  "created_at": "ISO timestamp"
}
```
