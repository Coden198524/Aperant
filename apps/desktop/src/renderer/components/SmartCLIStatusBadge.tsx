import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, Terminal, X } from 'lucide-react';
import type { SupportedCLI } from '../../shared/types/settings';
import type { CodexCliVersionInfo } from '../../shared/types/cli';
import { getCliLabel } from '../lib/cli-display';
import { Button } from './ui/button';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import { ClaudeCodeStatusBadge } from './ClaudeCodeStatusBadge';
import { cn } from '../lib/utils';

interface SmartCLIStatusBadgeProps {
  cli: SupportedCLI;
  className?: string;
}

type CodexStatus = 'loading' | 'installed' | 'not-found' | 'error';

export function SmartCLIStatusBadge({ cli, className }: SmartCLIStatusBadgeProps) {
  if (cli === 'claude-code') {
    return <ClaudeCodeStatusBadge className={className} />;
  }

  if (cli === 'codex') {
    return <CodexStatusBadge className={className} />;
  }

  if (cli === 'deepseek') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" className={cn('h-7 text-xs gap-1.5', className)}>
            <div className="relative">
              <Terminal className="h-4 w-4" />
              <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-green-500" />
            </div>
            <span className="truncate">DeepSeek</span>
            <span className="ml-auto text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded">
              Built-in
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">DeepSeek built-in CLI</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Button variant="outline" size="sm" className={cn('h-7 text-xs gap-1.5', className)}>
      <Terminal className="h-4 w-4" />
      <span className="truncate">{getCliLabel(cli)}</span>
    </Button>
  );
}

function CodexStatusBadge({ className }: { className?: string }) {
  const [status, setStatus] = useState<CodexStatus>('loading');
  const [versionInfo, setVersionInfo] = useState<CodexCliVersionInfo | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const refresh = useCallback(async () => {
    setStatus('loading');
    try {
      const result = await window.electronAPI.checkCodexCliVersion();
      if (!result.success || !result.data) {
        setStatus('error');
        return;
      }
      setVersionInfo(result.data);
      setStatus(result.data.installed ? 'installed' : 'not-found');
    } catch (error) {
      console.error('Failed to check Codex CLI version:', error);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const statusColor = status === 'installed'
    ? 'bg-green-500'
    : status === 'loading'
      ? 'bg-muted-foreground'
      : 'bg-destructive';
  const tooltip = status === 'installed'
    ? 'Codex CLI installed'
    : status === 'loading'
      ? 'Checking Codex CLI...'
      : 'Codex CLI not found';

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-7 text-xs gap-1.5',
                status === 'not-found' || status === 'error' ? 'text-destructive' : '',
                className
              )}
            >
              <div className="relative">
                <Terminal className="h-4 w-4" />
                <span className={cn('absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full', statusColor)} />
              </div>
              <span className="truncate">Codex</span>
              {status === 'not-found' && (
                <span className="ml-auto text-[10px] bg-destructive/20 text-destructive px-1.5 py-0.5 rounded">
                  Missing
                </span>
              )}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltip}</TooltipContent>
      </Tooltip>

      <PopoverContent side="bottom" align="end" className="w-72">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Terminal className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-medium">Codex CLI</h4>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {status === 'loading' && <Loader2 className="h-3 w-3 animate-spin" />}
                {status === 'installed' && <Check className="h-3 w-3" />}
                {(status === 'not-found' || status === 'error') && <X className="h-3 w-3" />}
                {status === 'installed' ? 'Installed' : status === 'loading' ? 'Checking...' : 'Not installed'}
              </p>
            </div>
          </div>

          {versionInfo && status !== 'loading' && (
            <div className="text-xs space-y-1 p-2 bg-muted rounded-md">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Current</span>
                <span className="font-mono">{versionInfo.installed || 'Not installed'}</span>
              </div>
              {versionInfo.path && (
                <div className="flex justify-between items-center gap-2">
                  <span className="text-muted-foreground">Path</span>
                  <span className="font-mono text-[10px] truncate max-w-[180px]" title={versionInfo.path}>
                    {versionInfo.path}
                  </span>
                </div>
              )}
              {!versionInfo.installed && (
                <div className="text-destructive">
                  {versionInfo.detectionResult.message}
                </div>
              )}
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1" onClick={refresh} disabled={status === 'loading'}>
              <RefreshCw className={cn('h-3 w-3', status === 'loading' && 'animate-spin')} />
              Refresh
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
