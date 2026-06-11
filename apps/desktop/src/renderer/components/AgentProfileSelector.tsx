/**
 * AgentProfileSelector - Reusable component for selecting agent profile in forms
 *
 * Provides a dropdown for quick profile selection (Auto, Complex, Balanced, Quick)
 * with an inline "Custom" option that reveals model and thinking level selects.
 * The "Auto" profile shows per-phase model configuration.
 *
 * Used in TaskCreationWizard and TaskEditDialog.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useActiveProvider } from '../hooks/useActiveProvider';
import { getProviderModelLabel } from '../../shared/utils/model-display';
import { Brain, Scale, Zap, Sliders, Sparkles, ChevronDown, ChevronUp, Pencil } from 'lucide-react';
import { Label } from './ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select';
import { ThinkingLevelSelect } from './settings/ThinkingLevelSelect';
import { MultiProviderModelSelect } from './settings/MultiProviderModelSelect';
import {
  DEFAULT_AGENT_PROFILES,
  AVAILABLE_MODELS,
  DEFAULT_PHASE_MODELS,
  DEFAULT_PHASE_THINKING,
  getProviderPreset,
  ALL_AVAILABLE_MODELS,
  resolveModelEquivalent,
} from '../../shared/constants';
import type { ModelType, ThinkingLevel } from '../../shared/types';
import type { PhaseModelConfig, PhaseThinkingConfig } from '../../shared/types/settings';
import { cn } from '../lib/utils';
import {
  getAgentProfileDescription,
  getAgentProfileLabel,
  getAgentThinkingLevelLabel
} from '../lib/i18n-labels';

interface AgentProfileSelectorProps {
  profileId: string;
  model: ModelType | '';
  thinkingLevel: ThinkingLevel | '';
  phaseModels?: PhaseModelConfig;
  phaseThinking?: PhaseThinkingConfig;
  onProfileChange: (profileId: string, model: ModelType, thinkingLevel: ThinkingLevel) => void;
  onModelChange: (model: ModelType) => void;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  onPhaseModelsChange?: (phaseModels: PhaseModelConfig) => void;
  onPhaseThinkingChange?: (phaseThinking: PhaseThinkingConfig) => void;
  disabled?: boolean;
}

const iconMap: Record<string, React.ElementType> = {
  Brain,
  Scale,
  Zap,
  Sparkles
};

const PHASE_LABEL_KEYS: Record<keyof PhaseModelConfig, { label: string; description: string }> = {
  spec: { label: 'agentProfile.phases.spec.label', description: 'agentProfile.phases.spec.description' },
  planning: { label: 'agentProfile.phases.planning.label', description: 'agentProfile.phases.planning.description' },
  coding: { label: 'agentProfile.phases.coding.label', description: 'agentProfile.phases.coding.description' },
  qa: { label: 'agentProfile.phases.qa.label', description: 'agentProfile.phases.qa.description' }
};

export function AgentProfileSelector({
  profileId,
  model,
  thinkingLevel,
  phaseModels,
  phaseThinking,
  onProfileChange,
  onModelChange,
  onThinkingLevelChange,
  onPhaseModelsChange,
  onPhaseThinkingChange,
  disabled
}: AgentProfileSelectorProps) {
  const { t } = useTranslation('settings');
  const { provider: activeProvider } = useActiveProvider();
  const [showPhaseDetails, setShowPhaseDetails] = useState(false);

  const getProfileId = (value: string): 'auto' | 'complex' | 'balanced' | 'quick' | 'custom' => {
    switch (value) {
      case 'complex':
      case 'balanced':
      case 'quick':
      case 'custom':
        return value;
      default:
        return 'auto';
    }
  };

  const isCustom = profileId === 'custom';
  const currentPhaseModels = phaseModels || DEFAULT_PHASE_MODELS;
  const currentPhaseThinking = phaseThinking || DEFAULT_PHASE_THINKING;
  const getModelLabel = (modelValue: string) => {
    if (activeProvider) {
      return getProviderModelLabel(modelValue, activeProvider);
    }
    return ALL_AVAILABLE_MODELS.find(m => m.value === modelValue)?.label
      || AVAILABLE_MODELS.find(m => m.value === modelValue)?.label?.replace('Claude ', '')
      || modelValue;
  };
  const normalizeModelForActiveProvider = (modelValue: string): ModelType => {
    if (!activeProvider || activeProvider === 'ollama') {
      return modelValue as ModelType;
    }
    const directMatch = ALL_AVAILABLE_MODELS.some(candidate =>
      candidate.value === modelValue &&
      (candidate.provider === activeProvider || (activeProvider === 'openai-compatible' && candidate.provider === 'openai'))
    );
    if (directMatch) {
      return modelValue as ModelType;
    }
    return (resolveModelEquivalent(modelValue, activeProvider)?.modelId ?? modelValue) as ModelType;
  };

  const handleProfileSelect = (selectedId: string) => {
    if (selectedId === 'custom') {
      const currentProfile = DEFAULT_AGENT_PROFILES.find(p => p.id === profileId)
        || DEFAULT_AGENT_PROFILES.find(p => p.id === 'auto')!;
      const currentProviderPreset = activeProvider ? getProviderPreset(activeProvider, currentProfile.id) : null;
      const resolvedModel = normalizeModelForActiveProvider(
        (model as ModelType) || (currentProviderPreset?.primaryModel ?? currentProfile.model) as ModelType,
      );
      onProfileChange(
        'custom',
        resolvedModel,
        thinkingLevel as ThinkingLevel || currentProviderPreset?.primaryThinking || currentProfile.thinkingLevel
      );
      return;
    }

    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === selectedId);
    if (!profile) return;

    const providerPreset = activeProvider ? getProviderPreset(activeProvider, profile.id) : null;
    onProfileChange(
      profile.id,
      (providerPreset?.primaryModel ?? profile.model) as ModelType,
      providerPreset?.primaryThinking ?? profile.thinkingLevel
    );

    if (onPhaseModelsChange) {
      onPhaseModelsChange(providerPreset?.phaseModels ?? profile.phaseModels ?? DEFAULT_PHASE_MODELS);
    }
    if (onPhaseThinkingChange) {
      onPhaseThinkingChange(providerPreset?.phaseThinking ?? profile.phaseThinking ?? DEFAULT_PHASE_THINKING);
    }
  };

  const handlePhaseModelChange = (phase: keyof PhaseModelConfig, value: ModelType) => {
    if (!onPhaseModelsChange) return;
    onPhaseModelsChange({
      ...currentPhaseModels,
      [phase]: value
    });
  };

  const handlePhaseThinkingChange = (phase: keyof PhaseThinkingConfig, value: ThinkingLevel) => {
    if (!onPhaseThinkingChange) return;
    onPhaseThinkingChange({
      ...currentPhaseThinking,
      [phase]: value
    });
  };

  const getProfileDisplay = () => {
    if (isCustom) {
      return {
        icon: Sliders,
        label: t('agentProfile.customConfiguration'),
        description: getAgentProfileDescription(t, 'custom')
      };
    }

    const profile = DEFAULT_AGENT_PROFILES.find(p => p.id === profileId);
    if (profile) {
      const profileKey = getProfileId(profile.id);
      return {
        icon: iconMap[profile.icon || 'Scale'] || Scale,
        label: getAgentProfileLabel(t, profileKey),
        description: getAgentProfileDescription(t, profileKey)
      };
    }

    return {
      icon: Sparkles,
      label: getAgentProfileLabel(t, 'auto'),
      description: getAgentProfileDescription(t, 'auto')
    };
  };

  const display = getProfileDisplay();

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="agent-profile" className="text-sm font-medium text-foreground">
          {t('agentProfile.label')}
        </Label>
        <Select
          value={profileId}
          onValueChange={handleProfileSelect}
          disabled={disabled}
        >
          <SelectTrigger id="agent-profile" className="h-10">
            <SelectValue>
              <div className="flex items-center gap-2">
                <display.icon className="h-4 w-4" />
                <span>{display.label}</span>
              </div>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {DEFAULT_AGENT_PROFILES.map((profile) => {
              const profileKey = getProfileId(profile.id);
              const ProfileIcon = iconMap[profile.icon || 'Scale'] || Scale;
              const providerPreset = activeProvider ? getProviderPreset(activeProvider, profile.id) : null;
              const modelLabel = activeProvider
                ? getProviderModelLabel(providerPreset?.primaryModel ?? profile.model, activeProvider)
                : AVAILABLE_MODELS.find(m => m.value === profile.model)?.label;

              return (
                <SelectItem key={profile.id} value={profile.id}>
                  <div className="flex items-center gap-2">
                    <ProfileIcon className="h-4 w-4 shrink-0" />
                    <div>
                      <span className="font-medium">{getAgentProfileLabel(t, profileKey)}</span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        ({modelLabel} + {getAgentThinkingLevelLabel(t, providerPreset?.primaryThinking ?? profile.thinkingLevel)})
                      </span>
                    </div>
                  </div>
                </SelectItem>
              );
            })}
            <SelectItem value="custom">
              <div className="flex items-center gap-2">
                <Sliders className="h-4 w-4 shrink-0" />
                <div>
                  <span className="font-medium">{t('agentProfile.custom')}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    ({t('agentProfile.customDescription')})
                  </span>
                </div>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {display.description}
        </p>
      </div>

      {!isCustom && (
        <div className="rounded-lg border border-border bg-muted/30 overflow-visible">
          <button
            type="button"
            onClick={() => setShowPhaseDetails(!showPhaseDetails)}
            className={cn(
              'flex w-full items-center justify-between p-4 text-left',
              'hover:bg-muted/50 transition-colors',
              !disabled && 'cursor-pointer'
            )}
            disabled={disabled}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm text-foreground">{t('agentProfile.phaseConfiguration')}</span>
              {!showPhaseDetails && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Pencil className="h-3 w-3" />
                  <span>{t('agentProfile.clickToCustomize')}</span>
                </span>
              )}
            </div>
            {showPhaseDetails ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </button>

          {!showPhaseDetails && (
            <div className="px-4 pb-4 -mt-1">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {(Object.keys(PHASE_LABEL_KEYS) as Array<keyof PhaseModelConfig>).map((phase) => {
                  const modelLabel = getModelLabel(currentPhaseModels[phase]);

                  return (
                    <div key={phase} className="flex items-center justify-between rounded bg-background/50 px-2 py-1">
                      <span className="text-muted-foreground">{t(PHASE_LABEL_KEYS[phase].label)}:</span>
                      <span className="font-medium">{modelLabel}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {showPhaseDetails && (
            <div className="px-4 pb-4 space-y-4 border-t border-border pt-4">
              {(Object.keys(PHASE_LABEL_KEYS) as Array<keyof PhaseModelConfig>).map((phase) => (
                <div key={phase} className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-foreground">
                      {t(PHASE_LABEL_KEYS[phase].label)}
                    </Label>
                    <span className="text-[10px] text-muted-foreground">
                      {t(PHASE_LABEL_KEYS[phase].description)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px] text-muted-foreground">{t('agentProfile.model')}</Label>
                      <MultiProviderModelSelect
                        value={currentPhaseModels[phase]}
                        onChange={(value) => handlePhaseModelChange(phase, value as ModelType)}
                        filterProvider={activeProvider ?? undefined}
                        className={disabled ? 'pointer-events-none opacity-50' : undefined}
                      />
                    </div>
                    <ThinkingLevelSelect
                      value={currentPhaseThinking[phase]}
                      onChange={(value) => handlePhaseThinkingChange(phase, value as ThinkingLevel)}
                      modelValue={currentPhaseModels[phase]}
                      disabled={disabled}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isCustom && (
        <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
          <div className="space-y-2">
            <Label htmlFor="custom-model" className="text-xs font-medium text-muted-foreground">
              {t('agentProfile.model')}
            </Label>
            <div id="custom-model">
              <MultiProviderModelSelect
                value={model ? normalizeModelForActiveProvider(model) : model}
                onChange={(value) => onModelChange(value as ModelType)}
                filterProvider={activeProvider ?? undefined}
                className={disabled ? 'pointer-events-none opacity-50' : undefined}
              />
            </div>
          </div>

          <ThinkingLevelSelect
            value={thinkingLevel || 'low'}
            onChange={(value) => onThinkingLevelChange(value as ThinkingLevel)}
            modelValue={model || 'sonnet'}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
