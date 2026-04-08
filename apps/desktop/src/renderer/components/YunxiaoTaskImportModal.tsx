import { useEffect, useMemo, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { ScrollArea } from './ui/scroll-area';
import { Checkbox } from './ui/checkbox';
import type { YunxiaoImportResult, YunxiaoProject, YunxiaoWorkItem } from '../../shared/types';

interface YunxiaoTaskImportModalProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: (result: YunxiaoImportResult) => void;
}

export function YunxiaoTaskImportModal({
  projectId,
  open,
  onOpenChange,
  onImportComplete
}: YunxiaoTaskImportModalProps) {
  const { t } = useTranslation('settings');
  const [projects, setProjects] = useState<YunxiaoProject[]>([]);
  const [workItems, setWorkItems] = useState<YunxiaoWorkItem[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [category, setCategory] = useState('Task');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [isLoadingItems, setIsLoadingItems] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<YunxiaoImportResult | null>(null);

  const filteredItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return workItems;
    return workItems.filter(item =>
      (item.subject || '').toLowerCase().includes(query)
      || (item.identifier || '').toLowerCase().includes(query)
    );
  }, [searchQuery, workItems]);

  const resetState = () => {
    setProjects([]);
    setWorkItems([]);
    setSelectedProjectId('');
    setCategory('Task');
    setSearchQuery('');
    setSelectedIds(new Set());
    setError(null);
    setImportResult(null);
  };

  const loadProjects = async () => {
    setIsLoadingProjects(true);
    setError(null);
    try {
      const result = await window.electronAPI.getYunxiaoProjects(projectId);
      if (!result.success || !result.data) {
        setError(result.error || 'Failed to load Yunxiao projects');
        setProjects([]);
        return;
      }
      setProjects(result.data);
      if (result.data.length > 0) {
        const defaultProjectId = selectedProjectId || result.data[0].id;
        setSelectedProjectId(defaultProjectId);
      }
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Yunxiao projects');
    } finally {
      setIsLoadingProjects(false);
    }
  };

  const loadWorkItems = async (spaceId: string, categoryValue: string) => {
    if (!spaceId) return;
    setIsLoadingItems(true);
    setError(null);
    try {
      const result = await window.electronAPI.getYunxiaoWorkItems(
        projectId,
        undefined,
        spaceId,
        categoryValue || undefined
      );
      if (!result.success || !result.data) {
        setError(result.error || 'Failed to load Yunxiao work items');
        setWorkItems([]);
        return;
      }
      setWorkItems(result.data);
      setSelectedIds(new Set());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load Yunxiao work items');
    } finally {
      setIsLoadingItems(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadProjects();
  }, [open]);

  useEffect(() => {
    if (!open || !selectedProjectId) return;
    void loadWorkItems(selectedProjectId, category);
  }, [open, selectedProjectId]);

  const toggleSelection = (workItemId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(workItemId)) {
        next.delete(workItemId);
      } else {
        next.add(workItemId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    setSelectedIds(prev => {
      if (prev.size === filteredItems.length) {
        return new Set();
      }
      return new Set(filteredItems.map(item => item.id));
    });
  };

  const handleImport = async () => {
    const workItemIds = Array.from(selectedIds);
    if (workItemIds.length === 0) return;

    setIsImporting(true);
    setError(null);
    try {
      const result = await window.electronAPI.importYunxiaoWorkItems(projectId, workItemIds, {
        spaceId: selectedProjectId || undefined,
        category: category || undefined
      });
      if (!result.success || !result.data) {
        setError(result.error || 'Failed to import work items');
        return;
      }

      setImportResult(result.data);
      onImportComplete?.(result.data);
      if (result.data.imported > 0) {
        setSelectedIds(new Set());
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Failed to import work items');
    } finally {
      setIsImporting(false);
    }
  };

  const selectedCount = selectedIds.size;
  const allSelected = filteredItems.length > 0 && selectedCount === filteredItems.length;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) resetState();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="sm:max-w-[760px] max-h-[85vh] flex flex-col">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2 text-foreground">
            <Download className="h-5 w-5" />
            {t('projectSections.yunxiao.importModal.title', {
              defaultValue: 'Import Yunxiao Work Items'
            })}
          </DialogTitle>
          <DialogDescription>
            {t('projectSections.yunxiao.importModal.description', {
              defaultValue: 'Choose Yunxiao work items to create local tasks.'
            })}
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {importResult && (
          <div className="rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success">
            {t('projectSections.yunxiao.importModal.result', {
              imported: importResult.imported,
              failed: importResult.failed,
              defaultValue: 'Imported {{imported}} items, failed {{failed}}.'
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>
              {t('projectSections.yunxiao.importModal.project', {
                defaultValue: 'Project'
              })}
            </Label>
            <select
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              value={selectedProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
              disabled={isLoadingProjects}
            >
              <option value="">
                {t('projectSections.yunxiao.importModal.selectProject', {
                  defaultValue: 'Select a project'
                })}
              </option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label>
              {t('projectSections.yunxiao.importModal.category', {
                defaultValue: 'Category'
              })}
            </Label>
            <Input value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Task" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('projectSections.yunxiao.importModal.searchPlaceholder', {
              defaultValue: 'Search by subject or identifier'
            })}
          />
          <Button
            variant="outline"
            onClick={() => void loadWorkItems(selectedProjectId, category)}
            disabled={!selectedProjectId || isLoadingItems}
          >
            {isLoadingItems ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </Button>
        </div>

        {filteredItems.length > 0 && (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <button type="button" onClick={toggleSelectAll} className="hover:text-foreground">
              {allSelected
                ? t('projectSections.yunxiao.importModal.deselectAll', { defaultValue: 'Deselect all' })
                : t('projectSections.yunxiao.importModal.selectAll', { defaultValue: 'Select all' })}
            </button>
            <span>
              {t('projectSections.yunxiao.importModal.selectedCount', {
                count: selectedCount,
                defaultValue: '{{count}} selected'
              })}
            </span>
          </div>
        )}

        <ScrollArea className="h-[340px] rounded-md border border-border p-2">
          <div className="space-y-2">
            {isLoadingItems && (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                {t('projectSections.yunxiao.importModal.loadingItems', {
                  defaultValue: 'Loading work items...'
                })}
              </div>
            )}

            {!isLoadingItems && filteredItems.length === 0 && (
              <div className="py-8 text-center text-sm text-muted-foreground">
                {t('projectSections.yunxiao.importModal.empty', {
                  defaultValue: 'No work items found.'
                })}
              </div>
            )}

            {!isLoadingItems && filteredItems.map(item => {
              const checked = selectedIds.has(item.id);
              const status = item.status?.displayName || item.status?.name || '-';
              return (
                <label
                  key={item.id}
                  className="flex items-start gap-3 rounded-md border border-border p-3 hover:bg-muted/40 cursor-pointer"
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleSelection(item.id)}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-foreground truncate">{item.subject}</p>
                      {item.identifier && (
                        <span className="text-xs text-muted-foreground">{item.identifier}</span>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground flex items-center gap-3">
                      <span>{status}</span>
                      {item.priority && <span>{item.priority}</span>}
                      {item.space?.name && <span>{item.space.name}</span>}
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:buttons.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button onClick={handleImport} disabled={selectedCount === 0 || isImporting}>
            {isImporting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('projectSections.yunxiao.importModal.importing', {
                  defaultValue: 'Importing...'
                })}
              </>
            ) : (
              <>
                <Download className="mr-2 h-4 w-4" />
                {t('projectSections.yunxiao.importModal.importButton', {
                  count: selectedCount,
                  defaultValue: selectedCount === 1 ? 'Import 1 Item' : 'Import {{count}} Items'
                })}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

