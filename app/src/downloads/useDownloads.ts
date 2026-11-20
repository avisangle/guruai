// Live download status for screens; re-renders on progress, installs and the Wi-Fi rule.
import { useSyncExternalStore } from 'react';

import { downloadStatus, subscribeDownloads, type DownloadStatus } from './downloader';

export function useDownloads(): DownloadStatus {
  return useSyncExternalStore(subscribeDownloads, downloadStatus);
}

/** Changes when a model or pack is queued, installed or fails, not on byte progress. */
export const installKey = (status: DownloadStatus) => status.items.map((i) => `${i.id}:${i.status}`).join();
