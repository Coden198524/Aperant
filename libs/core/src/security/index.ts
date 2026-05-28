export {
  crossPlatformBasename,
  containsWindowsPath,
  extractCommands,
  getCommandForValidation,
  splitCommandSegments,
} from './command-parser.js';

export {
  BLOCKED_COMMANDS,
  isCommandBlocked,
} from './denylist.js';
export type { ValidationResult as DenylistValidationResult } from './denylist.js';

export {
  VALIDATORS,
  bashSecurityHook,
  getValidator,
  isCommandAllowed,
  validateCommand,
} from './bash-validator.js';
export type {
  HookInputData,
  SecurityProfile,
  ValidationResult,
  ValidatorFunction,
} from './bash-validator.js';

export {
  assertPathContained,
  isPathContained,
} from './path-containment.js';
export type { PathContainmentResult } from './path-containment.js';

export {
  getSecurityProfile,
  resetProfileCache,
} from './security-profile.js';

export {
  ALL_PATTERNS,
  DATABASE_PATTERNS,
  GENERIC_PATTERNS,
  PRIVATE_KEY_PATTERNS,
  SERVICE_PATTERNS,
  isFalsePositive,
  loadSecretsIgnore,
  maskSecret,
  scanContent,
  scanFiles,
  shouldSkipFile,
} from './secret-scanner.js';
export type { SecretMatch } from './secret-scanner.js';

export {
  getSafeToolInput,
  validateToolInput,
} from './tool-input-validator.js';
export type { ToolValidationResult } from './tool-input-validator.js';

export {
  validateDropdbCommand,
  validateDropuserCommand,
  validateMongoshCommand,
  validateMysqlCommand,
  validateMysqladminCommand,
  validatePsqlCommand,
  validateRedisCliCommand,
} from './validators/database-validators.js';

export {
  validateChmodCommand,
  validateInitScript,
  validateRmCommand,
} from './validators/filesystem-validators.js';

export { validateGitCommand } from './validators/git-validators.js';

export {
  validateKillCommand,
  validateKillallCommand,
  validatePkillCommand,
} from './validators/process-validators.js';

export {
  validateBashSubshell,
  validateShSubshell,
  validateShellCCommand,
  validateZshSubshell,
} from './validators/shell-validators.js';
