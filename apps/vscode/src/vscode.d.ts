declare module 'vscode' {
  export interface Disposable {
    dispose(): unknown;
  }

  export interface ExtensionContext {
    readonly extensionUri: Uri;
    readonly subscriptions: Disposable[];
  }

  export class Uri {
    readonly fsPath: string;
    static file(path: string): Uri;
    static joinPath(base: Uri, ...pathSegments: string[]): Uri;
    toString(skipEncoding?: boolean): string;
  }

  export interface WorkspaceFolder {
    readonly uri: Uri;
    readonly name: string;
    readonly index: number;
  }

  export enum ViewColumn {
    Active = -1,
    Beside = -2,
    One = 1,
    Two = 2,
    Three = 3
  }

  export interface WebviewOptions {
    enableScripts?: boolean;
    localResourceRoots?: readonly Uri[];
  }

  export interface Webview {
    html: string;
    options: WebviewOptions;
    asWebviewUri(localResource: Uri): Uri;
    onDidReceiveMessage(listener: (message: unknown) => unknown): Disposable;
  }

  export interface WebviewPanel {
    readonly webview: Webview;
    readonly title: string;
    reveal(viewColumn?: ViewColumn): void;
    dispose(): unknown;
  }

  export interface WebviewView {
    readonly webview: Webview;
  }

  export interface WebviewViewProvider {
    resolveWebviewView(webviewView: WebviewView): void | Promise<void>;
  }

  export namespace commands {
    function registerCommand(command: string, callback: (...args: unknown[]) => unknown): Disposable;
    function executeCommand<T = unknown>(command: string, ...rest: unknown[]): Promise<T>;
  }

  export namespace workspace {
    const workspaceFolders: readonly WorkspaceFolder[] | undefined;

    function openTextDocument(uri: Uri): Promise<TextDocument>;
    function createFileSystemWatcher(globPattern: string): FileSystemWatcher;

    function getConfiguration(section?: string): {
      get<T>(section: string, defaultValue?: T): T | undefined;
    };
  }

  export interface FileSystemWatcher extends Disposable {
    onDidCreate(listener: (uri: Uri) => unknown): Disposable;
    onDidChange(listener: (uri: Uri) => unknown): Disposable;
    onDidDelete(listener: (uri: Uri) => unknown): Disposable;
  }

  export interface TextDocument {
    readonly uri: Uri;
  }

  export interface TextDocumentShowOptions {
    preview?: boolean;
    viewColumn?: ViewColumn;
  }

  export interface TextEditor {
    readonly document: TextDocument;
  }

  export interface Terminal {
    readonly name: string;
    sendText(text: string, shouldExecute?: boolean): void;
    show(preserveFocus?: boolean): void;
    dispose(): void;
  }

  export interface TerminalOptions {
    name?: string;
    cwd?: string | Uri;
    env?: Record<string, string | null | undefined>;
  }

  export namespace window {
    function createWebviewPanel(
      viewType: string,
      title: string,
      showOptions: ViewColumn,
      options?: WebviewOptions,
    ): WebviewPanel;

    function registerWebviewViewProvider(
      viewId: string,
      provider: WebviewViewProvider,
      options?: { webviewOptions?: { retainContextWhenHidden?: boolean } },
    ): Disposable;

    function showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
    function showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
    function showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
    function showTextDocument(document: TextDocument, options?: TextDocumentShowOptions): Promise<TextEditor>;
    function createTerminal(options: TerminalOptions): Terminal;
    function onDidCloseTerminal(listener: (terminal: Terminal) => unknown): Disposable;
    function showInputBox(options?: {
      title?: string;
      prompt?: string;
      placeHolder?: string;
      value?: string;
      ignoreFocusOut?: boolean;
    }): Promise<string | undefined>;
    function showQuickPick<T extends { label: string }>(
      items: readonly T[],
      options?: {
        title?: string;
        placeHolder?: string;
        ignoreFocusOut?: boolean;
      },
    ): Promise<T | undefined>;
  }
}
