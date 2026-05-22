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

// Provider types — first migration (Phase 2, leaf node).
export {
  SupportedProvider,
  type ProviderConfig,
  type ModelResolution,
  type ProviderCapabilities,
} from './providers/types';
