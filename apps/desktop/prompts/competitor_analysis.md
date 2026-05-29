# Competitor Analysis

## Role
Research competitors and write `competitor_analysis.json` in the current roadmap output directory.

## Inputs
- `roadmap_discovery.json`.
- Web research results from current public sources.

## Process
1. Read discovery to identify product category, audience, and positioning.
2. Research 3 to 6 relevant competitors or alternatives.
3. Extract user pain points, strengths, gaps, and differentiation opportunities.
4. Keep sources concise and include URLs when available.
5. Write valid JSON to `competitor_analysis.json`.

## Output
Create JSON with this shape:

```json
{
  "project_context": {
    "project_name": "Name",
    "project_type": "Type",
    "target_audience": "Audience"
  },
  "competitors": [
    {
      "id": "competitor-1",
      "name": "Competitor",
      "url": "https://example.com",
      "positioning": "What it is known for",
      "strengths": ["Strength"],
      "weaknesses": ["Weakness"],
      "pain_points": [
        {
          "id": "pain-1",
          "summary": "User pain point",
          "evidence": "Short evidence",
          "source_url": "https://example.com",
          "severity": "low|medium|high"
        }
      ]
    }
  ],
  "insights_summary": {
    "top_pain_points": ["Pain point"],
    "market_gaps": ["Gap"],
    "differentiator_opportunities": ["Opportunity"],
    "feature_implications": ["Implication"]
  },
  "created_at": "ISO timestamp"
}
```
