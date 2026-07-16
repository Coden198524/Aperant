import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { cn } from '../../lib/utils';

type MermaidTheme = 'default' | 'dark';
type MermaidThemePreference = MermaidTheme | 'auto';

interface MermaidDiagramProps {
  chart: string;
  className?: string;
  theme?: MermaidThemePreference;
}

interface MermaidRenderResult {
  svg: string;
  bindFunctions?: (element: Element) => void;
}

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; result: MermaidRenderResult }
  | { status: 'error'; message: string };

let mermaidModulePromise: Promise<typeof import('mermaid')> | undefined;
let mermaidRenderQueue: Promise<void> = Promise.resolve();
let mermaidRenderSequence = 0;

function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidModulePromise ??= import('mermaid');
  return mermaidModulePromise;
}

function resolveTheme(preference: MermaidThemePreference): MermaidTheme {
  if (preference !== 'auto') return preference;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'default';
}

function enqueueMermaidRender(
  chart: string,
  id: string,
  theme: MermaidTheme,
): Promise<MermaidRenderResult> {
  const render = async (): Promise<MermaidRenderResult> => {
    const { default: mermaid } = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme,
    });
    return mermaid.render(id, chart);
  };

  const result = mermaidRenderQueue.then(render, render);
  mermaidRenderQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function isMermaidCodeBlock(className?: string): boolean {
  return className
    ?.split(/\s+/)
    .some((token) => token.toLowerCase() === 'language-mermaid') ?? false;
}

export function isMermaidPreChild(children: ReactNode): boolean {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1 || !isValidElement<{ className?: string }>(childNodes[0])) {
    return false;
  }

  return isMermaidCodeBlock(childNodes[0].props.className);
}

export function getMermaidChartSource(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => (typeof child === 'string' || typeof child === 'number' ? String(child) : ''))
    .join('')
    .replace(/\n$/, '');
}

export function MermaidDiagram({ chart, className, theme = 'auto' }: MermaidDiagramProps) {
  const reactId = useId();
  const diagramRef = useRef<HTMLDivElement>(null);
  const [resolvedTheme, setResolvedTheme] = useState<MermaidTheme>(() => resolveTheme(theme));
  const [renderState, setRenderState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    setResolvedTheme(resolveTheme(theme));
    if (theme !== 'auto') return;

    const observer = new MutationObserver(() => {
      setResolvedTheme(resolveTheme('auto'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [theme]);

  useEffect(() => {
    let cancelled = false;
    const renderId = `mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}-${++mermaidRenderSequence}`;
    setRenderState({ status: 'loading' });

    void enqueueMermaidRender(chart, renderId, resolvedTheme)
      .then((result) => {
        if (!cancelled) setRenderState({ status: 'ready', result });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setRenderState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unknown Mermaid rendering error',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [chart, reactId, resolvedTheme]);

  useEffect(() => {
    if (renderState.status === 'ready' && diagramRef.current) {
      renderState.result.bindFunctions?.(diagramRef.current);
    }
  }, [renderState]);

  if (renderState.status === 'loading') {
    return (
      <div
        className={cn(
          'not-prose my-4 flex min-h-32 items-center justify-center rounded-md border border-border bg-muted/20',
          className,
        )}
        role="status"
        aria-label="Rendering Mermaid diagram"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  if (renderState.status === 'error') {
    return (
      <div
        className={cn('not-prose my-4 overflow-hidden rounded-md border border-destructive/40 bg-destructive/5', className)}
        title={renderState.message}
      >
        <div className="flex items-center gap-2 border-b border-destructive/20 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Unable to render Mermaid diagram</span>
        </div>
        <pre className="max-h-72 overflow-auto whitespace-pre p-3 text-xs leading-relaxed text-foreground">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className={cn('not-prose my-4 overflow-x-auto rounded-md border border-border bg-background p-4', className)}>
      <div
        ref={diagramRef}
        className="flex min-w-fit justify-center [&_svg]:block [&_svg]:h-auto [&_svg]:max-w-none"
        role="img"
        aria-label="Mermaid diagram"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid strict mode sanitizes generated SVG markup.
        dangerouslySetInnerHTML={{ __html: renderState.result.svg }}
      />
    </div>
  );
}
