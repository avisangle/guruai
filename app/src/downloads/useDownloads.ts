// Live download status for screens; re-renders on progress, installs and the Wi-Fi rule.
import { useSyncExternalStore } from 'react';

import { downloadStatus, subscribeDownloads, type DownloadStatus } from './downloader';

export function useDownloads(): DownloadStatus {
  return useSyncExternalStore(subscribeDownloads, downloadStatus);
}
