// Webpack uses this URL to bundle and lazy-load the worker entry.
export function createDownloadWorker() {
  return new Worker(new URL('./download.worker.ts', import.meta.url));
}
