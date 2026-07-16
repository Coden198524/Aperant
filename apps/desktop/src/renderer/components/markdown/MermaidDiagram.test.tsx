/**
 * @vitest-environment jsdom
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReactMarkdown, { type Components } from 'react-markdown';
import {
  getMermaidChartSource,
  isMermaidCodeBlock,
  isMermaidPreChild,
  MermaidDiagram,
} from './MermaidDiagram';

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  bindFunctions: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidMocks.initialize,
    render: mermaidMocks.render,
  },
}));

const markdownComponents: Components = {
  code: ({ className, children }) => {
    if (isMermaidCodeBlock(className)) {
      return <MermaidDiagram chart={getMermaidChartSource(children)} />;
    }
    return <code className={className}>{children}</code>;
  },
  pre: ({ children }) => {
    if (isMermaidPreChild(children)) return <>{children}</>;
    return <pre>{children}</pre>;
  },
};

describe('MermaidDiagram', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('dark');
    mermaidMocks.render.mockResolvedValue({
      svg: '<svg data-testid="rendered-svg"><text>Rendered diagram</text></svg>',
      bindFunctions: mermaidMocks.bindFunctions,
    });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('dark');
  });

  it('renders Mermaid source as SVG with strict security settings', async () => {
    const chart = 'flowchart LR\n  A --> B';
    render(<MermaidDiagram chart={chart} />);

    const diagram = await screen.findByRole('img', { name: 'Mermaid diagram' });
    expect(diagram.querySelector('[data-testid="rendered-svg"]')).toBeInTheDocument();
    expect(mermaidMocks.initialize).toHaveBeenCalledWith({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'default',
    });
    expect(mermaidMocks.render).toHaveBeenCalledWith(expect.stringMatching(/^mermaid-/), chart);
    await waitFor(() => expect(mermaidMocks.bindFunctions).toHaveBeenCalledWith(diagram));
  });

  it('rerenders an automatic-theme diagram when the app theme changes', async () => {
    render(<MermaidDiagram chart="classDiagram\n  class Order" />);
    await screen.findByRole('img', { name: 'Mermaid diagram' });

    act(() => {
      document.documentElement.classList.add('dark');
    });

    await waitFor(() => {
      expect(mermaidMocks.initialize).toHaveBeenLastCalledWith(
        expect.objectContaining({ theme: 'dark' }),
      );
      expect(mermaidMocks.render).toHaveBeenCalledTimes(2);
    });
  });

  it('shows the original source when Mermaid rejects invalid syntax', async () => {
    const chart = 'not-a-valid-diagram';
    mermaidMocks.render.mockRejectedValueOnce(new Error('Parse error'));

    render(<MermaidDiagram chart={chart} />);

    expect(await screen.findByText('Unable to render Mermaid diagram')).toBeInTheDocument();
    expect(screen.getByText(chart)).toBeInTheDocument();
    expect(screen.getByTitle('Parse error')).toBeInTheDocument();
  });

  it('replaces a Mermaid fenced block without nesting a div inside pre', async () => {
    const { container } = render(
      <ReactMarkdown components={markdownComponents}>
        {'```mermaid\nsequenceDiagram\n  User->>System: Open\n```'}
      </ReactMarkdown>,
    );

    await screen.findByRole('img', { name: 'Mermaid diagram' });
    expect(container.querySelector('pre')).not.toBeInTheDocument();
    expect(mermaidMocks.render).toHaveBeenCalledWith(
      expect.stringMatching(/^mermaid-/),
      'sequenceDiagram\n  User->>System: Open',
    );
  });

  it('leaves non-Mermaid fenced code blocks unchanged', () => {
    const { container } = render(
      <ReactMarkdown components={markdownComponents}>
        {'```typescript\nconst value = 1;\n```'}
      </ReactMarkdown>,
    );

    expect(container.querySelector('pre code.language-typescript')).toHaveTextContent(
      'const value = 1;',
    );
    expect(mermaidMocks.render).not.toHaveBeenCalled();
  });
});

describe('Mermaid Markdown helpers', () => {
  it('detects Mermaid language tokens without matching other code blocks', () => {
    expect(isMermaidCodeBlock('language-mermaid')).toBe(true);
    expect(isMermaidCodeBlock('highlight language-MERMAID')).toBe(true);
    expect(isMermaidCodeBlock('language-typescript')).toBe(false);
    expect(isMermaidCodeBlock()).toBe(false);
  });

  it('detects the code child that ReactMarkdown wraps in pre', () => {
    expect(isMermaidPreChild(<code className="language-mermaid">flowchart LR</code>)).toBe(true);
    expect(isMermaidPreChild(<code className="language-text">flowchart LR</code>)).toBe(false);
    expect(isMermaidPreChild('plain text')).toBe(false);
  });

  it('removes only the trailing newline added to fenced code', () => {
    expect(getMermaidChartSource(['flowchart LR', '\n'])).toBe('flowchart LR');
  });
});
