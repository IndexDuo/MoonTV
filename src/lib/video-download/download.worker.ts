/// <reference lib="webworker" />

import {
  downloadDirectory,
  VideoDownloadRequest,
  VideoDownloadResponse,
} from './types';

const worker = self as unknown as DedicatedWorkerGlobalScope;

// TypeScript 4.9 predates the synchronous OPFS writer in the worker DOM types.
type DownloadFileHandle = FileSystemFileHandle & {
  createSyncAccessHandle?: () => Promise<{
    write(data: Uint8Array, options: { at: number }): number;
    flush(): void;
    close(): void;
  }>;
};

function report(message: VideoDownloadResponse) {
  worker.postMessage(message);
}

function downloadError(message: string) {
  return new DOMException(message, 'VideoDownloadError');
}

async function prepareVideo({ url, temporaryName }: VideoDownloadRequest) {
  const source = new URL(url, worker.location.origin);
  if (!['https:', 'http:'].includes(source.protocol)) {
    throw downloadError('此播放源无法下载，请切换播放源。');
  }

  const {
    Conversion,
    HLS_FORMATS,
    Input,
    Mp4OutputFormat,
    Output,
    StreamTarget,
    UrlSource,
  } = await import('mediabunny');

  const input = new Input({
    formats: HLS_FORMATS,
    source: new UrlSource(source.href, {
      maxCacheSize: 16 * 1024 * 1024,
      getRetryDelay: (attempt) => (attempt < 2 ? attempt + 1 : null),
    }),
  });

  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) {
      throw downloadError('此播放源没有可下载的视频，请切换播放源。');
    }

    const audio = await video.getPrimaryPairableAudioTrack();
    if ((await video.isLive()) || (await audio?.isLive())) {
      throw downloadError('直播无法保存为 MP4。');
    }

    const root = await worker.navigator.storage.getDirectory();
    const directory = await root.getDirectoryHandle(downloadDirectory, {
      create: true,
    });
    const handle: DownloadFileHandle = await directory.getFileHandle(
      temporaryName,
      {
        create: true,
      }
    );
    if (!handle.createSyncAccessHandle) {
      throw downloadError('此浏览器无法保存大文件，请更新 Safari 后重试。');
    }
    const file = await handle.createSyncAccessHandle();

    try {
      const target = new StreamTarget(
        new WritableStream({
          write({ data, position }) {
            if (file.write(data, { at: position }) !== data.byteLength) {
              throw downloadError('无法写入文件，请检查设备的可用空间。');
            }
          },
        }),
        { chunked: true }
      );
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target,
      });

      const conversion = await Conversion.init({
        input,
        output,
        tracks: 'primary',
        copy: { mode: 'forced' },
      });
      if (
        !conversion.isValid ||
        !conversion.utilizedTracks.includes(video) ||
        (audio && !conversion.utilizedTracks.includes(audio))
      ) {
        throw downloadError('此播放源无法保存为 MP4，请切换播放源。');
      }

      let lastPercent = -1;
      conversion.onProgress = (fraction) => {
        const percent = Math.min(99, Math.floor(fraction * 100));
        if (percent > lastPercent) {
          lastPercent = percent;
          report({ type: 'progress', percent });
        }
      };
      await conversion.execute();
      file.flush();
    } finally {
      file.close();
    }

    report({ type: 'ready', file: await handle.getFile() });
  } finally {
    input.dispose();
  }
}

worker.onmessage = ({ data }: MessageEvent<VideoDownloadRequest>) => {
  void prepareVideo(data).catch((error: unknown) => {
    let message = '无法下载此视频，请检查网络或切换播放源。';
    if (error instanceof DOMException) {
      if (error.name === 'VideoDownloadError') {
        message = error.message;
      } else if (error.name === 'QuotaExceededError') {
        message = '设备空间不足，无法保存视频。';
      } else if (error.name === 'SecurityError') {
        message = '无法使用浏览器存储，请在 Safari 的普通标签页中重试。';
      }
    }
    report({ type: 'error', message });
  });
};
