import { Radio, Import, Eye, EyeOff, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import { localizeLinearErrorMessage } from '../../../lib/linear-error-localizer';
import type { ProjectEnvConfig, LinearSyncStatus } from '../../../../shared/types';

interface LinearIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showLinearKey: boolean;
  setShowLinearKey: React.Dispatch<React.SetStateAction<boolean>>;
  linearConnectionStatus: LinearSyncStatus | null;
  isCheckingLinear: boolean;
  onOpenLinearImport: () => void;
}

/**
 * Linear integration settings component.
 * Manages Linear API key, connection status, and import functionality.
 */
export function LinearIntegration({
  envConfig,
  updateEnvConfig,
  showLinearKey,
  setShowLinearKey,
  linearConnectionStatus,
  isCheckingLinear,
  onOpenLinearImport
}: LinearIntegrationProps) {
  const { t } = useTranslation('settings');

  if (!envConfig) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">
            {t('projectSections.linear.enableSync.label', {
              defaultValue: 'Enable Linear Sync'
            })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.linear.enableSync.description', {
              defaultValue: 'Create and update Linear issues automatically'
            })}
          </p>
        </div>
        <Switch
          checked={envConfig.linearEnabled}
          onCheckedChange={(checked) => updateEnvConfig({ linearEnabled: checked })}
        />
      </div>

      {envConfig.linearEnabled && (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.linear.apiKey.label', {
                defaultValue: 'API Key'
              })}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('projectSections.linear.apiKey.helpPrefix', {
                defaultValue: 'Get your API key from '
              })}
              <a
                href="https://linear.app/settings/api"
                target="_blank"
                rel="noopener noreferrer"
                className="text-info hover:underline"
              >
                {t('projectSections.linear.apiKey.helpLink', {
                  defaultValue: 'Linear Settings'
                })}
              </a>
              {t('projectSections.linear.apiKey.helpSuffix', {
                defaultValue: ''
              })}
            </p>
            <div className="relative">
              <Input
                type={showLinearKey ? 'text' : 'password'}
                placeholder="lin_api_xxxxxxxx"
                value={envConfig.linearApiKey || ''}
                onChange={(e) => updateEnvConfig({ linearApiKey: e.target.value })}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowLinearKey(!showLinearKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showLinearKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {envConfig.linearApiKey && (
            <ConnectionStatus
              isChecking={isCheckingLinear}
              connectionStatus={linearConnectionStatus}
            />
          )}

          {linearConnectionStatus?.connected && (
            <ImportTasksPrompt onOpenLinearImport={onOpenLinearImport} />
          )}

          <Separator />

          <RealtimeSyncToggle
            enabled={envConfig.linearRealtimeSync || false}
            onToggle={(checked) => updateEnvConfig({ linearRealtimeSync: checked })}
          />

          {envConfig.linearRealtimeSync && <RealtimeSyncWarning />}

          <Separator />

          <TeamProjectIds
            teamId={envConfig.linearTeamId || ''}
            projectId={envConfig.linearProjectId || ''}
            onTeamIdChange={(value) => updateEnvConfig({ linearTeamId: value })}
            onProjectIdChange={(value) => updateEnvConfig({ linearProjectId: value })}
          />
        </>
      )}
    </div>
  );
}

interface ConnectionStatusProps {
  isChecking: boolean;
  connectionStatus: LinearSyncStatus | null;
}

