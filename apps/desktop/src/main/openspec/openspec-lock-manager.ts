import type { OpenSpecAction } from '../../shared/types';

interface Waiter {
  owner: string;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  timeout: NodeJS.Timeout;
  abortListener?: () => void;
}

interface LockState {
  owner: string | null;
  queue: Waiter[];
}

type RootLockMode = 'shared' | 'exclusive';

interface RootWaiter extends Waiter {
  mode: RootLockMode;
}

interface RootLockState {
  writer: string | null;
  readers: Set<string>;
  queue: RootWaiter[];
}

const ROOT_EXCLUSIVE_ACTIONS = new Set<OpenSpecAction>([
  'update',
  'sync',
  'archive',
  'bulk-archive',
  'onboard',
]);

export class OpenSpecLockManager {
  private readonly locks = new Map<string, LockState>();
  private readonly rootLocks = new Map<string, RootLockState>();

  private acquire(
    key: string,
    owner: string,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Lock acquisition was cancelled.', 'AbortError'));
    }
    const state = this.locks.get(key) ?? { owner: null, queue: [] };
    this.locks.set(key, state);

    if (state.owner === null) {
      state.owner = owner;
      return Promise.resolve(() => this.release(key, owner));
    }
    if (state.owner === owner) {
      throw new Error(`OpenSpec lock "${key}" is not reentrant.`);
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        owner,
        resolve,
        reject,
        signal,
        timeout: setTimeout(() => {
          this.removeWaiter(key, waiter);
          reject(new Error(`Timed out waiting for OpenSpec lock "${key}".`));
        }, timeoutMs),
      };
      if (signal) {
        waiter.abortListener = () => {
          this.removeWaiter(key, waiter);
          reject(new DOMException('Lock acquisition was cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      state.queue.push(waiter);
    });
  }

  private removeWaiter(key: string, waiter: Waiter): void {
    const state = this.locks.get(key);
    if (!state) return;
    const index = state.queue.indexOf(waiter);
    if (index >= 0) state.queue.splice(index, 1);
    clearTimeout(waiter.timeout);
    if (waiter.abortListener) {
      waiter.signal?.removeEventListener('abort', waiter.abortListener);
    }
  }

  private release(key: string, owner: string): void {
    const state = this.locks.get(key);
    if (!state || state.owner !== owner) {
      return;
    }
    const next = state.queue.shift();
    if (!next) {
      this.locks.delete(key);
      return;
    }
    this.clearWaiter(next);
    state.owner = next.owner;
    next.resolve(() => this.release(key, next.owner));
  }

  private clearWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timeout);
    if (waiter.abortListener) {
      waiter.signal?.removeEventListener('abort', waiter.abortListener);
    }
  }

  private acquireRoot(
    key: string,
    owner: string,
    mode: RootLockMode,
    signal?: AbortSignal,
    timeoutMs = 30_000,
  ): Promise<() => void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Lock acquisition was cancelled.', 'AbortError'));
    }
    const state = this.rootLocks.get(key) ?? {
      writer: null,
      readers: new Set<string>(),
      queue: [],
    };
    this.rootLocks.set(key, state);
    if (
      state.writer === owner ||
      state.readers.has(owner) ||
      state.queue.some((waiter) => waiter.owner === owner)
    ) {
      throw new Error(`OpenSpec root lock "${key}" is not reentrant.`);
    }

    if (
      state.queue.length === 0 &&
      state.writer === null &&
      (mode === 'shared' || state.readers.size === 0)
    ) {
      if (mode === 'exclusive') {
        state.writer = owner;
      } else {
        state.readers.add(owner);
      }
      return Promise.resolve(() => this.releaseRoot(key, owner, mode));
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: RootWaiter = {
        owner,
        mode,
        resolve,
        reject,
        signal,
        timeout: setTimeout(() => {
          this.removeRootWaiter(key, waiter);
          reject(new Error(`Timed out waiting for OpenSpec root lock "${key}".`));
        }, timeoutMs),
      };
      if (signal) {
        waiter.abortListener = () => {
          this.removeRootWaiter(key, waiter);
          reject(new DOMException('Lock acquisition was cancelled.', 'AbortError'));
        };
        signal.addEventListener('abort', waiter.abortListener, { once: true });
      }
      state.queue.push(waiter);
      this.drainRootQueue(key, state);
    });
  }

  private removeRootWaiter(key: string, waiter: RootWaiter): void {
    const state = this.rootLocks.get(key);
    if (!state) return;
    const index = state.queue.indexOf(waiter);
    if (index >= 0) state.queue.splice(index, 1);
    this.clearWaiter(waiter);
    this.drainRootQueue(key, state);
  }

  private releaseRoot(key: string, owner: string, mode: RootLockMode): void {
    const state = this.rootLocks.get(key);
    if (!state) return;
    if (mode === 'exclusive') {
      if (state.writer !== owner) return;
      state.writer = null;
    } else if (!state.readers.delete(owner)) {
      return;
    }
    this.drainRootQueue(key, state);
  }

  private drainRootQueue(key: string, state: RootLockState): void {
    if (state.writer !== null) return;
    const first = state.queue[0];
    if (!first) {
      if (state.readers.size === 0) this.rootLocks.delete(key);
      return;
    }
    if (first.mode === 'exclusive') {
      if (state.readers.size > 0) return;
      state.queue.shift();
      this.clearWaiter(first);
      state.writer = first.owner;
      first.resolve(() => this.releaseRoot(key, first.owner, first.mode));
      return;
    }

    // Grant all readers queued before the next writer. Readers queued after a
    // writer remain behind it so destructive root operations cannot starve.
    while (state.queue[0]?.mode === 'shared' && state.writer === null) {
      const reader = state.queue.shift();
      if (!reader) break;
      this.clearWaiter(reader);
      state.readers.add(reader.owner);
      reader.resolve(() => this.releaseRoot(key, reader.owner, reader.mode));
    }
  }

  async acquireForAction(input: {
    rootKey: string;
    changeName?: string;
    action: OpenSpecAction;
    owner: string;
    signal?: AbortSignal;
  }): Promise<() => void> {
    if (input.action === 'explore') {
      return () => undefined;
    }

    const releases: Array<() => void> = [];
    try {
      const rootLockKey = `root:${input.rootKey}`;
      releases.push(await this.acquireRoot(
        rootLockKey,
        input.owner,
        ROOT_EXCLUSIVE_ACTIONS.has(input.action) ? 'exclusive' : 'shared',
        input.signal,
      ));

      if (input.action !== 'onboard' && input.action !== 'bulk-archive') {
        const changeKey = input.changeName?.trim() || '__new_change__';
        releases.push(await this.acquire(
          `change:${input.rootKey}:${changeKey}`,
          input.owner,
          input.signal,
        ));
      }
      return () => {
        for (const release of releases.reverse()) release();
      };
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
  }

  getOwner(key: string): string | null {
    const root = this.rootLocks.get(key);
    if (root) {
      return root.writer ?? ([...root.readers].sort().join(',') || null);
    }
    return this.locks.get(key)?.owner ?? null;
  }

  getBlockers(input: {
    rootKey: string;
    changeName?: string;
    action: OpenSpecAction;
  }): string[] {
    if (input.action === 'explore') return [];
    const blockers = new Set<string>();
    const root = this.rootLocks.get(`root:${input.rootKey}`);
    const exclusive = ROOT_EXCLUSIVE_ACTIONS.has(input.action);
    if (root) {
      if (root.writer) blockers.add(root.writer);
      if (exclusive) {
        for (const reader of root.readers) blockers.add(reader);
      }
    }
    if (input.action !== 'onboard' && input.action !== 'bulk-archive') {
      const changeKey = input.changeName?.trim() || '__new_change__';
      const owner = this.locks.get(`change:${input.rootKey}:${changeKey}`)?.owner;
      if (owner) blockers.add(owner);
    }
    return [...blockers].sort();
  }
}
