// GURU-6: Upload Worker. Contract: Epic GURU-1, TDD section 2.8.
// External services: R2 is reached two ways. The `UPLOADS` binding (wrangler.toml)
// writes deletion requests; presigned PUT links are signed with aws4fetch against
// R2's S3 API (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto`) using
// secrets R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY and vars ACCOUNT_ID / BUCKET.
// Test values for those come from vitest.config.ts. The rate limiter is the
// wrangler `[[ratelimits]]` binding named `RATE_LIMITER`, enforced by Miniflare.
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { AwsV4Signer } from "aws4fetch";
import { describe, expect, it } from "vitest";
import worker from "../src/index";

const APP_KEY = "test-app-key";
const ORIGIN = "https://upload.test";

type Env = typeof env & Record<string, unknown>;
type FileSpec = { name: string; bytes: number; type: string };

async function call(
  path: string,
  init: { method?: string; body?: unknown; key?: string | null } = {},
  testEnv: Env = env as Env,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const key = init.key === undefined ? APP_KEY : init.key;
  if (key !== null) headers["x-guru-app"] = key;
  const body =
    init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body);
  const request = new Request(`${ORIGIN}${path}`, { method: init.method ?? "POST", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function linkBody(overrides: Record<string, unknown> = {}) {
  return {
    device_id: crypto.randomUUID(),
    child_code: "K7Q4",
    session_id: crypto.randomUUID(),
    files: [
      { name: "c-20261201-101500-003.wav", bytes: 48_000, type: "audio/wav" },
      { name: "summary.json", bytes: 1_200, type: "application/json" },
    ] as FileSpec[],
    ...overrides,
  };
}

// Object key a presigned R2 URL points at; accepts path-style and virtual-hosted style.
function objectKey(url: URL): string {
  const account = env.ACCOUNT_ID as string;
  const bucket = env.BUCKET as string;
  const path = decodeURIComponent(url.pathname);
  if (url.hostname === `${account}.r2.cloudflarestorage.com`) {
    expect(path.startsWith(`/${bucket}/`)).toBe(true);
    return path.slice(bucket.length + 2);
  }
  expect(url.hostname).toBe(`${bucket}.${account}.r2.cloudflarestorage.com`);
  return path.slice(1);
}

// Re-signs the URL as a PUT with the test credentials; equal signatures prove the
// link is a PUT (not a GET that could read data back) signed with R2_* secrets.
async function expectedPutSignature(url: URL, file: FileSpec): Promise<string> {
  const q = url.searchParams;
  const [accessKeyId, , region, service] = (q.get("X-Amz-Credential") ?? "").split("/");
  const datetime = q.get("X-Amz-Date") ?? "";
  const signedHeaders = (q.get("X-Amz-SignedHeaders") ?? "").split(";");
  const headers: Record<string, string> = {};
  for (const h of signedHeaders) {
    if (h === "content-type") headers[h] = file.type;
    else if (h === "content-length") headers[h] = String(file.bytes);
    else if (h !== "host") throw new Error(`unexpected signed header ${h}`);
  }
  const unsigned = new URL(url);
  for (const p of ["X-Amz-Signature", "X-Amz-Date", "X-Amz-Algorithm", "X-Amz-Credential", "X-Amz-SignedHeaders"]) {
    unsigned.searchParams.delete(p);
  }
  const signed = await new AwsV4Signer({
    method: "PUT",
    url: unsigned.toString(),
    headers,
    accessKeyId,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY as string,
    service,
    region,
    datetime,
    signQuery: true,
  }).sign();
  return new URL(signed.url).searchParams.get("X-Amz-Signature") ?? "";
}

describe("POST /v1/upload-links", () => {
  it("returns one 15-minute presigned R2 PUT link per file at uploads/<device>/<child>/<session>/<name>", async () => {
    const body = linkBody();
    const before = Date.now();
    const res = await call("/v1/upload-links", { body });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { expires_at: string; urls: { name: string; url: string }[] };

    const expiresAt = Date.parse(json.expires_at);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 14 * 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1_000);

    expect(json.urls.map((u) => u.name)).toEqual(body.files.map((f) => f.name));
    for (const [i, link] of json.urls.entries()) {
      const file = body.files[i];
      const url = new URL(link.url);
      expect(url.protocol).toBe("https:");
      expect(objectKey(url)).toBe(`uploads/${body.device_id}/${body.child_code}/${body.session_id}/${file.name}`);
      expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
      expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
      const [accessKeyId, , region, service] = (url.searchParams.get("X-Amz-Credential") ?? "").split("/");
      expect([accessKeyId, region, service]).toEqual([env.R2_ACCESS_KEY_ID, "auto", "s3"]);
      expect(link.url).not.toContain(env.R2_SECRET_ACCESS_KEY as string);
      expect(url.searchParams.get("X-Amz-Signature")).toBe(await expectedPutSignature(url, file));
    }
  });

  it("accepts the limits exactly: 200 files and 2,000,000 bytes each", async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      name: `c-${i}.wav`,
      bytes: 2_000_000,
      type: "audio/wav",
    }));
    const res = await call("/v1/upload-links", { body: linkBody({ files }) });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { urls: unknown[] };
    expect(json.urls).toHaveLength(200);
  });

  const wav = (o: Partial<FileSpec> = {}) => [{ name: "a.wav", bytes: 10, type: "audio/wav", ...o }];
  it.each<[string, unknown]>([
    ["device_id not a UUID", linkBody({ device_id: "not-a-uuid" })],
    ["session_id not a UUID", linkBody({ session_id: "1234" })],
    ["child_code with I", linkBody({ child_code: "K7QI" })],
    ["child_code with 0", linkBody({ child_code: "K7Q0" })],
    ["child_code lowercase", linkBody({ child_code: "k7q4" })],
    ["child_code too long", linkBody({ child_code: "K7Q4A" })],
    ["name with a path", linkBody({ files: wav({ name: "../a.wav" }) })],
    ["name uppercase", linkBody({ files: wav({ name: "A.wav" }) })],
    ["name with a disallowed extension", linkBody({ files: wav({ name: "a.mp3" }) })],
    ["type not allowed", linkBody({ files: wav({ type: "audio/mpeg" }) })],
    ["type does not match extension", linkBody({ files: wav({ type: "application/json" }) })],
    ["json name with wav type", linkBody({ files: [{ name: "s.json", bytes: 10, type: "audio/wav" }] })],
    ["file over 2,000,000 bytes", linkBody({ files: wav({ bytes: 2_000_001 }) })],
    [
      "more than 200 files",
      linkBody({ files: Array.from({ length: 201 }, (_, i) => ({ name: `c-${i}.wav`, bytes: 1, type: "audio/wav" })) }),
    ],
    ["files missing", linkBody({ files: undefined })],
    ["body not JSON", "{not json"],
  ])("rejects %s with 400 and hands out no links", async (_label, body) => {
    const res = await call("/v1/upload-links", { body });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("r2.cloudflarestorage.com");
  });
});

