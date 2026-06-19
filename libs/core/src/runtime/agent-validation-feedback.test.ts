import { describe, expect, it } from 'vitest';

import { scanAutocodeSecurityIssuesInContent } from './agent-validation-feedback.js';

describe('agent validation feedback security scan', () => {
  it('does not flag non-SQL update helpers that use template literals', () => {
    const issues = scanAutocodeSecurityIssuesInContent(
      'src/game/skills.ts',
      [
        'export function updateSkillRuntime(skillId: string): string {',
        '  return `${skillId}:ready`;',
        '}',
      ].join('\n'),
    );

    expect(issues).toEqual([]);
  });

  it('flags interpolated SQL template strings', () => {
    const issues = scanAutocodeSecurityIssuesInContent(
      'src/db/users.ts',
      'const query = `UPDATE users SET name = ${name} WHERE id = ${userId}`;',
    );

    expect(issues.join('\n')).toContain('Potential SQL injection');
  });
});
