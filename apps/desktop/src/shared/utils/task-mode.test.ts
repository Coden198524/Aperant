import { describe, it, expect } from 'vitest';
import {
  isDirectDevelopmentMetadata,
  isDirectDevelopmentPlan,
  isDirectDevelopmentTask,
  isSpecDevelopmentTask,
  isStandardDevelopmentTask,
  resolveTaskDevelopmentMode,
  workflowModeForDevelopmentMode,
} from './task-mode';

describe('task-mode', () => {
  describe('resolveTaskDevelopmentMode', () => {
    it('prefers an explicit developmentMode', () => {
      expect(resolveTaskDevelopmentMode({ developmentMode: 'direct' })).toBe('direct');
      expect(resolveTaskDevelopmentMode({ developmentMode: 'standard', workflowMode: 'off' })).toBe('standard');
      expect(resolveTaskDevelopmentMode({ developmentMode: 'spec', workflowMode: 'off' })).toBe('spec');
    });

    it('maps workflowMode "off" to direct when no explicit mode is set', () => {
      expect(resolveTaskDevelopmentMode({ workflowMode: 'off' })).toBe('direct');
    });

    it('defaults to standard', () => {
      expect(resolveTaskDevelopmentMode(undefined)).toBe('standard');
      expect(resolveTaskDevelopmentMode({})).toBe('standard');
      expect(resolveTaskDevelopmentMode({ workflowMode: 'balanced' })).toBe('standard');
    });

    it('honors a custom default mode', () => {
      expect(resolveTaskDevelopmentMode(undefined, 'direct')).toBe('direct');
    });
  });

  describe('workflowModeForDevelopmentMode', () => {
    it('maps direct to off and non-legacy modes to balanced', () => {
      expect(workflowModeForDevelopmentMode('direct')).toBe('off');
      expect(workflowModeForDevelopmentMode('standard')).toBe('balanced');
      expect(workflowModeForDevelopmentMode('spec')).toBe('balanced');
    });
  });

  describe('isDirectDevelopmentMetadata', () => {
    it('recognizes developmentMode="direct" even without workflowMode', () => {
      // Regression: WorkspaceMessages previously only checked workflowMode === 'off'.
      expect(isDirectDevelopmentMetadata({ developmentMode: 'direct' })).toBe(true);
    });

    it('recognizes workflowMode="off"', () => {
      expect(isDirectDevelopmentMetadata({ workflowMode: 'off' })).toBe(true);
    });

    it('returns false for standard metadata', () => {
      expect(isDirectDevelopmentMetadata({ workflowMode: 'balanced' })).toBe(false);
      expect(isDirectDevelopmentMetadata(undefined)).toBe(false);
    });
  });

  describe('isDirectDevelopmentPlan', () => {
    it('recognizes direct workflow_type', () => {
      expect(isDirectDevelopmentPlan({ workflow_type: 'direct' })).toBe(true);
    });

    it('recognizes enabled direct_execution', () => {
      expect(isDirectDevelopmentPlan({ direct_execution: { enabled: true } })).toBe(true);
    });

    it('returns false otherwise', () => {
      expect(isDirectDevelopmentPlan(null)).toBe(false);
      expect(isDirectDevelopmentPlan({ workflow_type: 'standard' })).toBe(false);
      expect(isDirectDevelopmentPlan({ direct_execution: { enabled: false } })).toBe(false);
    });
  });

  describe('isDirectDevelopmentTask', () => {
    it('is true when metadata resolves to direct', () => {
      expect(isDirectDevelopmentTask({ metadata: { developmentMode: 'direct' } })).toBe(true);
    });

    it('is true when the plan carries direct markers even if metadata is standard', () => {
      expect(
        isDirectDevelopmentTask({ metadata: { workflowMode: 'balanced' } }, { workflow_type: 'direct' }),
      ).toBe(true);
    });

    it('is false when neither metadata nor plan indicate direct', () => {
      expect(isDirectDevelopmentTask({ metadata: { workflowMode: 'balanced' } }, { workflow_type: 'standard' })).toBe(false);
      expect(isDirectDevelopmentTask(undefined)).toBe(false);
    });
  });

  describe('explicit workflow predicates', () => {
    it('does not treat Spec as Standard', () => {
      const task = { metadata: { developmentMode: 'spec' as const } };
      expect(isSpecDevelopmentTask(task)).toBe(true);
      expect(isStandardDevelopmentTask(task)).toBe(false);
      expect(isDirectDevelopmentTask(task)).toBe(false);
    });

    it('recognizes only Standard as Standard', () => {
      const task = { metadata: { developmentMode: 'standard' as const } };
      expect(isStandardDevelopmentTask(task)).toBe(true);
      expect(isSpecDevelopmentTask(task)).toBe(false);
    });
  });
});
