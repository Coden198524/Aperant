import { joinPaths } from '../platform/os.js';

export interface AutocodeClaudeAutoSwitchSettings {
  enabled: boolean;
  proactiveSwapEnabled: boolean;
  usageCheckInterval: number;
  sessionThreshold: number;
  weeklyThreshold: number;
  autoSwitchOnRateLimit: boolean;
  autoSwitchOnAuthFailure: boolean;
}

export interface AutocodeClaudeProfileStoreProfile {
  id: string;
  name: string;
  configDir?: string;
  oauthToken?: string;
  tokenCreatedAt?: Date | string | number;
  createdAt: Date | string | number;
  lastUsedAt?: Date | string | number;
  usage?: {
    lastUpdated: Date | string | number;
  };
  rateLimitEvents?: Array<{
    hitAt: Date | string | number;
    resetAt: Date | string | number;
  }>;
}

export interface AutocodeProfileStoreData<TProfile extends AutocodeClaudeProfileStoreProfile = AutocodeClaudeProfileStoreProfile> {
  version: number;
  profiles: TProfile[];
  activeProfileId: string;
  autoSwitch?: AutocodeClaudeAutoSwitchSettings;
  accountPriorityOrder?: string[];
  migratedProfileIds?: string[];
}

export interface NormalizeAutocodeProfileStoreOptions<TProfile extends AutocodeClaudeProfileStoreProfile = AutocodeClaudeProfileStoreProfile> {
  migrateLegacyProfile?: (profile: TProfile) => string | undefined;
  logger?: {
    warn?: (...args: unknown[]) => void;
  };
}

export const AUTOCODE_PROFILE_STORE_VERSION = 3;

export const DEFAULT_AUTOCODE_AUTO_SWITCH_SETTINGS: AutocodeClaudeAutoSwitchSettings = {
  enabled: false,
  proactiveSwapEnabled: false,
  sessionThreshold: 95,
  weeklyThreshold: 99,
  autoSwitchOnRateLimit: false,
  autoSwitchOnAuthFailure: false,
  usageCheckInterval: 30000,
};

export function getAutocodeDefaultClaudeConfigDir(homeDir: string): string {
  return joinPaths(homeDir, '.claude');
}

export function getAutocodeClaudeProfilesDir(homeDir: string): string {
  return joinPaths(homeDir, '.claude-profiles');
}

export function slugifyAutocodeClaudeProfileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'primary';
}

export function usesAutocodeLegacySharedClaudeDirectory(
  profile: Pick<AutocodeClaudeProfileStoreProfile, 'configDir'>,
  homeDir: string,
): boolean {
  if (!profile.configDir) return false;

  const normalizedConfigDir = profile.configDir.startsWith('~')
    ? joinPaths(homeDir, profile.configDir.slice(1))
    : profile.configDir;

  return normalizedConfigDir === getAutocodeDefaultClaudeConfigDir(homeDir);
}

export function normalizeAutocodeProfileStoreData<TProfile extends AutocodeClaudeProfileStoreProfile>(
  data: Record<string, unknown>,
  options: NormalizeAutocodeProfileStoreOptions<TProfile> = {},
): AutocodeProfileStoreData<TProfile> | null {
  const migratedData = { ...data };

  if (migratedData.version === 1) {
    migratedData.version = AUTOCODE_PROFILE_STORE_VERSION;
    migratedData.autoSwitch = DEFAULT_AUTOCODE_AUTO_SWITCH_SETTINGS;
  }

  if (migratedData.version !== AUTOCODE_PROFILE_STORE_VERSION) {
    return null;
  }

  const rawProfiles = Array.isArray(migratedData.profiles)
    ? migratedData.profiles as TProfile[]
    : [];
  const newlyMigratedProfileIds: string[] = [];

  const profiles = rawProfiles.map((profile) => {
    if (profile.oauthToken) {
      options.logger?.warn?.('[ProfileStorage] Migrating profile - removing cached oauthToken:', profile.name);
    }

    const {
      oauthToken: _oauthToken,
      tokenCreatedAt: _tokenCreatedAt,
      ...profileWithoutToken
    } = profile;

    let configDir = profileWithoutToken.configDir;
    const migratedConfigDir = options.migrateLegacyProfile?.(profile);
    if (migratedConfigDir) {
      configDir = migratedConfigDir;
      newlyMigratedProfileIds.push(profile.id);
      options.logger?.warn?.('[ProfileStorage] Profile isolation migration:', {
        profileName: profile.name,
        oldConfigDir: profile.configDir,
        newConfigDir: configDir,
      });
    }

    return {
      ...profileWithoutToken,
      configDir,
      createdAt: new Date(profile.createdAt),
      lastUsedAt: profile.lastUsedAt ? new Date(profile.lastUsedAt) : undefined,
      usage: profile.usage
        ? {
            ...profile.usage,
            lastUpdated: new Date(profile.usage.lastUpdated),
          }
        : undefined,
      rateLimitEvents: profile.rateLimitEvents?.map((event) => ({
        ...event,
        hitAt: new Date(event.hitAt),
        resetAt: new Date(event.resetAt),
      })),
    } as TProfile;
  });

  const existingMigrated = Array.isArray(migratedData.migratedProfileIds)
    ? migratedData.migratedProfileIds.filter((id): id is string => typeof id === 'string')
    : [];
  const migratedProfileIds = [...new Set([...existingMigrated, ...newlyMigratedProfileIds])];

  const normalized: AutocodeProfileStoreData<TProfile> = {
    ...(migratedData as unknown as AutocodeProfileStoreData<TProfile>),
    version: AUTOCODE_PROFILE_STORE_VERSION,
    profiles,
    activeProfileId: typeof migratedData.activeProfileId === 'string' ? migratedData.activeProfileId : '',
  };

  if (migratedProfileIds.length > 0) {
    normalized.migratedProfileIds = migratedProfileIds;
  }

  return normalized;
}
