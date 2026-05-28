/**
 * Project Analyzer Module
 * =======================
 *
 * Analyzes project structure to detect technology stacks,
 * frameworks, and generate security profiles with dynamic
 * command allowlisting.
 *
 * See apps/desktop/src/main/ai/project/ for the TypeScript implementation.
 */

export { analyzeProject, buildSecurityProfile, ProjectAnalyzer } from './analyzer.js';
export {
  BASE_COMMANDS,
  CLOUD_COMMANDS,
  CODE_QUALITY_COMMANDS,
  DATABASE_COMMANDS,
  FRAMEWORK_COMMANDS,
  INFRASTRUCTURE_COMMANDS,
  LANGUAGE_COMMANDS,
  PACKAGE_MANAGER_COMMANDS,
  VERSION_MANAGER_COMMANDS,
} from './command-registry.js';
export { FrameworkDetector } from './framework-detector.js';
export { StackDetector } from './stack-detector.js';
export {
  buildProjectIndex,
  runProjectIndexer,
} from './project-indexer.js';
export type {
  ConventionsInfo,
  CustomScripts,
  InfrastructureInfo,
  ProjectIndex,
  ProjectSourceSummary,
  ProjectSecurityProfile,
  SerializedSecurityProfile,
  ServiceInfo,
  TechnologyStack,
} from './types.js';
export { createCustomScripts, createProjectSecurityProfile, createTechnologyStack } from './types.js';
