import { describe, expect, it } from 'vitest';
import {
  classifyAutocodeChangeRequestImpact,
  isAutocodeImplementationFailureFeedback,
} from './change-request-impact.js';

describe('change request impact classification', () => {
  it('classifies Chinese Standard feedback across requirements, design, and implementation', () => {
    const feedback =
      '\u65b0\u9700\u6c42\uff1a\u4fee\u6539\u8bbe\u8ba1\u548c\u67b6\u6784\uff0c\u7f16\u8bd1\u5931\u8d25\u65f6\u663e\u793a\u9519\u8bef\u3002';

    expect(classifyAutocodeChangeRequestImpact({
      feedback,
      scope: 'planning',
    })).toEqual([
      'requirements',
      'design',
      'tasks',
      'implementation',
      'validation',
    ]);
  });

  it('keeps implementation-only feedback focused outside Standard planning', () => {
    expect(classifyAutocodeChangeRequestImpact({
      feedback: 'Fix the button alignment only.',
      scope: 'implementation',
    })).toEqual(['implementation']);
  });

  it('recognizes common Chinese implementation failure reports', () => {
    expect(isAutocodeImplementationFailureFeedback('\u7c7b\u578b\u68c0\u67e5\u5931\u8d25')).toBe(true);
    expect(isAutocodeImplementationFailureFeedback('\u6d4b\u8bd5\u5931\u8d25')).toBe(true);
    expect(isAutocodeImplementationFailureFeedback('\u53ea\u4fee\u6539\u9700\u6c42\u6587\u6863')).toBe(false);
  });
});
