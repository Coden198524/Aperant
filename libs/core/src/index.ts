/**
 * @autocode/core — Headless agent core
 *
 * Shared across the desktop Electron app, the VS Code extension, and
 * future UIs (web, JetBrains, CLI). Owns the AI agent layer, auth,
 * worktree management, and security primitives.
 *
 * This package is **work-in-progress**. Code is being extracted from
 * apps/desktop/src/main/ in stages — see the project's extract-core
 * branch for the migration plan.
 */

export const CORE_PACKAGE_VERSION = '0.0.0';

// Provider types — phase 2 leaf node.
export {
  SupportedProvider,
  type ProviderConfig,
  type ModelResolution,
  type ProviderCapabilities,
} from './providers/types';

// Config types — phase 3. Includes the reasoning-API shape that
// shared/constants/models.ts re-exports back out for renderer code.
export {
  type ReasoningType,
  type ReasoningConfig,
  type ModelShorthand,
  type ThinkingLevel,
  type EffortLevel,
  type Phase,
  type PhaseModelConfig,
  type PhaseThinkingConfig,
  MODEL_ID_MAP,
  MODEL_BETAS_MAP,
  THINKING_BUDGET_MAP,
  EFFORT_LEVEL_MAP,
  ADAPTIVE_THINKING_MODELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  MODEL_PROVIDER_MAP,
  resolveReasoningParams,
  buildThinkingProviderOptions,
} from './config/types';
