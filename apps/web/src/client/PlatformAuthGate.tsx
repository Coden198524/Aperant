import { Loader2, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

import type { WebPlatformAccount } from '../shared/api';
import {
  getPlatformAuthStatus,
  loginPlatformAccount,
  PlatformAuthRequestError,
  setupPlatformAccount,
} from './platform-auth';
import './platform-auth.css';

interface PlatformAuthGateProps {
  onAuthenticated: (account?: WebPlatformAccount) => void;
}

export function PlatformAuthGate({ onAuthenticated }: PlatformAuthGateProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(false);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [serviceOutdated, setServiceOutdated] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    getPlatformAuthStatus()
      .then((auth) => {
        if (cancelled) return;
        if (auth.authenticated) {
          onAuthenticated(auth.account);
          return;
        }
        setIsConfigured(auth.configured);
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof PlatformAuthRequestError && err.statusCode === 404) {
          setServiceOutdated(true);
          setIsConfigured(true);
          setError('Web 本地服务还没有加载平台账号接口，请重启 Web 服务后刷新页面。');
        } else {
          setError(err instanceof Error ? err.message : '无法连接 Web 本地服务。');
        }
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [onAuthenticated]);

  const mode = isConfigured ? 'login' : 'setup';
  const title = mode === 'setup' ? '初始化平台账号' : '登录 Autocode Web';
  const description = mode === 'setup'
    ? '首次使用 Web 平台前，请创建一个本地管理员账号。'
    : '请输入平台账号，继续访问项目、任务和本地服务。';
  const helperText = mode === 'setup'
    ? '没有默认账号密码；这里创建的就是 Web 平台账号。'
    : '如果忘记密码，删除 platform-auth.json 后重启 Web 服务可重新初始化。';

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isSubmitting || serviceOutdated) return;

    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 3) {
      setError('账号至少需要 3 个字符。');
      return;
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmedUsername)) {
      setError('账号只能使用字母、数字、点、下划线或连字符。');
      return;
    }
    if (password.length < 8) {
      setError('密码至少需要 8 个字符。');
      return;
    }
    if (mode === 'setup' && password !== confirmPassword) {
      setError('两次输入的密码不一致。');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const account = mode === 'setup'
        ? await setupPlatformAccount({ username: trimmedUsername, password })
        : await loginPlatformAccount({ username: trimmedUsername, password });
      onAuthenticated(account);
    } catch (err) {
      if (err instanceof PlatformAuthRequestError && err.statusCode === 401) {
        setError('账号或密码错误。');
      } else {
        setError(err instanceof Error ? err.message : '认证失败，请重试。');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <main className="platform-auth-shell">
        <div className="platform-auth-panel platform-auth-loading">
          <Loader2 className="platform-auth-spinner" aria-hidden="true" />
          <span>正在检查平台账号...</span>
        </div>
      </main>
    );
  }

  return (
    <main className="platform-auth-shell">
      <section className="platform-auth-panel" aria-labelledby="platform-auth-title">
        <div className="platform-auth-mark">
          <ShieldCheck aria-hidden="true" />
        </div>
        <div className="platform-auth-heading">
          <h1 id="platform-auth-title">{title}</h1>
          <p>{description}</p>
          <p className="platform-auth-help">{helperText}</p>
        </div>

        <form className="platform-auth-form" onSubmit={handleSubmit} noValidate>
          <label>
            <span>账号</span>
            <div className="platform-auth-field">
              <UserRound aria-hidden="true" />
              <input
                autoComplete="username"
                autoFocus
                minLength={3}
                maxLength={64}
                pattern="[a-zA-Z0-9._-]+"
                required
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
              />
            </div>
          </label>

          <label>
            <span>密码</span>
            <div className="platform-auth-field">
              <LockKeyhole aria-hidden="true" />
              <input
                autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
                minLength={8}
                required
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="至少 8 个字符"
              />
            </div>
          </label>

          {mode === 'setup' && (
            <label>
              <span>确认密码</span>
              <div className="platform-auth-field">
                <LockKeyhole aria-hidden="true" />
                <input
                  autoComplete="new-password"
                  minLength={8}
                  required
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="再次输入密码"
                />
              </div>
            </label>
          )}

          {mode === 'setup' && password && confirmPassword && password !== confirmPassword && (
            <p className="platform-auth-error">两次输入的密码不一致。</p>
          )}
          {error && <p className="platform-auth-error">{error}</p>}

          <button type="submit" disabled={serviceOutdated || isSubmitting}>
            {isSubmitting && <Loader2 className="platform-auth-button-spinner" aria-hidden="true" />}
            {isSubmitting
              ? (mode === 'setup' ? '正在创建...' : '正在登录...')
              : (mode === 'setup' ? '创建并登录' : '登录')}
          </button>
        </form>
      </section>
    </main>
  );
}
