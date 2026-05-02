import { z } from 'zod';

const FileReferenceOutputSchema = z.object({
  path: z.string(),
  reason: z.string(),
  pattern: z.string(),
});

const FileModificationOutputSchema = z.object({
  path: z.string(),
  reason: z.string(),
  change_needed: z.string(),
});

const DesignPatternOutputSchema = z.object({
  name: z.string(),
  existing_usage: z.string(),
  files: z.array(z.string()),
  guidance: z.string(),
});

export const SpecContextOutputSchema = z.object({
  task_description: z.string(),
  scoped_services: z.array(z.string()),
  architecture_summary: z.string(),
  files_to_modify: z.array(FileModificationOutputSchema),
  files_to_reference: z.array(FileReferenceOutputSchema),
  design_patterns: z.array(DesignPatternOutputSchema),
  implementation_notes: z.array(z.string()),
  risks: z.array(z.string()),
  verification_suggestions: z.array(z.string()),
  created_at: z.string(),
});

export const RequirementsOutputSchema = z.object({
  task_description: z.string(),
  workflow_type: z.enum(['feature', 'refactor', 'investigation', 'migration', 'simple', 'bugfix']),
  services_involved: z.array(z.string()),
  user_requirements: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  constraints: z.array(z.string()),
  created_at: z.string(),
});

const ResearchIntegrationOutputSchema = z.object({
  name: z.string(),
  type: z.string(),
  verified_package: z.object({
    name: z.string(),
    install_command: z.string(),
    version: z.string(),
    verified: z.boolean(),
  }),
  api_patterns: z.object({
    imports: z.array(z.string()),
    initialization: z.string(),
    key_functions: z.array(z.string()),
    verified_against: z.string(),
  }),
  configuration: z.object({
    env_vars: z.array(z.string()),
    config_files: z.array(z.string()),
    dependencies: z.array(z.string()),
  }),
  gotchas: z.array(z.string()),
  research_sources: z.array(z.string()),
});

export const ResearchOutputSchema = z.object({
  integrations_researched: z.array(ResearchIntegrationOutputSchema),
  unverified_claims: z.array(z.object({
    claim: z.string(),
    reason: z.string(),
    risk_level: z.enum(['low', 'medium', 'high']),
  })),
  recommendations: z.array(z.string()),
  created_at: z.string(),
});

export type SpecContextOutput = z.infer<typeof SpecContextOutputSchema>;
export type RequirementsOutput = z.infer<typeof RequirementsOutputSchema>;
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;
