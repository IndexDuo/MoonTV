export const downloadDirectory = 'moontv-downloads';

export type VideoDownloadRequest = {
  url: string;
  temporaryName: string;
};

export type VideoDownloadResponse =
  | { type: 'progress'; percent: number }
  | { type: 'ready'; file: File }
  | { type: 'error'; message: string };
