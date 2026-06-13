import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, BookOpen, FileJson, FileText, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/button';
import { ScrollArea } from '../ui/scroll-area';
import { cn } from '../../lib/utils';
import type { FileNode } from '../../../shared/types';

interface ProjectDocumentsTabProps {
  projectPath?: string;
  projectDataDir?: string;
  onCreateProjectDocs?: () => void;
  canCreateProjectDocs?: boolean;
}

interface ProjectDocumentInfo {
  id: string;
  fileName: string;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
  kind: 'markdown' | 'json';
}

const PROJECT_DOCS_DIR_NAME = 'project-docs';

const PROJECT_DOCUMENTS: ProjectDocumentInfo[] = [
  {
    id: 'index',
    fileName: 'index.md',
    labelKey: 'context.projectDocuments.files.index',
    defaultLabel: 'Index',
    descriptionKey: 'context.projectDocuments.descriptions.index',
    defaultDescription: 'Entry point and document map',
    kind: 'markdown',
  },
  {
    id: 'product',
    fileName: 'product.md',
    labelKey: 'context.projectDocuments.files.product',
    defaultLabel: 'Product',
    descriptionKey: 'context.projectDocuments.descriptions.product',
    defaultDescription: 'Product context, audience, goals, and flows',
    kind: 'markdown',
  },
  {
    id: 'architecture',
    fileName: 'architecture.md',
    labelKey: 'context.projectDocuments.files.architecture',
    defaultLabel: 'Architecture',
    descriptionKey: 'context.projectDocuments.descriptions.architecture',
    defaultDescription: 'System structure, boundaries, and runtime topology',
    kind: 'markdown',
  },
  {
    id: 'technical',
    fileName: 'technical.md',
    labelKey: 'context.projectDocuments.files.technical',
    defaultLabel: 'Technical',
    descriptionKey: 'context.projectDocuments.descriptions.technical',
    defaultDescription: 'Implementation details, commands, risks, and conventions',
    kind: 'markdown',
  },
  {
    id: 'outline',
    fileName: 'doc_outline.json',
    labelKey: 'context.projectDocuments.files.outline',
    defaultLabel: 'Outline',
    descriptionKey: 'context.projectDocuments.descriptions.outline',
    defaultDescription: 'Structured outline used by agents',
    kind: 'json',
  },
  {
    id: 'evidence',
    fileName: 'evidence_index.json',
    labelKey: 'context.projectDocuments.files.evidence',
    defaultLabel: 'Evidence',
    descriptionKey: 'context.projectDocuments.descriptions.evidence',
    defaultDescription: 'Source references, claims, risks, and open questions',
    kind: 'json',
  },
];

const markdownComponents: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="break-all text-primary underline-offset-2 hover:underline">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-3 rounded-r-md border-l-4 border-primary/50 bg-muted/60 px-4 py-2 text-foreground/90 [&_*]:text-foreground/90">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => (
    <code className={cn('rounded bg-muted px-1 py-0.5 font-mono text-[0.85em] text-foreground', className)}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="my-4 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-foreground">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-r border-border bg-muted/60 px-2 py-1.5 text-left font-medium last:border-r-0">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-r border-border px-2 py-1.5 align-top last:border-r-0">
      {children}
    </td>
  ),
};

function joinProjectPath(...segments: Array<string | undefined>): string {
  return segments
    .filter((segment): segment is string => Boolean(segment))
    .map((segment, index) => {
      if (index === 0) return segment.replace(/[\\/]+$/, '');
      return segment.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    })
    .join('/');
}

function isMissingDirectoryError(error?: string): boolean {
  return Boolean(error && /(enoent|no such file|cannot find|not found)/i.test(error));
}

function formatJsonContent(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content) as unknown, null, 2);
  } catch {
    return content;
  }
}

