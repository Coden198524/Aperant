import { GitBranch, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import type { ProjectEnvConfig } from '../../../../shared/types';

interface GitBlitIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
}

/**
 * GitBlit workflow settings.
 * GitBlit uses ticket + patchset submission instead of standard pull requests.
 */
export function GitBlitIntegration({
  envConfig,
  updateEnvConfig
}: GitBlitIntegrationProps) {
  const { t } = useTranslation('settings');

  if (!envConfig) {
    return null;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">
            {t('projectSections.gitblit.enable.label')}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.gitblit.enable.description')}
          </p>
        </div>
        <Switch
          checked={envConfig.gitblitEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ gitblitEnabled: checked })}
        />
      </div>

      {envConfig.gitblitEnabled && (
        <>
          <div className="rounded-lg border border-info/30 bg-info/5 p-4">
            <div className="flex items-start gap-3">
              <Info className="mt-0.5 h-5 w-5 text-info shrink-0" />
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">
                  {t('projectSections.gitblit.workflow.title')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.gitblit.workflow.description')}
                </p>
                <ul className="space-y-1 text-xs text-muted-foreground">
                  <li>{t('projectSections.gitblit.workflow.create')}</li>
                  <li>{t('projectSections.gitblit.workflow.update')}</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.gitblit.baseUrl.label')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('projectSections.gitblit.baseUrl.description')}
            </p>
            <Input
              placeholder="https://gitblit.example.com"
              value={envConfig.gitblitBaseUrl || ''}
              onChange={(e) => updateEnvConfig({ gitblitBaseUrl: e.target.value })}
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-info" />
              <Label className="text-sm font-medium text-foreground">
                {t('projectSections.gitblit.repo.label')}
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              {t('projectSections.gitblit.repo.description')}
            </p>
            <Input
              placeholder="team/repository.git"
              value={envConfig.gitblitRepo || ''}
              onChange={(e) => updateEnvConfig({ gitblitRepo: e.target.value })}
            />
          </div>
        </>
      )}
    </div>
  );
}
