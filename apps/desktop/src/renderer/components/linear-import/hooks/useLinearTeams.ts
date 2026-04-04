/**
 * Hook for loading Linear teams
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { localizeLinearErrorMessage } from '../../../lib/linear-error-localizer';
import type { LinearTeam } from '../types';

export function useLinearTeams(projectId: string, open: boolean) {
  const { t } = useTranslation('common');
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [isLoadingTeams, setIsLoadingTeams] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loadTeams = async () => {
      if (!open) return;

      setIsLoadingTeams(true);
      setError(null);

      try {
        const result = await window.electronAPI.getLinearTeams(projectId);
        if (result.success && result.data) {
          setTeams(result.data);
        } else {
          setError(
            localizeLinearErrorMessage(t, result.error || 'Failed to load teams') ||
              result.error ||
              'Failed to load teams'
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
        setIsLoadingTeams(false);
      }
    };

    loadTeams();
  }, [open, projectId, t]);

  return { teams, isLoadingTeams, error, setError };
}
