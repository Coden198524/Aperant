import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ALL_AVAILABLE_MODELS, resolveModelEquivalent } from '@shared/constants/models';
import type { BuiltinProvider } from '@shared/types/provider-account';
import { useActiveProvider } from '../../hooks/useActiveProvider';
import { Label } from '../ui/label';
import { MultiProviderModelSelect } from '../settings/MultiProviderModelSelect';

interface ProjectModelSelectProps {
  value: string;
  onChange: (value: string) => void;
}

export function ProjectModelSelect({ value, onChange }: ProjectModelSelectProps) {
  const { t } = useTranslation('settings');
  const { provider: activeProvider } = useActiveProvider();
  const resolvedValue = resolveProjectModelForProvider(value, activeProvider);

  useEffect(() => {
    if (value && resolvedValue !== value) {
      onChange(resolvedValue);
    }
  }, [onChange, resolvedValue, value]);

  return (
    <div className="space-y-2">
      <Label htmlFor="model" className="text-sm font-medium text-foreground">
        {t('general.model', {
          defaultValue: 'Model'
        })}
      </Label>
      <div id="model">
        <MultiProviderModelSelect
          value={resolvedValue}
          onChange={onChange}
          filterProvider={activeProvider ?? undefined}
        />
      </div>
    </div>
  );
}

function resolveProjectModelForProvider(model: string, provider: BuiltinProvider | null): string {
  if (!model || !provider || provider === 'ollama') {
    return model;
  }

  const directMatch = ALL_AVAILABLE_MODELS.some(candidate =>
    candidate.value === model &&
    (candidate.provider === provider || (provider === 'openai-compatible' && candidate.provider === 'openai'))
  );
  if (directMatch) {
    return model;
  }

  return resolveModelEquivalent(model, provider)?.modelId ?? model;
}
