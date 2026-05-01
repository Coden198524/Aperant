import { Eye, EyeOff, Import, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/button';
import { Input } from '../../ui/input';
import { Label } from '../../ui/label';
import { Switch } from '../../ui/switch';
import { Separator } from '../../ui/separator';
import type { ProjectEnvConfig, YunxiaoSyncStatus } from '../../../../shared/types';

interface YunxiaoIntegrationProps {
  envConfig: ProjectEnvConfig | null;
  updateEnvConfig: (updates: Partial<ProjectEnvConfig>) => void;
  showYunxiaoToken: boolean;
  setShowYunxiaoToken: React.Dispatch<React.SetStateAction<boolean>>;
  yunxiaoConnectionStatus: YunxiaoSyncStatus | null;
  isCheckingYunxiao: boolean;
  onOpenYunxiaoImport: () => void;
}

/**
 * Yunxiao integration settings component.
 */
export function YunxiaoIntegration({
  envConfig,
  updateEnvConfig,
  showYunxiaoToken,
  setShowYunxiaoToken,
  yunxiaoConnectionStatus,
  isCheckingYunxiao,
  onOpenYunxiaoImport
}: YunxiaoIntegrationProps) {
  const { t } = useTranslation('settings');

  if (!envConfig) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <Label className="font-normal text-foreground">
            {t('projectSections.yunxiao.enableSync.label', {
              defaultValue: 'Enable Yunxiao Sync'
            })}
          </Label>
          <p className="text-xs text-muted-foreground">
            {t('projectSections.yunxiao.enableSync.description', {
              defaultValue: 'Connect Yunxiao work items for import and tracking'
            })}
          </p>
        </div>
        <Switch
          checked={envConfig.yunxiaoEnabled || false}
          onCheckedChange={(checked) => updateEnvConfig({ yunxiaoEnabled: checked })}
        />
      </div>

      {envConfig.yunxiaoEnabled && (
        <>
          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.yunxiao.accessToken.label', {
                defaultValue: 'Access Token'
              })}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t('projectSections.yunxiao.accessToken.help', {
                defaultValue: 'Use your Yunxiao personal access token'
              })}
            </p>
            <div className="relative">
              <Input
                type={showYunxiaoToken ? 'text' : 'password'}
                placeholder="pt-xxxxxxxx"
                value={envConfig.yunxiaoAccessToken || ''}
                onChange={(event) => updateEnvConfig({ yunxiaoAccessToken: event.target.value })}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowYunxiaoToken(!showYunxiaoToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showYunxiaoToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {envConfig.yunxiaoAccessToken && (
            <ConnectionStatus
              isChecking={isCheckingYunxiao}
              connectionStatus={yunxiaoConnectionStatus}
            />
          )}

          {yunxiaoConnectionStatus?.connected && (
            <div className="rounded-lg border border-info/30 bg-info/5 p-3">
              <div className="flex items-start gap-3">
                <Import className="h-5 w-5 text-info mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {t('projectSections.yunxiao.importExisting.title', {
                      defaultValue: 'Import Existing Work Items'
                    })}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t('projectSections.yunxiao.importExisting.description', {
                      defaultValue: 'Select Yunxiao work items to import as tasks.'
                    })}
                  </p>
                  <Button size="sm" variant="outline" className="mt-2" onClick={onOpenYunxiaoImport}>
                    <Import className="h-4 w-4 mr-2" />
                    {t('projectSections.yunxiao.importExisting.button', {
                      defaultValue: 'Import from Yunxiao'
                    })}
                  </Button>
                </div>
              </div>
            </div>
          )}

          <Separator />

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">
                {t('projectSections.yunxiao.filters.organizationId', {
                  defaultValue: 'Organization ID (Optional)'
                })}
              </Label>
              <Input
                placeholder={t('projectSections.yunxiao.filters.autoDetected', {
                  defaultValue: 'Auto-detected'
                })}
                value={envConfig.yunxiaoOrganizationId || ''}
                onChange={(event) => updateEnvConfig({ yunxiaoOrganizationId: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">
                {t('projectSections.yunxiao.filters.projectId', {
                  defaultValue: 'Project ID (Optional)'
                })}
              </Label>
              <Input
                placeholder={t('projectSections.yunxiao.filters.requiredForImport', {
                  defaultValue: 'Required for import'
                })}
                value={envConfig.yunxiaoProjectId || ''}
                onChange={(event) => updateEnvConfig({ yunxiaoProjectId: event.target.value })}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium text-foreground">
              {t('projectSections.yunxiao.filters.workitemCategory', {
                defaultValue: 'Work Item Category'
              })}
            </Label>
            <Input
              placeholder="Task"
              value={envConfig.yunxiaoWorkitemCategory || ''}
              onChange={(event) => updateEnvConfig({ yunxiaoWorkitemCategory: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              {t('projectSections.yunxiao.filters.workitemCategoryHelp', {
                defaultValue: 'Common values: Task, Req, Bug'
              })}
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <p className="text-sm font-medium text-foreground">
              {t('projectSections.yunxiao.mcpConfig.title', {
                defaultValue: 'Yunxiao MCP Startup (Advanced)'
              })}
            </p>
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">
                {t('projectSections.yunxiao.mcpConfig.toolsets', {
                  defaultValue: 'DEVOPS_TOOLSETS'
                })}
              </Label>
              <Input
                placeholder="organization-management,project-management"
                value={envConfig.yunxiaoDevopsToolsets || ''}
                onChange={(event) => updateEnvConfig({ yunxiaoDevopsToolsets: event.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('projectSections.yunxiao.mcpConfig.command', {
                    defaultValue: 'YUNXIAO_MCP_COMMAND'
                  })}
                </Label>
                <Input
                  placeholder={navigator.platform?.toLowerCase().includes('win') ? 'npx.cmd' : 'npx'}
                  value={envConfig.yunxiaoMcpCommand || ''}
                  onChange={(event) => updateEnvConfig({ yunxiaoMcpCommand: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-sm font-medium text-foreground">
                  {t('projectSections.yunxiao.mcpConfig.args', {
                    defaultValue: 'YUNXIAO_MCP_ARGS'
                  })}
                </Label>
                <Input
                  placeholder="-y alibabacloud-devops-mcp-server"
                  value={envConfig.yunxiaoMcpArgs || ''}
                  onChange={(event) => updateEnvConfig({ yunxiaoMcpArgs: event.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-sm font-medium text-foreground">
                {t('projectSections.yunxiao.mcpConfig.npmCache', {
                  defaultValue: 'YUNXIAO_MCP_NPM_CACHE'
                })}
              </Label>
              <Input
                placeholder="C:\\Users\\<you>\\AppData\\Roaming\\Autocode\\mcp-cache\\yunxiao-npm"
                value={envConfig.yunxiaoMcpNpmCache || ''}
                onChange={(event) => updateEnvConfig({ yunxiaoMcpNpmCache: event.target.value })}
              />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label className="font-normal text-foreground">
                {t('projectSections.yunxiao.autoSync.label', {
                  defaultValue: 'Auto Sync'
                })}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t('projectSections.yunxiao.autoSync.description', {
                  defaultValue: 'Reserved for periodic sync workflows'
                })}
              </p>
            </div>
            <Switch
              checked={envConfig.yunxiaoAutoSync || false}
              onCheckedChange={(checked) => updateEnvConfig({ yunxiaoAutoSync: checked })}
            />
          </div>
        </>
      )}
    </div>
  );
}

interface ConnectionStatusProps {
  isChecking: boolean;
  connectionStatus: YunxiaoSyncStatus | null;
}

function ConnectionStatus({ isChecking, connectionStatus }: ConnectionStatusProps) {
  const { t } = useTranslation('settings');
  const hasWorkItemCount = typeof connectionStatus?.workItemCount === 'number';

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-foreground">
            {t('projectSections.yunxiao.connectionStatus.title', {
              defaultValue: 'Connection Status'
            })}
          </p>
          <p className="text-xs text-muted-foreground">
            {isChecking
              ? t('projectSections.yunxiao.connectionStatus.checking', {
                defaultValue: 'Checking...'
              })
              : connectionStatus?.connected
                ? connectionStatus.organizationName
                  ? t('projectSections.yunxiao.connectionStatus.connectedToOrg', {
                    organizationName: connectionStatus.organizationName,
                    defaultValue: 'Connected to {{organizationName}}'
                  })
                  : t('projectSections.yunxiao.connectionStatus.connected', {
                    defaultValue: 'Connected'
                  })
                : connectionStatus?.error || t('projectSections.yunxiao.connectionStatus.notConnected', {
                  defaultValue: 'Not connected'
                })}
          </p>
          {connectionStatus?.connected && (
            <p className="text-xs text-muted-foreground mt-1">
              {hasWorkItemCount
                ? t('projectSections.yunxiao.connectionStatus.projectsAndItems', {
                  projectCount: connectionStatus.projectCount ?? 0,
                  workItemCount: connectionStatus.workItemCount ?? 0,
                  defaultValue: '{{projectCount}} projects, {{workItemCount}} work items available'
                })
                : t('projectSections.yunxiao.connectionStatus.projectsOnly', {
                  projectCount: connectionStatus.projectCount ?? 0,
                  defaultValue: '{{projectCount}} projects available (work item count unavailable)'
                })}
            </p>
          )}
          {connectionStatus?.connected && connectionStatus?.error && (
            <p className="text-xs text-warning mt-1">{connectionStatus.error}</p>
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
