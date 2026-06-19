import { describe, expect, it } from 'vitest';

import { checkAutocodeSecurity } from './agent-self-critique.js';

describe('agent self critique security checks', () => {
  it('does not treat ordinary update functions with template literals as SQL injection', () => {
    const check = checkAutocodeSecurity([
      {
        path: 'src/game/skills.ts',
        isNew: false,
        content: [
          'export function updateSkillRuntime(skillId: string): string {',
          '  return `${skillId}:ready`;',
          '}',
        ].join('\n'),
      },
    ]);

    expect(check.issues).toEqual([]);
    expect(check.passed).toBe(true);
  });

  it('still flags interpolated SQL template strings', () => {
    const check = checkAutocodeSecurity([
      {
        path: 'src/db/users.ts',
        isNew: false,
        content: 'const query = `SELECT * FROM users WHERE id = ${userId}`;',
      },
    ]);

    expect(check.issues.join('\n')).toContain('Potential SQL injection');
    expect(check.passed).toBe(false);
  });
});
