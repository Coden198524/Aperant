import type { NotificationAdapter } from '@autocode/core';

export function createDesktopNotificationAdapter(impl: {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}): NotificationAdapter {
  return {
    async info(message: string) {
      impl.info(message);
    },
    async warn(message: string) {
      impl.warn(message);
    },
    async error(message: string) {
      impl.error(message);
    },
  };
}
