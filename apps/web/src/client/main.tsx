import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LogOut } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import '../../../desktop/src/renderer/lib/browser-mock';
import '../../../desktop/src/shared/i18n';
import { App } from '../../../desktop/src/renderer/App';
import './desktop.css';
import { installWebDesktopApiAdapter } from './desktop-api-adapter';
import { PlatformAuthGate } from './PlatformAuthGate';
import { logoutPlatformAccount } from './platform-auth';
import type { WebPlatformAccount } from '../shared/api';

let adapterInstalled = false;

function ensureWebDesktopAdapterInstalled(): void {
  if (adapterInstalled) return;
  installWebDesktopApiAdapter();
  adapterInstalled = true;
}

function WebRoot() {
  const [account, setAccount] = useState<WebPlatformAccount | undefined>();
  const [isAuthenticated, setIsAuthenticated] = useState(false);

  const handleAuthenticated = useCallback((nextAccount?: WebPlatformAccount) => {
    ensureWebDesktopAdapterInstalled();
    setAccount(nextAccount);
    setIsAuthenticated(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await logoutPlatformAccount().catch((error) => {
      console.warn('[Web] Failed to log out platform account:', error);
    });
    window.location.reload();
  }, []);

  useEffect(() => {
    const handleExpired = () => {
      setIsAuthenticated(false);
      setAccount(undefined);
    };
    window.addEventListener('autocode-web-auth-expired', handleExpired);
    return () => window.removeEventListener('autocode-web-auth-expired', handleExpired);
  }, []);

  if (!isAuthenticated) {
    return <PlatformAuthGate onAuthenticated={handleAuthenticated} />;
  }

  return (
    <>
      <App />
      <button
        type="button"
        className="platform-session-button"
        title={account ? `退出 ${account.username}` : '退出平台账号'}
        onClick={handleLogout}
      >
        <LogOut aria-hidden="true" />
        <span>{account?.username ?? 'Logout'}</span>
      </button>
    </>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <WebRoot />
  </StrictMode>,
);
