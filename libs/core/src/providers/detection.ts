export type ApiProvider = 'anthropic' | 'openai' | 'zai' | 'zhipu' | 'unknown';

interface ProviderPattern {
  provider: ApiProvider;
  domainPatterns: string[];
}

const PROVIDER_PATTERNS: readonly ProviderPattern[] = [
  {
    provider: 'anthropic',
    domainPatterns: ['api.anthropic.com'],
  },
  {
    provider: 'zai',
    domainPatterns: ['api.z.ai', 'z.ai'],
  },
  {
    provider: 'openai',
    domainPatterns: ['chatgpt.com', 'api.openai.com'],
  },
  {
    provider: 'zhipu',
    domainPatterns: ['open.bigmodel.cn', 'dev.bigmodel.cn', 'bigmodel.cn'],
  },
] as const;

export function detectApiProvider(baseUrl: string): ApiProvider {
  try {
    const url = new URL(baseUrl);
    const domain = url.hostname;

    for (const pattern of PROVIDER_PATTERNS) {
      for (const patternDomain of pattern.domainPatterns) {
        if (domain === patternDomain || domain.endsWith(`.${patternDomain}`)) {
          return pattern.provider;
        }
      }
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function getApiProviderLabel(provider: ApiProvider): string {
  switch (provider) {
    case 'anthropic':
      return 'Anthropic';
    case 'zai':
      return 'z.ai';
    case 'openai':
      return 'OpenAI';
    case 'zhipu':
      return 'ZHIPU AI';
    case 'unknown':
      return 'Unknown';
  }
}
