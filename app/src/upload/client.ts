// The upload Worker's two endpoints (TDD 2.8, D-GURU-6-upload-auth) and the presigned R2 PUT.
// The only module that knows the Worker's URL and app key.

export type UploadConfig = { url: string; key: string };

/** The fetch shape the client needs; expo/fetch and the test fake both fit. */
export type FetchPort = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type UploadFile = { name: string; bytes: number; type: string };
export type LinkRequest = { device_id: string; child_code: string; session_id: string; files: UploadFile[] };
export type Links = { expires_at: string; urls: { name: string; url: string }[] };

/** From EXPO_PUBLIC_UPLOAD_URL and EXPO_PUBLIC_UPLOAD_KEY; null when either is unset (nothing uploads). */
export function uploadConfig(): UploadConfig | null {
  const url = process.env.EXPO_PUBLIC_UPLOAD_URL ?? '';
  const key = process.env.EXPO_PUBLIC_UPLOAD_KEY ?? '';
  return url && key ? { url: url.replace(/\/$/, ''), key } : null;
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`upload request failed: HTTP ${status}`);
  }
}

export function createUploadClient(config: UploadConfig, fetch: FetchPort) {
  const post = (path: string, body: object) =>
    fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-guru-app': config.key },
      body: JSON.stringify(body),
    });

  return {
    /** Presigned PUT links for one session's files. */
    async links(req: LinkRequest): Promise<Links> {
      const res = await post('/v1/upload-links', req);
      if (!res.ok) throw new HttpError(res.status);
      return (await res.json()) as Links;
    },
    /** Uploads one file to its presigned link; the signal aborts it. */
    async put(url: string, bytes: Uint8Array, type: string, signal: AbortSignal): Promise<void> {
      const res = await fetch(url, { method: 'PUT', headers: { 'content-type': type }, body: bytes, signal });
      if (!res.ok) throw new HttpError(res.status);
    },
    /** Asks the admin to delete everything this device sent. */
    async deletionRequest(deviceId: string): Promise<void> {
      const res = await post('/v1/deletion-request', { device_id: deviceId });
      if (!res.ok) throw new HttpError(res.status);
    },
  };
}

export type UploadClient = ReturnType<typeof createUploadClient>;