function ConnectionStatus({ isChecking, connectionStatus }: ConnectionStatusProps) {
  const { t } = useTranslation(['settings', 'common']);
  const localizedError = localizeLinearErrorMessage(t, connectionStatus?.error);

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t('projectSections.linear.connectionStatus.title', {
              ns: 'settings',
              defaultValue: 'Connection Status'
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {isChecking
              ? t('projectSections.linear.connectionStatus.checking', {
                ns: 'settings',
                defaultValue: 'Checking...'
              })
              : connectionStatus?.connected
                ? connectionStatus.teamName
                  ? t('projectSections.linear.connectionStatus.connectedToTeam', {
                    ns: 'settings',
                    teamName: connectionStatus.teamName,
                    defaultValue: 'Connected to {{teamName}}'
                  })
                  : t('projectSections.linear.connectionStatus.connected', {
                    ns: 'settings',
                    defaultValue: 'Connected'
                  })
                : localizedError || t('projectSections.linear.connectionStatus.notConnected', {
                  ns: 'settings',
                  defaultValue: 'Not connected'
                })}
          </p>
          {connectionStatus?.connected && connectionStatus.issueCount !== undefined && (
            <p className="text-xs text-muted-foreground mt-1">
              {t('projectSections.linear.connectionStatus.importableTasks', {
                ns: 'settings',
                issueCount: connectionStatus.issueCount,
                defaultValue: '{{issueCount}}+ tasks available to import'
              })}
            </p>
          )}
        </div>
        {isChecking ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : connectionStatus?.connected ? (
          <CheckCircle2 className="h-4 w-4 text-success" />
        ) : (
          <AlertCircle className="h-4 w-4 text-warning" />
        )}
      </div>
    </div>
  );
}

interface ImportTasksPromptProps {
  onOpenLinearImport: () => void;
}

function ImportTasksPrompt({ onOpenLinearImport }: ImportTasksPromptProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="rounded-lg border border-info/30 bg-info/5 p-3">
      <div className="flex items-start gap-3">
        <Import className="h-5 w-5 text-info mt-0.5" />
        <div className="flex-1">
          <p className="text-sm font-medium text-foreground">
            {t('projectSections.linear.importExisting.title', {
              defaultValue: 'Import Existing Tasks'
            })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('projectSections.linear.importExisting.description', {
              defaultValue: 'Select which Linear issues to import into AutoBuild as tasks.'
            })}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={onOpenLinearImport}
          >
            <Import className="h-4 w-4 mr-2" />
            {t('projectSections.linear.importExisting.button', {
              defaultValue: 'Import Tasks from Linear'
            })}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface RealtimeSyncToggleProps {
  enabled: boolean;
  onToggle: (checked: boolean) => void;
}

function RealtimeSyncToggle({ enabled, onToggle }: RealtimeSyncToggleProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-info" />
          <Label className="font-normal text-foreground">
            {t('projectSections.linear.realtimeSync.label', {
              defaultValue: 'Real-time Sync'
            })}
          </Label>
        </div>
        <p className="text-xs text-muted-foreground pl-6">
          {t('projectSections.linear.realtimeSync.description', {
            defaultValue: 'Automatically import new tasks created in Linear'
          })}
        </p>
      </div>
      <Switch checked={enabled} onCheckedChange={onToggle} />
    </div>
  );
}

function RealtimeSyncWarning() {
  const { t } = useTranslation('settings');

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 ml-6">
      <p className="text-xs text-warning">
        {t('projectSections.linear.realtimeSync.warning', {
          defaultValue:
            'When enabled, new Linear issues will be automatically imported into AutoBuild. Make sure to configure your team/project filters below to control which issues are imported.'
        })}
      </p>
    </div>
  );
}

interface TeamProjectIdsProps {
  teamId: string;
  projectId: string;
  onTeamIdChange: (value: string) => void;
  onProjectIdChange: (value: string) => void;
}

function TeamProjectIds({ teamId, projectId, onTeamIdChange, onProjectIdChange }: TeamProjectIdsProps) {
  const { t } = useTranslation('settings');

  return (
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label className="text-sm font-medium text-foreground">
          {t('projectSections.linear.filters.teamId', {
            defaultValue: 'Team ID (Optional)'
          })}
        </Label>
        <Input
          placeholder={t('projectSections.linear.filters.autoDetected', {
            defaultValue: 'Auto-detected'
          })}
          value={teamId}
          onChange={(e) => onTeamIdChange(e.target.value)}
        />
      </div>
      <div className="space-y-2">
        <Label className="text-sm font-medium text-foreground">
          {t('projectSections.linear.filters.projectId', {
            defaultValue: 'Project ID (Optional)'
          })}
        </Label>
        <Input
          placeholder={t('projectSections.linear.filters.autoCreated', {
            defaultValue: 'Auto-created'
          })}
          value={projectId}
          onChange={(e) => onProjectIdChange(e.target.value)}
        />
      </div>
    </div>
  );
}
