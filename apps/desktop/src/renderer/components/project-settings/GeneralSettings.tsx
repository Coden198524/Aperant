import {
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
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
import { ProjectModelSelect } from './ProjectModelSelect';
import type {
  Project,
  ProjectType,
  ProjectSettings as ProjectSettingsType,
  AutoBuildVersionInfo,
  PromptProfileRefreshResult
} from '../../../shared/types';

interface GeneralSettingsProps {
  project: Project;
  settings: ProjectSettingsType;
  setSettings: React.Dispatch<React.SetStateAction<ProjectSettingsType>>;
  versionInfo: AutoBuildVersionInfo | null;
  isCheckingVersion: boolean;
  isUpdating: boolean;
  isRefreshingPrompts: boolean;
  promptRefreshResult: PromptProfileRefreshResult | null;
  handleInitialize: () => Promise<void>;
  handleRefreshPrompts: () => Promise<void>;
}

export function GeneralSettings({
  project,
  settings,
  setSettings,
  versionInfo,
  isCheckingVersion,
  isUpdating,
  isRefreshingPrompts,
  promptRefreshResult,
  handleInitialize,
  handleRefreshPrompts
}: GeneralSettingsProps) {
  const { t } = useTranslation(['settings']);

  return (
    <>
      {/* Auto-Build Integration */}
      <section className="space-y-4">
        <h3 className="text-sm font-semibold text-foreground">
          {t('projectSections.general.autoBuild.title', {
            defaultValue: 'Auto-Build Integration'
          })}
        </h3>
        {!project.autoBuildPath ? (
          <div className="rounded-lg border border-border bg-muted/50 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-warning mt-0.5 shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t('projectSections.general.autoBuild.notInitializedTitle', {
                    defaultValue: 'Not Initialized'
                  })}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('projectSections.general.autoBuild.notInitializedDescription', {
                    defaultValue: 'Initialize Auto-Build to enable task creation and agent workflows.'
                  })}
                </p>
                <Button
                  size="sm"
                  className="mt-3"
                  onClick={handleInitialize}
                  disabled={isUpdating}
                >
                  {isUpdating ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      {t('projectSections.general.autoBuild.initializing', {
                        defaultValue: 'Initializing...'
                      })}
                    </>
                  ) : (
                    <>
                      <Download className="mr-2 h-4 w-4" />
                      {t('projectSections.general.autoBuild.initialize', {
                        defaultValue: 'Initialize Auto-Build'
                      })}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-muted/50 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                <span className="text-sm font-medium text-foreground">
                  {t('projectSections.general.autoBuild.initialized', {
                    defaultValue: 'Initialized'
                  })}
                </span>
              </div>
              <code className="text-xs bg-background px-2 py-1 rounded">
                {project.autoBuildPath}
              </code>
            </div>
            {isCheckingVersion ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('projectSections.general.autoBuild.checkingStatus', {
                  defaultValue: 'Checking status...'
                })}
              </div>
            ) : versionInfo && (
              <div className="text-xs text-muted-foreground">
                {versionInfo.isInitialized
                  ? t('projectSections.general.autoBuild.initialized', {
                    defaultValue: 'Initialized'
                  })
                  : t('projectSections.general.autoBuild.notInitializedTitle', {
                    defaultValue: 'Not Initialized'
                  })}
              </div>
            )}
            <div className="flex flex-col gap-3 rounded-md border border-border bg-background/70 p-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {t('projectSections.general.autoBuild.projectPromptsTitle', {
                    defaultValue: 'Project prompts'
                  })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.general.autoBuild.projectPromptsDescription', {
                    defaultValue: 'Regenerate prompts from the latest project files, dependencies, and scripts.'
                  })}
                </p>
                {promptRefreshResult && (
                  <p className="text-xs text-success">
                    {t('projectSections.general.autoBuild.projectPromptsUpdated', {
                      defaultValue: 'Updated: {{size}} project, {{intensity}} workflow.',
                      size: promptRefreshResult.projectSize,
                      intensity: promptRefreshResult.promptIntensity
                    })}
                  </p>
                )}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefreshPrompts}
                disabled={isUpdating || isRefreshingPrompts}
                className="w-full shrink-0 sm:w-auto"
              >
                {isRefreshingPrompts ? (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                    {t('projectSections.general.autoBuild.projectPromptsRefreshing', {
                      defaultValue: 'Updating...'
                    })}
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    {t('projectSections.general.autoBuild.projectPromptsRefresh', {
                      defaultValue: 'Update prompts'
                    })}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </section>

      {project.autoBuildPath && (
        <>
          <Separator />

          {/* Agent Settings */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              {t('projectSections.general.agentConfiguration', {
                defaultValue: 'Agent Configuration'
              })}
            </h3>
            <ProjectModelSelect
              value={settings.model}
              onChange={(value) => setSettings({ ...settings, model: value })}
            />
            <div className="space-y-2">
              <Label htmlFor="projectType" className="text-sm font-medium text-foreground">
                {t('projectSections.general.projectType.label', {
                  defaultValue: 'Project Type'
                })}
              </Label>
              <Select
                value={settings.projectType ?? 'general'}
                onValueChange={(value) =>
                  setSettings({ ...settings, projectType: value as ProjectType })
                }
              >
                <SelectTrigger id="projectType">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">
                    {t('projectSections.general.projectType.general', {
                      defaultValue: 'General software'
                    })}
                  </SelectItem>
                  <SelectItem value="game-mmo">
                    {t('projectSections.general.projectType.gameMmo', {
                      defaultValue: 'MMO / large online game'
                    })}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {t('projectSections.general.projectType.description', {
                  defaultValue: 'Selects the agent profile used by spec, planning, coding, and QA workflows.'
                })}
              </p>
            </div>
            <div className="flex items-center justify-between pt-2">
              <div className="space-y-0.5">
                <Label className="font-normal text-foreground">
                  {t('projectSections.general.useClaudeMd')}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('projectSections.general.useClaudeMdDescription')}
                </p>
              </div>
              <Switch
                checked={settings.useClaudeMd ?? true}
                onCheckedChange={(checked) =>
                  setSettings({ ...settings, useClaudeMd: checked })
                }
              />
            </div>
          </section>

          <Separator />

          {/* Notifications */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground">
              {t('notifications.title')}
            </h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="font-normal text-foreground">{t('notifications.onTaskComplete')}</Label>
                <Switch
                  checked={settings.notifications.onTaskComplete}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        onTaskComplete: checked
                      }
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-normal text-foreground">{t('notifications.onTaskFailed')}</Label>
                <Switch
                  checked={settings.notifications.onTaskFailed}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        onTaskFailed: checked
                      }
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-normal text-foreground">{t('notifications.onReviewNeeded')}</Label>
                <Switch
                  checked={settings.notifications.onReviewNeeded}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        onReviewNeeded: checked
                      }
                    })
                  }
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-normal text-foreground">{t('notifications.sound')}</Label>
                <Switch
                  checked={settings.notifications.sound}
                  onCheckedChange={(checked) =>
                    setSettings({
                      ...settings,
                      notifications: {
                        ...settings.notifications,
                        sound: checked
                      }
                    })
                  }
                />
              </div>
            </div>
          </section>
        </>
      )}
    </>
  );
}
