'use client';

import { Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { createDownloadWorker } from '@/lib/video-download/create-worker';
import {
  downloadDirectory,
  VideoDownloadRequest,
  VideoDownloadResponse,
} from '@/lib/video-download/types';

type DownloadState =
  | { type: 'idle' }
  | { type: 'preparing'; percent: number | null }
  | { type: 'ready'; url: string; saved: boolean }
  | { type: 'error'; message: string };

type DownloadJob = {
  worker: Worker;
  temporaryName: string;
  objectUrl?: string;
  savedAt?: number;
};

const actionClass =
  'inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-900 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 dark:border-gray-600 dark:text-gray-100 dark:hover:bg-gray-800';

async function removeTemporaryFile(name: string) {
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle(downloadDirectory);
  await directory.removeEntry(name);
}

function releaseJob(job: DownloadJob) {
  job.worker.terminate();

  const releaseFile = () => {
    if (job.objectUrl) URL.revokeObjectURL(job.objectUrl);
    void removeTemporaryFile(job.temporaryName).catch((error: unknown) => {
      // A canceled worker may still be releasing its file handle.
      if (error instanceof DOMException && error.name !== 'NotFoundError') {
        window.setTimeout(() => {
          void removeTemporaryFile(job.temporaryName).catch(() => undefined);
        }, 1000);
      }
    });
  };

  if (job.savedAt) {
    // Safari may still be reading the file after the user leaves this episode.
    window.setTimeout(
      releaseFile,
      Math.max(0, job.savedAt + 60_000 - Date.now())
    );
  } else {
    releaseFile();
  }
}

function downloadName(title: string, episode?: number) {
  const base = title
    .replace(/[<>:"/\\|?*]/g, ' ')
    .trim()
    .slice(0, 120);
  const suffix = episode ? ` - 第 ${episode} 集` : '';
  return `${base || 'MoonTV'}${suffix}.mp4`;
}

export default function VideoDownload({
  url,
  title,
  episode,
  disabled,
}: {
  url: string;
  title: string;
  episode?: number;
  disabled: boolean;
}) {
  const [state, setState] = useState<DownloadState>({ type: 'idle' });
  const jobRef = useRef<DownloadJob | null>(null);

  useEffect(() => {
    return () => {
      if (jobRef.current) releaseJob(jobRef.current);
      jobRef.current = null;
    };
  }, []);

  function startDownload() {
    if (jobRef.current) return;

    if (!window.isSecureContext || !navigator.storage?.getDirectory) {
      setState({
        type: 'error',
        message: '请使用支持下载的浏览器，并通过 HTTPS 打开 MoonTV。',
      });
      return;
    }

    try {
      const job: DownloadJob = {
        temporaryName: `${window.crypto.randomUUID()}.mp4`,
        worker: createDownloadWorker(),
      };
      jobRef.current = job;
      setState({ type: 'preparing', percent: null });

      const fail = (message: string) => {
        if (jobRef.current !== job) return;
        jobRef.current = null;
        releaseJob(job);
        setState({ type: 'error', message });
      };

      job.worker.onerror = () => {
        fail('无法启动下载，请在 Safari 的普通标签页中重试。');
      };
      job.worker.onmessage = ({
        data,
      }: MessageEvent<VideoDownloadResponse>) => {
        if (jobRef.current !== job) return;

        switch (data.type) {
          case 'progress':
            setState({ type: 'preparing', percent: data.percent });
            break;
          case 'ready':
            job.worker.terminate();
            job.objectUrl = URL.createObjectURL(
              data.file.slice(0, data.file.size, 'video/mp4')
            );
            setState({ type: 'ready', url: job.objectUrl, saved: false });
            break;
          case 'error':
            fail(data.message);
            break;
        }
      };

      const request: VideoDownloadRequest = {
        url,
        temporaryName: job.temporaryName,
      };
      job.worker.postMessage(request);
    } catch {
      if (jobRef.current) releaseJob(jobRef.current);
      jobRef.current = null;
      setState({ type: 'error', message: '无法启动下载，请刷新页面后重试。' });
    }
  }

  function cancelDownload() {
    if (jobRef.current) releaseJob(jobRef.current);
    jobRef.current = null;
    setState({ type: 'idle' });
  }

  return (
    <div className='flex flex-wrap items-center gap-2'>
      {state.type === 'ready' ? (
        <>
          <a
            className={actionClass}
            href={state.url}
            download={downloadName(title, episode)}
            onClick={() => {
              if (jobRef.current) jobRef.current.savedAt = Date.now();
              setState({ ...state, saved: true });
            }}
          >
            <Download size={16} aria-hidden='true' />
            保存 MP4
          </a>
          <span
            className='text-sm text-gray-600 dark:text-gray-400'
            role='status'
          >
            {state.saved
              ? '请在浏览器的下载列表中查看文件。'
              : '视频已准备好。'}
          </span>
        </>
      ) : state.type === 'preparing' ? (
        <>
          <span
            className='text-sm text-gray-600 dark:text-gray-400'
            role='status'
          >
            下载中，请保持此页面打开。
          </span>
          <progress
            aria-label='下载进度'
            max={100}
            value={state.percent ?? undefined}
          />
          <button
            className={actionClass}
            type='button'
            onClick={cancelDownload}
          >
            取消
          </button>
        </>
      ) : (
        <>
          <button
            className={actionClass}
            type='button'
            onClick={startDownload}
            disabled={disabled}
          >
            <Download size={16} aria-hidden='true' />
            下载视频
          </button>
          {state.type === 'error' && (
            <span
              className='text-sm text-red-700 dark:text-red-300'
              role='alert'
            >
              {state.message}
            </span>
          )}
        </>
      )}
    </div>
  );
}
