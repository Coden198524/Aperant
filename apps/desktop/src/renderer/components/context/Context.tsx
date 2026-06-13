import { useState } from 'react';
import { BookOpen, Brain, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useContextStore } from '../../stores/context-store';
import { verifyMemory, pinMemory, deprecateMemory } from '../../stores/context-store';
import { useProjectContext, useMemorySearch } from './hooks';
import { ProjectDocumentsTab } from './ProjectDocumentsTab';
import { MemoriesTab } from './MemoriesTab';
import type { ContextProps } from './types';

export function Context({
  projectId,
  projectPath,
  projectDataDir,
  onProjectDocsClick,
  canCreateProjectDocs = true,
}: ContextProps) {
  const { t } = useTranslation('common');
  const {
    memoryStatus,
    memoryState,
    recentMemories,
    memoriesLoading,
    searchResults,
    searchLoading,
  } = useContextStore();

  const [activeTab, setActiveTab] = useState('documents');

  useProjectContext(projectId);
  const handleSearch = useMemorySearch(projectId);

  const handleVerify = async (memoryId: string) => {
    await verifyMemory(memoryId);
  };

  const handlePin = async (memoryId: string, pinned: boolean) => {
    await pinMemory(memoryId, pinned);
  };

  const handleDeprecate = async (memoryId: string) => {
    await deprecateMemory(memoryId);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex h-full flex-col">
        <div className="border-b border-border px-6 py-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <TabsList className="grid w-full grid-cols-2 sm:max-w-md">
              <TabsTrigger value="documents" className="gap-2">
                <BookOpen className="h-4 w-4" />
                {t('context.tabs.projectDocuments', { defaultValue: 'Project Docs' })}
              </TabsTrigger>
              <TabsTrigger value="memories" className="gap-2">
                <Brain className="h-4 w-4" />
                {t('context.tabs.memories')}
              </TabsTrigger>
            </TabsList>

            {onProjectDocsClick && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onProjectDocsClick}
                    disabled={!canCreateProjectDocs}
                    className="w-full shrink-0 sm:w-auto"
                  >
                    <FileText className="mr-2 h-4 w-4" />
                    {t('context.actions.projectDocs', { defaultValue: 'Generate Docs' })}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {canCreateProjectDocs
                    ? t('context.actions.projectDocsTooltip', {
                        defaultValue: 'Generate or refresh this project documentation pack',
                      })
                    : t('messages.initializeToCreateTasks')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        <TabsContent value="documents" className="m-0 flex-1 overflow-hidden">
          <ProjectDocumentsTab
            projectPath={projectPath}
            projectDataDir={projectDataDir}
            onCreateProjectDocs={onProjectDocsClick}
            canCreateProjectDocs={canCreateProjectDocs}
          />
        </TabsContent>

        <TabsContent value="memories" className="m-0 flex-1 overflow-hidden">
          <MemoriesTab
            memoryStatus={memoryStatus}
            memoryState={memoryState}
            recentMemories={recentMemories}
            memoriesLoading={memoriesLoading}
            searchResults={searchResults}
            searchLoading={searchLoading}
            onSearch={handleSearch}
            onVerify={handleVerify}
            onPin={handlePin}
            onDeprecate={handleDeprecate}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
