import { Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import { getAppLanguage } from './app-language';
import { projectStore } from './project-store';

export type NotificationType = 'task-complete' | 'task-failed' | 'review-needed';

interface NotificationOptions {
  title: string;
  body: string;
  projectId?: string;
  taskId?: string;
}

type NotificationContent = {
  title: string;
  body: (taskTitle: string) => string;
};

function normalizeLanguage(language: string): 'en' | 'fr' | 'zh-CN' {
  if (language.startsWith('zh')) {
    return 'zh-CN';
  }

  if (language.startsWith('fr')) {
    return 'fr';
  }

  return 'en';
}

function getNotificationContent(type: NotificationType): NotificationContent {
  const language = normalizeLanguage(getAppLanguage());

  const content: Record<'en' | 'fr' | 'zh-CN', Record<NotificationType, NotificationContent>> = {
    en: {
      'task-complete': {
        title: 'Task Complete',
        body: (taskTitle) => `"${taskTitle}" has completed and is ready for review`
      },
      'task-failed': {
        title: 'Task Failed',
        body: (taskTitle) => `"${taskTitle}" encountered an error`
      },
      'review-needed': {
        title: 'Review Needed',
        body: (taskTitle) => `"${taskTitle}" is ready for your review`
      }
    },
    fr: {
      'task-complete': {
        title: 'Tache terminee',
        body: (taskTitle) => `"${taskTitle}" est terminee et prete pour relecture`
      },
      'task-failed': {
        title: 'Echec de la tache',
        body: (taskTitle) => `Une erreur est survenue dans "${taskTitle}"`
      },
      'review-needed': {
        title: 'Relecture requise',
        body: (taskTitle) => `"${taskTitle}" est pret pour votre relecture`
      }
    },
    'zh-CN': {
      'task-complete': {
        title: '任务已完成',
        body: (taskTitle) => `“${taskTitle}”已完成，等待你审查`
      },
      'task-failed': {
        title: '任务失败',
        body: (taskTitle) => `“${taskTitle}”执行时发生错误`
      },
      'review-needed': {
        title: '需要审查',
        body: (taskTitle) => `“${taskTitle}”已准备好，等待你审查`
      }
    }
  };

  return content[language][type];
}

/**
 * Service for sending system notifications with optional sound
 */
class NotificationService {
  private mainWindow: (() => BrowserWindow | null) | null = null;

  /**
   * Initialize the notification service with the main window getter
   */
  initialize(getMainWindow: () => BrowserWindow | null): void {
    this.mainWindow = getMainWindow;
  }

  /**
   * Send a notification for task completion
   */
  notifyTaskComplete(taskTitle: string, projectId: string, taskId: string): void {
    const content = getNotificationContent('task-complete');
    this.sendNotification('task-complete', {
      title: content.title,
      body: content.body(taskTitle),
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for task failure
   */
  notifyTaskFailed(taskTitle: string, projectId: string, taskId: string): void {
    const content = getNotificationContent('task-failed');
    this.sendNotification('task-failed', {
      title: content.title,
      body: content.body(taskTitle),
      projectId,
      taskId
    });
  }

  /**
   * Send a notification for review needed
   */
  notifyReviewNeeded(taskTitle: string, projectId: string, taskId: string): void {
    const content = getNotificationContent('review-needed');
    this.sendNotification('review-needed', {
      title: content.title,
      body: content.body(taskTitle),
      projectId,
      taskId
    });
  }

  /**
   * Send a system notification with optional sound
   */
  private sendNotification(type: NotificationType, options: NotificationOptions): void {
    // Get notification settings
    const settings = this.getNotificationSettings(options.projectId);

    // Check if this notification type is enabled
    if (!this.isNotificationEnabled(type, settings)) {
      return;
    }

    // Create and show the notification
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        silent: !settings.sound // Let the OS handle sound if enabled
      });

      // Focus window when notification is clicked
      notification.on('click', () => {
        const window = this.mainWindow?.();
        if (window) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.focus();
        }
      });

      notification.show();
    }

    // Play sound if enabled (system beep)
    if (settings.sound) {
      this.playNotificationSound();
    }
  }

  /**
   * Play a notification sound
   */
  private playNotificationSound(): void {
    // Use system beep - works across all platforms
    shell.beep();
  }

  /**
   * Get notification settings for a project or fall back to defaults
   */
  private getNotificationSettings(projectId?: string): {
    onTaskComplete: boolean;
    onTaskFailed: boolean;
    onReviewNeeded: boolean;
    sound: boolean;
  } {
    // Try to get project-specific settings
    if (projectId) {
      const projects = projectStore.getProjects();
      const project = projects.find(p => p.id === projectId);
      if (project?.settings?.notifications) {
        return project.settings.notifications;
      }
    }

    // Fall back to defaults
    return {
      onTaskComplete: true,
      onTaskFailed: true,
      onReviewNeeded: true,
      sound: false
    };
  }

  /**
   * Check if a notification type is enabled in settings
   */
  private isNotificationEnabled(
    type: NotificationType,
    settings: {
      onTaskComplete: boolean;
      onTaskFailed: boolean;
      onReviewNeeded: boolean;
      sound: boolean;
    }
  ): boolean {
    switch (type) {
      case 'task-complete':
        return settings.onTaskComplete;
      case 'task-failed':
        return settings.onTaskFailed;
      case 'review-needed':
        return settings.onReviewNeeded;
      default:
        return false;
    }
  }
}

// Export singleton instance
export const notificationService = new NotificationService();