describe("POST /v1/deletion-request", () => {
  it("writes deletion-requests/<device_id>/<ISO timestamp>.json and returns 202", async () => {
    const deviceId = crypto.randomUUID();
    const res = await call("/v1/deletion-request", { body: { device_id: deviceId } });
    expect(res.status).toBe(202);

    const listed = await env.UPLOADS.list({ prefix: `deletion-requests/${deviceId}/` });
    expect(listed.objects).toHaveLength(1);
    const key = listed.objects[0].key;
    const stamp = key.slice(`deletion-requests/${deviceId}/`.length, -".json".length);
    expect(key).toMatch(/\.json$/);
    expect(stamp).toMatch(/^\d{4}-?\d{2}-?\d{2}T\d{2}:?\d{2}:?\d{2}(\.\d{3})?Z$/);
    const text = await (await env.UPLOADS.get(key))!.text();
    expect(() => JSON.parse(text)).not.toThrow();
  });

  it("rejects a device_id that is not a UUID with 400 and writes nothing", async () => {
    const res = await call("/v1/deletion-request", { body: { device_id: "../../uploads" } });
    expect(res.status).toBe(400);
    const listed = await env.UPLOADS.list({ prefix: "deletion-requests/../" });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("app key", () => {
  it.each([
    ["/v1/upload-links", null],
    ["/v1/upload-links", "wrong-key"],
    ["/v1/deletion-request", null],
    ["/v1/deletion-request", ""],
  ])("%s without the right x-guru-app header (%s) returns 401", async (path, key) => {
    const deviceId = crypto.randomUUID();
    const body = path === "/v1/upload-links" ? linkBody({ device_id: deviceId }) : { device_id: deviceId };
    const res = await call(path, { body, key });
    expect(res.status).toBe(401);
    const listed = await env.UPLOADS.list({ prefix: `deletion-requests/${deviceId}/` });
    expect(listed.objects).toHaveLength(0);
  });
});

describe("rate limit", () => {
  it(
    "returns 429 after 30 requests a minute from one device_id, other devices unaffected",
    async () => {
      // Miniflare windows align to the wall-clock minute; do not straddle one.
      const intoMinute = Date.now() % 60_000;
      if (intoMinute > 50_000) await new Promise((r) => setTimeout(r, 60_000 - intoMinute + 200));

      const busy = linkBody();
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        statuses.push((await call("/v1/upload-links", { body: busy })).status);
      }
      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses[30]).toBe(429);

      const other = await call("/v1/upload-links", { body: linkBody() });
      expect(other.status).toBe(200);
    },
    30_000,
  );
});

describe("bucket privacy", () => {
  it("never reads or lists the bucket and never echoes stored contents", async () => {
    const used: string[] = [];
    const spy = new Proxy(env.UPLOADS, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          used.push(String(prop));
          return value.apply(target, args);
        };
      },
    });
    const spyEnv = { ...(env as Env), UPLOADS: spy } as Env;
    const deviceId = crypto.randomUUID();

    const links = await call("/v1/upload-links", { body: linkBody({ device_id: deviceId }) }, spyEnv);
    expect(links.status).toBe(200);
    const deletion = await call("/v1/deletion-request", { body: { device_id: deviceId } }, spyEnv);
    expect(deletion.status).toBe(202);
    const stored = await env.UPLOADS.list({ prefix: `deletion-requests/${deviceId}/` });
    const storedText = await (await env.UPLOADS.get(stored.objects[0].key))!.text();
    expect(await deletion.text()).not.toContain(storedText);

    for (const path of ["/v1/upload-links", "/v1/deletion-request", "/", `/uploads/${deviceId}`]) {
      const res = await call(path, { method: "GET" }, spyEnv);
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    expect(used.filter((m) => m !== "put")).toEqual([]);

    // Absence across the whole source: no read, list or head call on the binding.
    const sources = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(0);
    for (const text of Object.values(sources) as string[]) {
      expect(text).not.toMatch(/UPLOADS\s*\.\s*(get|list|head)\b/);
    }
  });
});

describe("contract for GURU-38 (consented clip and session-summary uploads)", () => {
  it("exposes POST /v1/upload-links, POST /v1/deletion-request and a README with deploy steps", async () => {
    expect(typeof worker.fetch).toBe("function");

    const links = await call("/v1/upload-links", { body: linkBody() });
    expect(links.status).toBe(200);
    const json = (await links.json()) as Record<string, unknown>;
    expect(typeof json.expires_at).toBe("string");
    expect(Array.isArray(json.urls)).toBe(true);
    for (const u of json.urls as Record<string, unknown>[]) {
      expect(typeof u.name).toBe("string");
      expect(typeof u.url).toBe("string");
    }

    const deletion = await call("/v1/deletion-request", { body: { device_id: crypto.randomUUID() } });
    expect(deletion.status).toBe(202);

    const readme = Object.values(
      import.meta.glob("../README.md", { query: "?raw", import: "default", eager: true }),
    )[0] as string | undefined;
    expect(readme).toBeDefined();
    for (const term of [
      "wrangler deploy",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "APP_KEY",
      "EXPO_PUBLIC_UPLOAD_URL",
      "EXPO_PUBLIC_UPLOAD_KEY",
    ]) {
      expect(readme).toContain(term);
    }
  });
});
