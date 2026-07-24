import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MAX_INSIGHTS_DOCUMENT_REFERENCES } from '../../../shared/constants';
import type {
  IPCResult,
  InsightsDocumentAuthorization,
  InsightsPendingDocumentReference,
} from '../../../shared/types';

export interface InsightsDocumentReferenceErrorMessages {
  maxReferencesReached?: string;
  pathUnavailable?: string;
  directoryUnsupported?: string;
}

export interface InsightsDocumentReferenceCandidate {
  path: string;
  filename?: string;
  size?: number;
  isDirectory?: boolean;
  authorizationToken?: string;
}

interface UseInsightsDocumentReferencesOptions {
  projectId: string;
  /** Changes whenever pending references move to a different chat/session scope. */
  scopeKey?: string;
  references: InsightsPendingDocumentReference[];
  onReferencesChange: (references: InsightsPendingDocumentReference[]) => void;
  disabled?: boolean;
  onError?: (error: string | null) => void;
  errorMessages?: InsightsDocumentReferenceErrorMessages;
  authorizeFile?: (
    projectId: string,
    file: File,
  ) => Promise<IPCResult<InsightsDocumentAuthorization>>;
}

interface UseInsightsDocumentReferencesReturn {
  addReferences: (candidates: InsightsDocumentReferenceCandidate[]) => void;
  processFiles: (files: File[] | FileList) => Promise<void>;
  removeReference: (referenceId: string) => void;
  canAddMore: boolean;
  remainingSlots: number;
  isProcessing: boolean;
}

const DEFAULT_ERRORS: Required<InsightsDocumentReferenceErrorMessages> = {
  maxReferencesReached: `Maximum of ${MAX_INSIGHTS_DOCUMENT_REFERENCES} file references allowed`,
  pathUnavailable: 'Could not resolve the local file path',
  directoryUnsupported: 'Folders cannot be referenced here',
};

function generateReferenceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `document-reference-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function filenameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/u).at(-1)?.trim() || 'file';
}

function referenceSignature(references: InsightsPendingDocumentReference[]): string {
  return JSON.stringify(references);
}

function isDirectoryAuthorizationError(error?: string): boolean {
  if (!error) return false;
  const normalizedError = error.trim().toLowerCase();
  return normalizedError.includes('not a regular file') || /\b(directory|folder)\b/u.test(normalizedError);
}

export function useInsightsDocumentReferences({
  projectId,
  scopeKey = '',
  references,
  onReferencesChange,
  disabled = false,
  onError,
  errorMessages = {},
  authorizeFile = (id, file) => window.electronAPI.authorizeInsightsDocument(id, file),
}: UseInsightsDocumentReferencesOptions): UseInsightsDocumentReferencesReturn {
  const [processingCount, setProcessingCount] = useState(0);
  const referencesRef = useRef(references);
  const referencesPropSignature = referenceSignature(references);
  const referencesPropSignatureRef = useRef(referencesPropSignature);
  const onReferencesChangeRef = useRef(onReferencesChange);
  const onErrorRef = useRef(onError);
  const mountedRef = useRef(true);
  const scopeGenerationRef = useRef(0);
  const activeScope = `${projectId}\0${scopeKey}`;
  const activeScopeRef = useRef(activeScope);
  const committedScopeRef = useRef(activeScope);
  if (activeScopeRef.current !== activeScope) {
    activeScopeRef.current = activeScope;
    scopeGenerationRef.current += 1;
    referencesRef.current = [];
    referencesPropSignatureRef.current = referencesPropSignature;
  } else if (referencesPropSignatureRef.current !== referencesPropSignature) {
    referencesPropSignatureRef.current = referencesPropSignature;
    referencesRef.current = references;
  }
  onReferencesChangeRef.current = onReferencesChange;
  onErrorRef.current = onError;

  useEffect(() => {
    if (committedScopeRef.current === activeScope) return;
    committedScopeRef.current = activeScope;
    referencesRef.current = [];
    onReferencesChangeRef.current([]);
    setProcessingCount(0);
  }, [activeScope]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      scopeGenerationRef.current += 1;
    };
  }, []);
  const {
    directoryUnsupported,
    maxReferencesReached,
    pathUnavailable,
  } = errorMessages;
  const errors = useMemo<Required<InsightsDocumentReferenceErrorMessages>>(() => ({
    directoryUnsupported: directoryUnsupported ?? DEFAULT_ERRORS.directoryUnsupported,
    maxReferencesReached: maxReferencesReached ?? DEFAULT_ERRORS.maxReferencesReached,
    pathUnavailable: pathUnavailable ?? DEFAULT_ERRORS.pathUnavailable,
  }), [directoryUnsupported, maxReferencesReached, pathUnavailable]);
  const remainingSlots = Math.max(0, MAX_INSIGHTS_DOCUMENT_REFERENCES - references.length);
  const isProcessing = processingCount > 0;
  const canAddMore = remainingSlots > 0 && !isProcessing;

  const addReferences = useCallback((candidates: InsightsDocumentReferenceCandidate[]) => {
    if (disabled || candidates.length === 0) return;
    const currentReferences = referencesRef.current;
    const availableSlots = Math.max(
      0,
      MAX_INSIGHTS_DOCUMENT_REFERENCES - currentReferences.length,
    );
    onErrorRef.current?.(null);
    const existingPaths = new Set(currentReferences.map((reference) => reference.path));
    const additions: InsightsPendingDocumentReference[] = [];
    let firstError: string | null = null;

    for (const candidate of candidates) {
      if (candidate.isDirectory) {
        firstError ??= errors.directoryUnsupported;
        continue;
      }
      const filePath = candidate.path.trim();
      if (!filePath) {
        firstError ??= errors.pathUnavailable;
        continue;
      }
      if (existingPaths.has(filePath) || additions.some((reference) => reference.path === filePath)) {
        continue;
      }
      if (additions.length >= availableSlots) {
        firstError ??= errors.maxReferencesReached;
        break;
      }
      additions.push({
        id: generateReferenceId(),
        filename: candidate.filename?.trim() || filenameFromPath(filePath),
        path: filePath,
        ...(typeof candidate.size === 'number' && Number.isFinite(candidate.size)
          ? { size: Math.max(0, candidate.size) }
          : {}),
        ...(candidate.authorizationToken
          ? { authorizationToken: candidate.authorizationToken }
          : {}),
      });
    }

    if (additions.length > 0) {
      const nextReferences = [...currentReferences, ...additions];
      referencesRef.current = nextReferences;
      onReferencesChangeRef.current(nextReferences);
    }
    if (firstError) onErrorRef.current?.(firstError);
  }, [disabled, errors]);

  const processFiles = useCallback(async (files: File[] | FileList) => {
    if (disabled) return;
    const requestedFiles = Array.from(files);
    if (requestedFiles.length === 0) return;
    const availableSlots = Math.max(
      0,
      MAX_INSIGHTS_DOCUMENT_REFERENCES - referencesRef.current.length,
    );
    if (availableSlots <= 0) {
      onErrorRef.current?.(errors.maxReferencesReached);
      return;
    }

    // Native paths are intentionally resolved only by the privileged
    // authorization bridge. Include enough candidates to skip paths that are
    // already referenced before applying the remaining-slot limit.
    const authorizationLimit = Math.min(
      requestedFiles.length,
      availableSlots + referencesRef.current.length,
    );
    const filesToAuthorize = requestedFiles.slice(0, authorizationLimit);
    const exceededLimit = requestedFiles.length > filesToAuthorize.length;
    const scopeGeneration = scopeGenerationRef.current;
    setProcessingCount((count) => count + 1);
    try {
      const candidates = await Promise.all(filesToAuthorize.map(async (file) => {
        try {
          const result = await authorizeFile(projectId, file);
          if (!result.success || !result.data) {
            return {
              path: '',
              filename: file.name,
              size: file.size,
              isDirectory: isDirectoryAuthorizationError(result.error),
            };
          }
          return {
            path: result.data.path,
            filename: result.data.filename,
            size: result.data.size,
            authorizationToken: result.data.authorizationToken,
          };
        } catch {
          return { path: '', filename: file.name, size: file.size };
        }
      }));
      if (!mountedRef.current || scopeGeneration !== scopeGenerationRef.current) return;
      addReferences(candidates);
      if (exceededLimit) onErrorRef.current?.(errors.maxReferencesReached);
    } finally {
      if (mountedRef.current && scopeGeneration === scopeGenerationRef.current) {
        setProcessingCount((count) => Math.max(0, count - 1));
      }
    }
  }, [
    addReferences,
    authorizeFile,
    disabled,
    errors.maxReferencesReached,
    projectId,
  ]);

  const removeReference = useCallback((referenceId: string) => {
    const nextReferences = referencesRef.current.filter(
      (reference) => reference.id !== referenceId,
    );
    referencesRef.current = nextReferences;
    onReferencesChangeRef.current(nextReferences);
  }, []);

  return {
    addReferences,
    processFiles,
    removeReference,
    canAddMore,
    remainingSlots,
    isProcessing,
  };
}
