import { isValidConfigDir as isValidConfigDirCore } from '@autocode/core/security/config-path-validator';

export function isValidConfigDir(configDir: string): boolean {
  return isValidConfigDirCore(configDir, {
    logRejected: (input, normalizedPath) => {
      console.warn('[Config Path Validator] Rejected unsafe configDir path:', input, '(normalized:', normalizedPath, ')');
    },
  });
}
