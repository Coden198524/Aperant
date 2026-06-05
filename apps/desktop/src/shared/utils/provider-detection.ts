/**
 * Provider Detection Utilities
 *
 * Detects API provider type from baseUrl patterns.
 * Mirrors the logic from usage-monitor.ts for use in renderer process.
 *
 * NOTE: Keep this in sync with usage-monitor.ts provider detection logic
 */

import {
  detectApiProvider,
  getApiProviderLabel,
  type ApiProvider,
} from '@autocode/core/providers/detection';

export type { ApiProvider };

/**
 * Detect API provider from baseUrl
 * Extracts domain and matches against known provider patterns
 *
 * @param baseUrl - The API base URL (e.g., 'https://api.z.ai/api/anthropic')
 * @returns The detected provider type ('anthropic' | 'zai' | 'zhipu' | 'unknown')
 *
 * @example
 * detectProvider('https://api.anthropic.com') // returns 'anthropic'
 * detectProvider('https://api.z.ai/api/anthropic') // returns 'zai'
 * detectProvider('https://open.bigmodel.cn/api/anthropic') // returns 'zhipu'
 * detectProvider('https://unknown.com/api') // returns 'unknown'
 */
export function detectProvider(baseUrl: string): ApiProvider {
  return detectApiProvider(baseUrl);
}

/**
 * Get human-readable provider label
 *
 * @param provider - The provider type
 * @returns Display label for the provider
 */
export function getProviderLabel(provider: ApiProvider): string {
  return getApiProviderLabel(provider);
}

/**
 * Get provider badge color scheme
 *
 * @param provider - The provider type
 * @returns CSS classes for badge styling
 */
export function getProviderBadgeColor(provider: ApiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'bg-orange-500/10 text-orange-500 border-orange-500/20 hover:bg-orange-500/15';
    case 'zai':
      return 'bg-blue-500/10 text-blue-500 border-blue-500/20 hover:bg-blue-500/15';
    case 'openai':
      return 'bg-green-500/10 text-green-500 border-green-500/20 hover:bg-green-500/15';
    case 'zhipu':
      return 'bg-purple-500/10 text-purple-500 border-purple-500/20 hover:bg-purple-500/15';
    case 'unknown':
      return 'bg-gray-500/10 text-gray-500 border-gray-500/20 hover:bg-gray-500/15';
  }
}
