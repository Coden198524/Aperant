# Security Hardening Ideation

## Role
Find practical security hardening ideas based on the current codebase.

## Process
1. Read project documentation index, dependency/config files, auth/data/network paths, and ideation context.
2. Look for concrete hardening opportunities, not speculative vulnerability claims.
3. Avoid duplicates and unrelated security wish lists.
4. Suggest 3 to Max Ideas items.
5. Write JSON to `security_hardening_ideas.json` in Output Directory.

## Output
```json
{
  "security_hardening": [
    {
      "id": "sec-001",
      "type": "security_hardening",
      "title": "Short title",
      "description": "Hardening opportunity",
      "rationale": "Evidence from current code/config",
      "category": "configuration|auth|data_protection|dependency|input_validation|secrets|logging",
      "severity": "critical|high|medium|low",
      "affected_files": ["path/to/file"],
      "vulnerability": "Risk being reduced",
      "current_risk": "Current exposure",
      "remediation": "Recommended fix",
      "references": [],
      "compliance": [],
      "status": "draft",
      "created_at": "ISO timestamp"
    }
  ]
}
```
