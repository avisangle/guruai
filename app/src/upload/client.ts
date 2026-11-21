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

/** The last path segment: the name a file is uploaded and listed under. */
export const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

function ok<R extends { ok: boolean; status: number }>(res: R): R {
  if (!res.ok) throw new Error(`upload request failed: HTTP ${res.status}`);
  return res;
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
      return (await ok(await post('/v1/upload-links', req)).json()) as Links;
    },
    /** Uploads one file to its presigned link; the signal aborts it. */
    async put(url: string, bytes: Uint8Array, type: string, signal: AbortSignal): Promise<void> {
      ok(await fetch(url, { method: 'PUT', headers: { 'content-type': type }, body: bytes, signal }));
    },
    /** Asks the admin to delete everything this device sent. */
    async deletionRequest(deviceId: string): Promise<void> {
      ok(await post('/v1/deletion-request', { device_id: deviceId }));
    },
  };
}

export type UploadClient = ReturnType<typeof createUploadClient>;
