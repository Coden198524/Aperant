import { useTranslation } from 'react-i18next';
import type { ProjectSettings } from '../../../shared/types';
import { ProjectModelSelect } from './ProjectModelSelect';

interface AgentConfigSectionProps {
  settings: ProjectSettings;
  onUpdateSettings: (updates: Partial<ProjectSettings>) => void;
}

export function AgentConfigSection({ settings, onUpdateSettings }: AgentConfigSectionProps) {
  const { t } = useTranslation('settings');

  return (
    <section className="space-y-4">
      <h3 className="text-sm font-semibold text-foreground">
        {t('projectSections.general.agentConfiguration', {
          defaultValue: 'Agent Configuration'
        })}
      </h3>
      <ProjectModelSelect
        value={settings.model}
        onChange={(value) => onUpdateSettings({ model: value })}
      />
    </section>
  );
}