export function ProjectDocumentsTab({
  projectPath,
  projectDataDir = '.autocode',
  onCreateProjectDocs,
  canCreateProjectDocs = true,
}: ProjectDocumentsTabProps) {
  const { t } = useTranslation('common');
  const [files, setFiles] = useState<FileNode[]>([]);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [contentLoading, setContentLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [contentReloadKey, setContentReloadKey] = useState(0);

  const docsDir = useMemo(() => {
    if (!projectPath) return null;
    return joinProjectPath(projectPath, projectDataDir || '.autocode', PROJECT_DOCS_DIR_NAME);
  }, [projectPath, projectDataDir]);

  const knownFiles = useMemo(() => new Set(PROJECT_DOCUMENTS.map(doc => doc.fileName)), []);

  const availableDocs = useMemo(() => {
    const fileByName = new Map(files.map(file => [file.name, file]));
    return PROJECT_DOCUMENTS
      .filter(doc => fileByName.has(doc.fileName))
      .map(doc => ({ ...doc, file: fileByName.get(doc.fileName)! }));
  }, [files]);

  const selectedDoc = useMemo(() => {
    return availableDocs.find(doc => doc.fileName === selectedFileName) ?? availableDocs[0] ?? null;
  }, [availableDocs, selectedFileName]);

  const loadDocuments = useCallback(async () => {
    if (!docsDir) {
      setFiles([]);
      setListError(null);
      return;
    }

    setListLoading(true);
    setListError(null);

    try {
      const result = await window.electronAPI.listDirectory(docsDir);
      if (!result.success) {
        setFiles([]);
        if (!isMissingDirectoryError(result.error)) {
          setListError(result.error || t('context.projectDocuments.errors.listFailed', { defaultValue: 'Failed to load project documents' }));
        }
        return;
      }

      const docs = (result.data ?? [])
        .filter(file => !file.isDirectory && knownFiles.has(file.name));
      setFiles(docs);
      setSelectedFileName(current => {
        if (current && docs.some(file => file.name === current)) return current;
        return docs.find(file => file.name === 'index.md')?.name ?? docs[0]?.name ?? null;
      });
    } finally {
      setListLoading(false);
    }
  }, [docsDir, knownFiles, t]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  useEffect(() => {
    let canceled = false;

    async function loadContent(): Promise<void> {
      if (!selectedDoc) {
        setContent(null);
        setContentError(null);
        return;
      }

      setContentLoading(true);
      setContentError(null);
      try {
        const result = await window.electronAPI.readFile(selectedDoc.file.path);
        if (canceled) return;
        if (!result.success) {
          setContent(null);
          setContentError(result.error || t('context.projectDocuments.errors.readFailed', { defaultValue: 'Failed to read document' }));
          return;
        }
        setContent(result.data ?? '');
      } finally {
        if (!canceled) {
          setContentLoading(false);
        }
      }
    }

    void loadContent();

    return () => {
      canceled = true;
    };
  }, [selectedDoc, t, contentReloadKey]);

  const renderContent = () => {
    if (listLoading && availableDocs.length === 0) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (listError) {
      return (
        <EmptyState
          icon={<AlertCircle className="h-9 w-9 text-destructive" />}
          title={t('context.projectDocuments.errors.listFailedTitle', { defaultValue: 'Unable to load documents' })}
          description={listError}
          action={(
            <Button variant="outline" size="sm" onClick={loadDocuments}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('actions.retry', { defaultValue: 'Retry' })}
            </Button>
          )}
        />
      );
    }

    if (!selectedDoc) {
      return (
        <EmptyState
          icon={<BookOpen className="h-9 w-9 text-muted-foreground" />}
          title={t('context.projectDocuments.emptyTitle', { defaultValue: 'No Project Documents Found' })}
          description={t('context.projectDocuments.emptyDescription', {
            defaultValue: 'Generate a project documentation pack to read product, architecture, and technical context here.',
          })}
          action={onCreateProjectDocs ? (
            <Button onClick={onCreateProjectDocs} disabled={!canCreateProjectDocs}>
              <FileText className="mr-2 h-4 w-4" />
              {t('context.actions.projectDocs', { defaultValue: 'Project Docs' })}
            </Button>
          ) : undefined}
        />
      );
    }

    if (contentLoading) {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      );
    }

    if (contentError) {
      return (
        <EmptyState
          icon={<AlertCircle className="h-9 w-9 text-destructive" />}
          title={t('context.projectDocuments.errors.readFailedTitle', { defaultValue: 'Unable to read document' })}
          description={contentError}
          action={(
            <Button variant="outline" size="sm" onClick={() => setContentReloadKey(key => key + 1)}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('actions.retry', { defaultValue: 'Retry' })}
            </Button>
          )}
        />
      );
    }

    if (content === null) return null;

    if (selectedDoc.kind === 'json') {
      return <SourceContent content={formatJsonContent(content)} />;
    }

    return (
      <ScrollArea className="h-full">
        <div className="prose prose-sm dark:prose-invert max-w-none p-5 prose-p:text-foreground/90 prose-headings:text-foreground prose-strong:text-foreground prose-li:text-foreground/90 prose-pre:overflow-x-auto prose-a:break-all prose-blockquote:not-italic prose-blockquote:text-foreground/90">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {content}
          </ReactMarkdown>
        </div>
      </ScrollArea>
    );
  };

  return (
    <div className="flex h-full min-h-0 bg-background">
      <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-foreground">
                {t('context.projectDocuments.title', { defaultValue: 'Project Documents' })}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {docsDir ?? t('context.projectDocuments.noProjectPath', { defaultValue: 'No project path' })}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={loadDocuments}
              disabled={listLoading || !docsDir}
              aria-label={t('context.projectDocuments.refresh', { defaultValue: 'Refresh documents' })}
            >
              <RefreshCw className={cn('h-4 w-4', listLoading && 'animate-spin')} />
            </Button>
          </div>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 p-2">
            {availableDocs.map(doc => {
              const active = selectedDoc?.fileName === doc.fileName;
              const Icon = doc.kind === 'json' ? FileJson : FileText;
              return (
                <button
                  key={doc.fileName}
                  type="button"
                  onClick={() => setSelectedFileName(doc.fileName)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-transparent text-foreground hover:border-border hover:bg-accent'
                  )}
                >
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      {t(doc.labelKey, { defaultValue: doc.defaultLabel })}
                    </span>
                    <span className={cn('mt-0.5 block line-clamp-2 text-xs', active ? 'text-primary/80' : 'text-muted-foreground')}>
                      {t(doc.descriptionKey, { defaultValue: doc.defaultDescription })}
                    </span>
                  </span>
                </button>
              );
            })}

            {!listLoading && availableDocs.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                <FolderOpen className="mx-auto mb-2 h-7 w-7 opacity-50" />
                {t('context.projectDocuments.emptyList', { defaultValue: 'No generated documents yet' })}
              </div>
            )}
          </div>
        </ScrollArea>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-card">
        {selectedDoc && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {t(selectedDoc.labelKey, { defaultValue: selectedDoc.defaultLabel })}
              </h3>
              <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                {selectedDoc.file.path}
              </p>
            </div>
          </div>
        )}
        <div className="min-h-0 flex-1">
          {renderContent()}
        </div>
      </section>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <div className="max-w-sm">
        <div className="mb-3 flex justify-center">{icon}</div>
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
        {action && <div className="mt-4 flex justify-center">{action}</div>}
      </div>
    </div>
  );
}

function SourceContent({ content }: { content: string }) {
  return (
    <ScrollArea className="h-full">
      <pre className="min-h-full whitespace-pre-wrap break-words p-5 font-mono text-xs leading-relaxed text-foreground">
        {content}
      </pre>
    </ScrollArea>
  );
}
