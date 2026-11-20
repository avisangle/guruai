import { AwsClient } from "aws4fetch";
import { parseDeletionRequest, parseLinkRequest, type LinkRequest } from "./validate";

const LINK_TTL_SECONDS = 900;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const error = (status: number, message: string) => json({ error: message }, status);

// Path-style R2 S3 URLs, signed in the query string for PUT only (host is the one signed header).
async function presignPuts(env: Env, req: LinkRequest) {
  const client = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
  const signedAt = Math.floor(Date.now() / 1000) * 1000;
  const datetime = new Date(signedAt).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const prefix = `uploads/${req.device_id}/${req.child_code}/${req.session_id}`;
  const urls = await Promise.all(
    req.files.map(async ({ name }) => {
      const url = new URL(`https://${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${env.BUCKET}/${prefix}/${name}`);
      url.searchParams.set("X-Amz-Expires", String(LINK_TTL_SECONDS));
      const signed = await client.sign(url.toString(), { method: "PUT", aws: { signQuery: true, datetime } });
      return { name, url: signed.url };
    }),
  );
  return { expires_at: new Date(signedAt + LINK_TTL_SECONDS * 1000).toISOString(), urls };
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

async function overLimit(env: Env, deviceId: string): Promise<boolean> {
  const { success } = await env.RATE_LIMITER.limit({ key: deviceId });
  return !success;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    // The app key ships inside the APK; it keeps casual traffic out, nothing more.
    if (!env.APP_KEY || request.headers.get("x-guru-app") !== env.APP_KEY) return error(401, "unauthorized");

    const { pathname } = new URL(request.url);
    if (pathname !== "/v1/upload-links" && pathname !== "/v1/deletion-request") return error(404, "not found");
    if (request.method !== "POST") return error(405, "method not allowed");

    const body = await readJson(request);

    if (pathname === "/v1/upload-links") {
      const req = parseLinkRequest(body);
      if (!req) return error(400, "invalid request");
      if (await overLimit(env, req.device_id)) return error(429, "too many requests");
      return json(await presignPuts(env, req));
    }

    const req = parseDeletionRequest(body);
    if (!req) return error(400, "invalid request");
    if (await overLimit(env, req.device_id)) return error(429, "too many requests");
    const requestedAt = new Date().toISOString();
    await env.UPLOADS.put(
      `deletion-requests/${req.device_id}/${requestedAt}.json`,
      JSON.stringify({ device_id: req.device_id, requested_at: requestedAt }),
      { httpMetadata: { contentType: "application/json" } },
    );
    return new Response(null, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
