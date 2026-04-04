import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Database,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronUp,
  Globe
} from 'lucide-react';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Switch } from '../ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '../ui/select';
import { Separator } from '../ui/separator';
import { OllamaModelSelector } from '../onboarding/OllamaModelSelector';
import type { ProjectEnvConfig, ProjectSettings as ProjectSettingsType, MemoryEmbeddingProvider } from '../../../shared/types';

interface SecuritySettingsProps {
  envConfig: ProjectEnvConfig | null;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;

  // Password visibility
  showOpenAIKey: boolean;
  setShowOpenAIKey: React.Dispatch<React.SetStateAction<boolean>>;

  // Collapsible section
  expanded: boolean;
  onToggle: () => void;
}

export function SecuritySettings({
  envConfig,
  settings,
  setSettings,
  updateEnvConfig,
  showOpenAIKey,
  setShowOpenAIKey,
  expanded,
  onToggle
}: SecuritySettingsProps) {
  const { t } = useTranslation('settings');
  const getMemoryPlaceholder = (key: string, fallback: string): string =>
    t(`projectSections.memory.settings.placeholders.${key}`, { defaultValue: fallback });

  // Password visibility for multiple providers
  const [showApiKey, setShowApiKey] = useState<Record<string, boolean>>({
    openai: showOpenAIKey,
    voyage: false,
    google: false,
    azure: false
  });

  // Sync parent's showOpenAIKey prop to local state
  useEffect(() => {
    setShowApiKey(prev => ({ ...prev, openai: showOpenAIKey }));
  }, [showOpenAIKey]);

  const embeddingProvider = envConfig?.memoryProviderConfig?.embeddingProvider || 'ollama';

  // Toggle API key visibility
  const toggleShowApiKey = (key: string) => {
    const newValue = !showApiKey[key];
    setShowApiKey(prev => ({ ...prev, [key]: newValue }));
    // Sync with parent for OpenAI
    if (key === 'openai') {
      setShowOpenAIKey(newValue);
    }
  };

  // Handle Ollama model selection
  const handleOllamaModelSelect = (modelName: string, dim: number) => {
    updateEnvConfig({
      memoryProviderConfig: {
        ...envConfig?.memoryProviderConfig,
        embeddingProvider: 'ollama',
        ollamaEmbeddingModel: modelName,
        ollamaEmbeddingDim: dim,
      }
    });
  };

  if (!envConfig) return null;

  // Render provider-specific configuration fields
  const renderProviderFields = () => {
    // OpenAI
    if (embeddingProvider === 'openai') {
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.memory.settings.providers.openai.apiKeyLabel', {
                defaultValue: 'OpenAI API Key'
              })}{' '}
              {envConfig.openaiKeyIsGlobal
                ? t('projectSections.memory.settings.providers.openai.overrideBadge', {
                  defaultValue: '(Override)'
                })
                : ''}
            </Label>
            {envConfig.openaiKeyIsGlobal && (
              <span className="flex items-center gap-1 text-xs text-info">
                <Globe className="h-3 w-3" />
                {t('projectSections.memory.settings.providers.openai.usingGlobalKey', {
                  defaultValue: 'Using global key'
                })}
              </span>
            )}
          </div>
          {envConfig.openaiKeyIsGlobal ? (
            <p className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.openai.globalKeyDescription', {
                defaultValue: 'Using key from App Settings. Enter a project-specific key below to override.'
              })}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.openai.requiredDescription', {
                defaultValue: 'Required for OpenAI embeddings'
              })}
            </p>
          )}
          <div className="relative">
            <Input
              type={showApiKey['openai'] ? 'text' : 'password'}
              placeholder={envConfig.openaiKeyIsGlobal
                ? t('projectSections.memory.settings.providers.openai.overridePlaceholder', {
                  defaultValue: 'Enter to override global key...'
                })
                : getMemoryPlaceholder('openaiApiKey', 'sk-...')}
              value={envConfig.openaiKeyIsGlobal ? '' : (envConfig.openaiApiKey || '')}
              onChange={(e) => updateEnvConfig({ openaiApiKey: e.target.value || undefined })}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => toggleShowApiKey('openai')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey['openai']
                ? t('projectSections.memory.settings.providers.openai.hideKey', {
                  defaultValue: 'Hide OpenAI API key'
                })
                : t('projectSections.memory.settings.providers.openai.showKey', {
                  defaultValue: 'Show OpenAI API key'
                })}
            >
              {showApiKey['openai'] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.memory.settings.providers.shared.getKeyFrom', {
              defaultValue: 'Get your key from '
            })}
            <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">
              OpenAI
            </a>
          </p>
        </div>
      );
    }

    // Voyage AI
    if (embeddingProvider === 'voyage') {
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            {t('projectSections.memory.settings.providers.voyage.apiKeyLabel', {
              defaultValue: 'Voyage AI API Key'
            })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.memory.settings.providers.voyage.requiredDescription', {
              defaultValue: 'Required for Voyage AI embeddings'
            })}
          </p>
          <div className="relative">
            <Input
              type={showApiKey['voyage'] ? 'text' : 'password'}
              value={envConfig.memoryProviderConfig?.voyageApiKey || ''}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'voyage',
                  voyageApiKey: e.target.value || undefined,
                }
              })}
              placeholder={getMemoryPlaceholder('voyageApiKey', 'pa-...')}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => toggleShowApiKey('voyage')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey['voyage']
                ? t('projectSections.memory.settings.providers.voyage.hideKey', {
                  defaultValue: 'Hide Voyage AI API key'
                })
                : t('projectSections.memory.settings.providers.voyage.showKey', {
                  defaultValue: 'Show Voyage AI API key'
                })}
            >
              {showApiKey['voyage'] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.memory.settings.providers.shared.getKeyFrom', {
              defaultValue: 'Get your key from '
            })}
            <a href="https://dash.voyageai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">
              Voyage AI
            </a>
          </p>
          <div className="space-y-1 mt-3">
            <Label className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.voyage.embeddingModelLabel', {
                defaultValue: 'Embedding Model (optional)'
              })}
            </Label>
            <Input
              placeholder={getMemoryPlaceholder('voyageEmbeddingModel', 'voyage-3')}
              value={envConfig.memoryProviderConfig?.voyageEmbeddingModel || ''}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'voyage',
                  voyageEmbeddingModel: e.target.value || undefined,
                }
              })}
            />
          </div>
        </div>
      );
    }

    // Google AI
    if (embeddingProvider === 'google') {
      return (
        <div className="space-y-2">
          <Label className="text-sm font-medium text-foreground">
            {t('projectSections.memory.settings.providers.google.apiKeyLabel', {
              defaultValue: 'Google AI API Key'
            })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.memory.settings.providers.google.requiredDescription', {
              defaultValue: 'Required for Google AI embeddings'
            })}
          </p>
          <div className="relative">
            <Input
              type={showApiKey['google'] ? 'text' : 'password'}
              value={envConfig.memoryProviderConfig?.googleApiKey || ''}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'google',
                  googleApiKey: e.target.value || undefined,
                }
              })}
              placeholder={getMemoryPlaceholder('googleApiKey', 'AIza...')}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => toggleShowApiKey('google')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label={showApiKey['google']
                ? t('projectSections.memory.settings.providers.google.hideKey', {
                  defaultValue: 'Hide Google API key'
                })
                : t('projectSections.memory.settings.providers.google.showKey', {
                  defaultValue: 'Show Google API key'
                })}
            >
              {showApiKey['google'] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.memory.settings.providers.shared.getKeyFrom', {
              defaultValue: 'Get your key from '
            })}
            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80">
              Google AI Studio
            </a>
          </p>
        </div>
      );
    }

    // Azure OpenAI
    if (embeddingProvider === 'azure_openai') {
      return (
        <div className="space-y-3 p-3 rounded-md bg-muted/50">
          <Label className="text-sm font-medium text-foreground">
            {t('projectSections.memory.settings.providers.azure.configurationTitle', {
              defaultValue: 'Azure OpenAI Configuration'
            })}
          </Label>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.azure.apiKeyLabel', {
                defaultValue: 'API Key'
              })}
            </Label>
            <div className="relative">
              <Input
                type={showApiKey['azure'] ? 'text' : 'password'}
                value={envConfig.memoryProviderConfig?.azureOpenaiApiKey || ''}
                onChange={(e) => updateEnvConfig({
                  memoryProviderConfig: {
                    ...envConfig.memoryProviderConfig,
                    embeddingProvider: 'azure_openai',
                    azureOpenaiApiKey: e.target.value || undefined,
                  }
                })}
                placeholder={getMemoryPlaceholder('azureApiKey', 'Azure API Key')}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => toggleShowApiKey('azure')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showApiKey['azure']
                  ? t('projectSections.memory.settings.providers.azure.hideKey', {
                    defaultValue: 'Hide Azure OpenAI API key'
                  })
                  : t('projectSections.memory.settings.providers.azure.showKey', {
                    defaultValue: 'Show Azure OpenAI API key'
                  })}
              >
                {showApiKey['azure'] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.azure.baseUrlLabel', {
                defaultValue: 'Base URL'
              })}
            </Label>
            <Input
              placeholder={getMemoryPlaceholder('azureBaseUrl', 'https://your-resource.openai.azure.com')}
              value={envConfig.memoryProviderConfig?.azureOpenaiBaseUrl || ''}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'azure_openai',
                  azureOpenaiBaseUrl: e.target.value || undefined,
                }
              })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.azure.embeddingDeploymentLabel', {
                defaultValue: 'Embedding Deployment Name'
              })}
            </Label>
            <Input
              placeholder={getMemoryPlaceholder('azureEmbeddingDeployment', 'text-embedding-ada-002')}
              value={envConfig.memoryProviderConfig?.azureOpenaiEmbeddingDeployment || ''}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'azure_openai',
                  azureOpenaiEmbeddingDeployment: e.target.value || undefined,
                }
              })}
            />
          </div>
        </div>
      );
    }

    // Ollama (Local) - uses OllamaModelSelector component
    if (embeddingProvider === 'ollama') {
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">
              {t('projectSections.memory.settings.providers.ollama.baseUrlLabel', {
                defaultValue: 'Base URL'
              })}
            </Label>
            <Input
              placeholder={getMemoryPlaceholder('ollamaBaseUrl', 'http://localhost:11434')}
              value={envConfig.memoryProviderConfig?.ollamaBaseUrl || 'http://localhost:11434'}
              onChange={(e) => updateEnvConfig({
                memoryProviderConfig: {
                  ...envConfig.memoryProviderConfig,
                  embeddingProvider: 'ollama',
                  ollamaBaseUrl: e.target.value,
                }
              })}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.memory.settings.providers.ollama.selectEmbeddingModel', {
                defaultValue: 'Select Embedding Model'
              })}
            </Label>
            <OllamaModelSelector
              selectedModel={envConfig.memoryProviderConfig?.ollamaEmbeddingModel || ''}
              baseUrl={envConfig.memoryProviderConfig?.ollamaBaseUrl}
              onModelSelect={handleOllamaModelSelect}
            />
          </div>
        </div>
      );
    }

    return null;
  };

  return (
    <section className="space-y-3">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-sm font-semibold text-foreground hover:text-foreground/80"
      >
        <div className="flex items-center gap-2">
          <Database className="h-4 w-4" />
          {t('projectSections.memory.title')}
          <span className={`px-2 py-0.5 text-xs rounded-full ${
            envConfig.memoryEnabled
              ? 'bg-success/10 text-success'
              : 'bg-muted text-muted-foreground'
          }`}>
            {envConfig.memoryEnabled
              ? t('projectSections.memory.settings.status.enabled', {
                defaultValue: 'Enabled'
              })
              : t('projectSections.memory.settings.status.disabled', {
                defaultValue: 'Disabled'
              })}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4" />
        ) : (
          <ChevronDown className="h-4 w-4" />
        )}
      </button>

      {expanded && (
        <div className="space-y-4 pl-6 pt-2">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="font-normal text-foreground">
                {t('projectSections.memory.settings.enableMemory.label', {
                  defaultValue: 'Enable Memory'
                })}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('projectSections.memory.settings.enableMemory.description', {
                  defaultValue: 'Persistent cross-session memory using LadybugDB (embedded database)'
                })}
              </p>
            </div>
            <Switch
              checked={envConfig.memoryEnabled}
              onCheckedChange={(checked) => {
                updateEnvConfig({ memoryEnabled: checked });
                setSettings({ ...settings, memoryBackend: checked ? 'memory' : 'file' });
              }}
            />
          </div>

          {!envConfig.memoryEnabled && (
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <p className="text-xs text-muted-foreground">
                {t('projectSections.memory.settings.disabledHint', {
                  defaultValue:
                    'Using file-based memory. Session insights are stored locally in JSON files. Enable Memory for persistent cross-session context with semantic search.'
                })}
              </p>
            </div>
          )}

          {envConfig.memoryEnabled && (
            <>
              {/* Embedding Provider Selection */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('projectSections.memory.settings.embeddingProvider.label', {
                    defaultValue: 'Embedding Provider'
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.memory.settings.embeddingProvider.description', {
                    defaultValue: 'Provider for semantic search (optional - keyword search works without)'
                  })}
                </p>
                <Select
                  value={embeddingProvider}
                  onValueChange={(value: MemoryEmbeddingProvider) => {
                    updateEnvConfig({
                      memoryProviderConfig: {
                        ...envConfig.memoryProviderConfig,
                        embeddingProvider: value,
                      }
                    });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={t('projectSections.memory.settings.embeddingProvider.placeholder', {
                        defaultValue: 'Select embedding provider'
                      })}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ollama">
                      {t('projectSections.memory.settings.embeddingProvider.options.ollama', {
                        defaultValue: 'Ollama（本地 - 免费）'
                      })}
                    </SelectItem>
                    <SelectItem value="openai">OpenAI</SelectItem>
                    <SelectItem value="voyage">Voyage AI</SelectItem>
                    <SelectItem value="google">Google AI</SelectItem>
                    <SelectItem value="azure_openai">Azure OpenAI</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Provider-specific fields */}
              {renderProviderFields()}

              <Separator />

              {/* Database Settings */}
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('projectSections.memory.settings.database.nameLabel', {
                    defaultValue: 'Database Name'
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.memory.settings.database.nameDescription', {
                    defaultValue: 'Stored in ~/.auto-claude/memories/'
                  })}
                </p>
                <Input
                  placeholder="auto_claude_memory"
                  value={envConfig.memoryDatabase || ''}
                  onChange={(e) => updateEnvConfig({ memoryDatabase: e.target.value })}
                />
              </div>

              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('projectSections.memory.settings.database.pathLabel', {
                    defaultValue: 'Database Path (Optional)'
                  })}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.memory.settings.database.pathDescription', {
                    defaultValue: 'Custom storage location. Default: ~/.auto-claude/memories/'
                  })}
                </p>
                <Input
                  placeholder="~/.auto-claude/memories"
                  value={envConfig.memoryDbPath || ''}
                  onChange={(e) => updateEnvConfig({ memoryDbPath: e.target.value || undefined })}
                />
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
