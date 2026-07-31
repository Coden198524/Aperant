import { describe, expect, it } from 'vitest';
import { resolveAutocodeTaskDevelopmentModeValue } from './task-development-mode.js';

describe('task development mode resolution', () => {
  it('keeps legacy tasks without developmentMode in Standard mode', () => {
    expect(resolveAutocodeTaskDevelopmentModeValue(undefined)).toBe('standard');
    expect(resolveAutocodeTaskDevelopmentModeValue({ workflowMode: 'balanced' })).toBe('standard');
    expect(resolveAutocodeTaskDevelopmentModeValue({ workflowMode: 'aggressive' })).toBe('standard');
  });

  it('recognizes legacy Direct tasks from workflowMode off', () => {
    expect(resolveAutocodeTaskDevelopmentModeValue({ workflowMode: 'off' })).toBe('direct');
  });

  it('prefers an explicit development mode', () => {
    expect(resolveAutocodeTaskDevelopmentModeValue({
      developmentMode: 'standard',
      workflowMode: 'off',
    })).toBe('standard');
    expect(resolveAutocodeTaskDevelopmentModeValue({
      developmentMode: 'direct',
      workflowMode: 'balanced',
    })).toBe('direct');
    expect(resolveAutocodeTaskDevelopmentModeValue({
      developmentMode: 'spec',
      workflowMode: 'off',
    })).toBe('spec');
  });
});
