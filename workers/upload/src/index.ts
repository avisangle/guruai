import { AwsClient } from "aws4fetch";
import { parseDeletionRequest, parseLinkRequest, type LinkRequest } from "./validate";

const LINK_TTL_SECONDS = 900;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

// Path-style R2 S3 URLs, signed in the query string for PUT only (host is the one signed header).
// Signed one at a time so every URL after the first reuses the client's cached signing key.
async function presignPuts(env: Env, req: LinkRequest): Promise<Response> {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const signedAt = Math.floor(Date.now() / 1000) * 1000;
  const datetime = new Date(signedAt).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const prefix = `uploads/${req.device_id}/${req.child_code}/${req.session_id}`;
  const urls = [];
  for (const { name } of req.files) {
    const url = new URL(`https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BUCKET}/${prefix}/${name}`);
    url.searchParams.set("X-Amz-Expires", String(LINK_TTL_SECONDS));
    const signed = await client.sign(url.toString(), { method: "PUT", aws: { signQuery: true, datetime } });
    urls.push({ name, url: signed.url });
  }
  return json({ expires_at: new Date(signedAt + LINK_TTL_SECONDS * 1000).toISOString(), urls });
}

async function recordDeletion(env: Env, req: { device_id: string }): Promise<Response> {
  const requestedAt = new Date().toISOString();
  await env.UPLOADS.put(
    `deletion-requests/${req.device_id}/${requestedAt}.json`,
    JSON.stringify({ device_id: req.device_id, requested_at: requestedAt }),
    { httpMetadata: { contentType: "application/json" } },
  );
  return new Response(null, { status: 202 });
}

// Validates the body, then applies the per-device rate limit, before the route's handler runs.
function route<T extends { device_id: string }>(
  parse: (body: unknown) => T | null,
  run: (env: Env, req: T) => Promise<Response>,
) {
  return async (env: Env, body: unknown): Promise<Response> => {
    const req = parse(body);
    if (!req) return error(400, "invalid request");
    const { success } = await env.RATE_LIMITER.limit({ key: req.device_id });
    if (!success) return error(429, "too many requests");
    return run(env, req);
  };
}

const routes: Record<string, (env: Env, body: unknown) => Promise<Response>> = {
  "/v1/upload-links": route(parseLinkRequest, presignPuts),
  "/v1/deletion-request": route(parseDeletionRequest, recordDeletion),
};

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // The app key ships inside the APK; it keeps casual traffic out, nothing more.
    if (!env.APP_KEY || request.headers.get("x-guru-app") !== env.APP_KEY) return error(401, "unauthorized");

    const handle = routes[new URL(request.url).pathname];
    if (!handle) return error(404, "not found");
    if (request.method !== "POST") return error(405, "method not allowed");

    return handle(env, await request.json().catch(() => undefined));
  },
} satisfies ExportedHandler<Env>;
