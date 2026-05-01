/**
 * Clean Implementation Plan Output Schema
 * ========================================
 *
 * For use with AI SDK Output.object() constrained decoding.
 * Simplified structure suitable for provider-level schema enforcement.
 *
 * For file-based validation with LLM field coercion, use
 * ImplementationPlanSchema from '../implementation-plan' instead.
 */

import { z } from 'zod';

const SubtaskOutputSchema = z.object({
  id: z.string().max(80),
  title: z.string().max(120),
  description: z.string().max(700),
  status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'failed']),
  files_to_create: z.array(z.string().max(240)).max(12),
  files_to_modify: z.array(z.string().max(240)).max(12),
});

const PhaseOutputSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(120),
  subtasks: z.array(SubtaskOutputSchema).min(1),
});

export const ImplementationPlanOutputSchema = z.object({
  feature: z.string().max(240),
  workflow_type: z.string().max(40),
  phases: z.array(PhaseOutputSchema).min(1),
});

export type ImplementationPlanOutput = z.infer<typeof ImplementationPlanOutputSchema>;
export type PhaseOutput = z.infer<typeof PhaseOutputSchema>;
export type SubtaskOutput = z.infer<typeof SubtaskOutputSchema>;
