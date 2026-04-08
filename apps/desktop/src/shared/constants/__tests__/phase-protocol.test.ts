import { describe, expect, it } from 'vitest';

import {
  isAllowedPhaseRegression,
  isValidPhaseTransition,
  type CompletablePhase,
} from '../phase-protocol';

describe('phase protocol recovery transitions', () => {
  it('allows qa_review to return to coding for recovery', () => {
    const completedPhases: CompletablePhase[] = ['planning', 'coding'];

    expect(isAllowedPhaseRegression('qa_review', 'coding')).toBe(true);
    expect(isValidPhaseTransition('qa_review', 'coding', completedPhases)).toBe(true);
  });

  it('allows qa_fixing to return to coding for recovery', () => {
    const completedPhases: CompletablePhase[] = ['planning', 'coding', 'qa_review'];

    expect(isAllowedPhaseRegression('qa_fixing', 'coding')).toBe(true);
    expect(isValidPhaseTransition('qa_fixing', 'coding', completedPhases)).toBe(true);
  });
});
