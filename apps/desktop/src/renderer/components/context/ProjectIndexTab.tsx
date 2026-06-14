import { FolderTree } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { ScrollArea } from '../ui/scroll-area';
import { ServiceCard } from './ServiceCard';
import { InfoItem } from './InfoItem';
import type { ProjectIndex } from '../../../shared/types';

interface ProjectIndexTabProps {
  projectIndex: ProjectIndex | null;
}

export function ProjectIndexTab({
  projectIndex,
}: ProjectIndexTabProps) {
  const { t } = useTranslation('common');

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {t('context.projectIndex.title', { defaultValue: 'Project Structure' })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('context.projectIndex.description', {
                defaultValue: 'AI-discovered knowledge about your codebase'
              })}
            </p>
          </div>
        </div>

        {/* No index state */}
        {!projectIndex && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderTree className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium text-foreground">
              {t('context.projectIndex.emptyTitle', { defaultValue: 'Project Index Removed' })}
            </h3>
            <p className="text-sm text-muted-foreground mt-2 max-w-sm">
              {t('context.projectIndex.emptyDescription', {
                defaultValue: 'Project structure context is now provided by the project documentation pack.'
              })}
            </p>
          </div>
        )}

        {/* Project index content */}
        {projectIndex && (
          <div className="space-y-6">
            {/* Project Overview */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  {t('context.projectIndex.overview', { defaultValue: 'Overview' })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="capitalize">
                    {t(`context.projectIndex.projectTypes.${projectIndex.project_type}`, {
                      defaultValue: projectIndex.project_type
                    })}
                  </Badge>
                  {Object.keys(projectIndex.services).length > 0 && (
                    <Badge variant="secondary">
                      {t('context.projectIndex.serviceCount', {
                        count: Object.keys(projectIndex.services).length,
                        defaultValue: `${Object.keys(projectIndex.services).length} service${Object.keys(projectIndex.services).length !== 1 ? 's' : ''}`
                      })}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground font-mono truncate">
                  {projectIndex.project_root}
                </p>
              </CardContent>
            </Card>

            {/* Services */}
            {Object.keys(projectIndex.services).length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('context.projectIndex.services', { defaultValue: 'Services' })}
                </h3>
                <div className="grid gap-4 md:grid-cols-2">
                  {Object.entries(projectIndex.services).map(([name, service]) => (
                    <ServiceCard key={name} name={name} service={service} />
                  ))}
                </div>
              </div>
            )}

            {/* Infrastructure */}
            {Object.keys(projectIndex.infrastructure).length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('context.projectIndex.infrastructure', { defaultValue: 'Infrastructure' })}
                </h3>
                <Card>
                  <CardContent className="pt-6">
                    <div className="grid gap-4 sm:grid-cols-2">
                      {projectIndex.infrastructure.docker_compose && (
                        <InfoItem
                          label={t('context.projectIndex.labels.dockerCompose', { defaultValue: 'Docker Compose' })}
                          value={projectIndex.infrastructure.docker_compose}
                        />
                      )}
                      {projectIndex.infrastructure.ci && (
                        <InfoItem
                          label={t('context.projectIndex.labels.ci', { defaultValue: 'CI/CD' })}
                          value={projectIndex.infrastructure.ci}
                        />
                      )}
                      {projectIndex.infrastructure.deployment && (
                        <InfoItem
                          label={t('context.projectIndex.labels.deployment', { defaultValue: 'Deployment' })}
                          value={projectIndex.infrastructure.deployment}
                        />
                      )}
                      {projectIndex.infrastructure.docker_services &&
                        projectIndex.infrastructure.docker_services.length > 0 && (
                          <div className="sm:col-span-2">
                            <span className="text-xs text-muted-foreground">
                              {t('context.projectIndex.labels.dockerServices', { defaultValue: 'Docker Services' })}
                            </span>
                            <div className="flex flex-wrap gap-1 mt-1">
                              {projectIndex.infrastructure.docker_services.map((svc) => (
                                <Badge key={svc} variant="secondary" className="text-xs">
                                  {svc}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Conventions */}
            {Object.keys(projectIndex.conventions).length > 0 && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                  {t('context.projectIndex.conventions', { defaultValue: 'Conventions' })}
                </h3>
                <Card>
                  <CardContent className="pt-6">
                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                      {projectIndex.conventions.python_linting && (
                        <InfoItem
                          label={t('context.projectIndex.labels.pythonLinting', { defaultValue: 'Python Linting' })}
                          value={projectIndex.conventions.python_linting}
                        />
                      )}
                      {projectIndex.conventions.js_linting && (
                        <InfoItem
                          label={t('context.projectIndex.labels.jsLinting', { defaultValue: 'JS Linting' })}
                          value={projectIndex.conventions.js_linting}
                        />
                      )}
                      {projectIndex.conventions.formatting && (
                        <InfoItem
                          label={t('context.projectIndex.labels.formatting', { defaultValue: 'Formatting' })}
                          value={projectIndex.conventions.formatting}
                        />
                      )}
                      {projectIndex.conventions.git_hooks && (
                        <InfoItem
                          label={t('context.projectIndex.labels.gitHooks', { defaultValue: 'Git Hooks' })}
                          value={projectIndex.conventions.git_hooks}
                        />
                      )}
                      {projectIndex.conventions.typescript && (
                        <InfoItem
                          label={t('context.projectIndex.labels.typescript', { defaultValue: 'TypeScript' })}
                          value={t('context.projectIndex.labels.enabled', { defaultValue: 'Enabled' })}
                        />
                      )}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
