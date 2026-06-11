import { getDistClientDir, WebLocalService } from './local-service.js';
import { getDefaultWebDataDir, WebProjectStore } from './project-store.js';

const host = process.env.AUTOCODE_WEB_HOST ?? '127.0.0.1';
const port = Number.parseInt(process.env.AUTOCODE_WEB_PORT ?? '4728', 10);

const projectStore = new WebProjectStore(getDefaultWebDataDir());
const service = new WebLocalService({
  host,
  port,
  staticDir: getDistClientDir(import.meta.url),
  projectStore,
});

await service.start();

console.log(`Autocode Web local service running at http://${host}:${port}`);
console.log(`Data directory: ${projectStore.getDataDir()}`);
