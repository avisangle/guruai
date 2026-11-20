# Upload Worker

A Cloudflare Worker that hands the app short-lived links to upload consented clips and session summaries into a private R2 bucket, and records deletion requests. It never reads or lists the bucket. Why it works this way: [D-GURU-6-upload-auth](../../docs/decisions/D-GURU-6-upload-auth.md). Contract: TDD section 2.8 in the Epic GURU-1.

## Endpoints

Every request needs the header `x-guru-app: <APP_KEY>`, otherwise 401. Each `device_id` may make 30 requests a minute; more return 429.

### `POST /v1/upload-links`

```json
{ "device_id": "<uuid>", "child_code": "K7Q4", "session_id": "<uuid>",
  "files": [ { "name": "c-20261201-101500-003.wav", "bytes": 48000, "type": "audio/wav" },
             { "name": "summary.json", "bytes": 1200, "type": "application/json" } ] }
```

Returns `{ "expires_at": "<ISO time>", "urls": [ { "name": "...", "url": "..." } ] }`, one presigned PUT per file, valid 15 minutes, for the key `uploads/<device_id>/<child_code>/<session_id>/<name>`. The app uploads each file with `PUT <url>` and the file as the body.

400 unless: both ids are UUIDs; `child_code` matches `^[A-HJ-NP-Z2-9]{4}$`; each `name` matches `^[a-z0-9-]+\.(wav|json)$`; `type` is `audio/wav` for `.wav` and `application/json` for `.json`; at most 200 files; each `bytes` at most 2,000,000.

The link signs only the method, key and expiry. `bytes` and `type` are checked when the link is handed out, not by R2 when the file arrives.

### `POST /v1/deletion-request`

`{ "device_id": "<uuid>" }` writes `deletion-requests/<device_id>/<ISO time>.json` and returns 202 with no body. The admin finds them in the bucket under `deletion-requests/` and deletes `uploads/<device_id>/`.

## Deploy

From `workers/upload/`, with Node 20+:

```sh
npx npm@11 ci
npx wrangler login
```

1. Create the private bucket (no public access, no custom domain):

   ```sh
   npx wrangler r2 bucket create guru-uploads
   ```

2. In the Cloudflare dashboard, R2, "Manage API tokens", create an API token with **Object Read & Write** on `guru-uploads` only. Note the access key id and secret access key.

3. Set `ACCOUNT_ID` in `wrangler.toml` `[vars]` to the Cloudflare account id. `BUCKET` and `bucket_name` must both name the bucket from step 1. The rate limiter's `namespace_id` is any integer string unused by another rate limiter in the account.

4. Set the secrets. `APP_KEY` is any long random string, for example `openssl rand -hex 32`:

   ```sh
   npx wrangler secret put APP_KEY
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   ```

5. Deploy, and note the `workers.dev` (or custom) URL it prints:

   ```sh
   npx wrangler deploy
   ```

6. Give the app the Worker's URL and key when building it:

   ```sh
   EXPO_PUBLIC_UPLOAD_URL=https://guru-upload.<subdomain>.workers.dev
   EXPO_PUBLIC_UPLOAD_KEY=<APP_KEY>
   ```

Rotating `APP_KEY` locks out installed apps until they ship the new key.

## Test

```sh
npm test            # Vitest inside the Workers runtime (Miniflare); nothing leaves the machine
npm run typecheck
```

Install with npm 11 (`npx npm@11 install`); npm 10 fails resolving the Vitest 4 peers.
