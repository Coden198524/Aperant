/**
 * Hook for loading Linear projects for a selected team
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeLinearErrorMessage } from '../../../lib/linear-error-localizer';
import type { LinearProject } from '../types';

export function useLinearProjects(
  projectId: string,
  selectedTeamId: string
) {
  const { t } = useTranslation('common');
  const [projects, setProjects] = useState<LinearProject[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadProjects = async () => {
      if (!selectedTeamId) {
        setProjects([]);
        return;
      }

      setIsLoadingProjects(true);
      setError(null);

      try {
        const result = await window.electronAPI.getLinearProjects(
          projectId,
          selectedTeamId
        );
        if (result.success && result.data) {
          setProjects(result.data);
        } else {
          setError(
            localizeLinearErrorMessage(t, result.error || 'Failed to load projects') ||
              result.error ||
              'Failed to load projects'
          );
        }
      } catch (err) {
        setError(
          localizeLinearErrorMessage(
            t,
            err instanceof Error ? err.message : 'Unknown error'
          ) ||
            (err instanceof Error ? err.message : 'Unknown error')
        );
      } finally {
        setIsLoadingProjects(false);
      }
    };

    loadProjects();
  }, [projectId, selectedTeamId, t]);

  return { projects, isLoadingProjects, error, setError };
}
