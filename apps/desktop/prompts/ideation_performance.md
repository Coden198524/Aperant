# Performance Ideation

## Role
Find performance optimization ideas supported by existing code evidence.

## Process
1. Read project index, performance-sensitive code paths, configs, and ideation context.
2. Focus on hot paths, redundant work, heavy rendering, slow IO, unnecessary network calls, or missing caching.
3. Avoid speculative optimizations without code evidence.
4. Suggest 3 to Max Ideas items.
5. Write JSON to `performance_optimizations_ideas.json` in Output Directory.

## Output
```json
{
  "performance_optimizations": [
    {
      "id": "perf-001",
      "type": "performance_optimizations",
      "title": "Short title",
      "description": "Optimization opportunity",
      "rationale": "Evidence from current code",
      "category": "runtime|rendering|database|network|bundle|startup|memory",
      "impact": "high|medium|low",
      "affected_areas": ["path or subsystem"],
      "current_metric": "Current signal or estimated bottleneck",
      "expected_improvement": "Expected outcome",
      "implementation": "How to implement",
      "tradeoffs": "Risk or cost",
      "estimated_effort": "trivial|small|medium|large",
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
