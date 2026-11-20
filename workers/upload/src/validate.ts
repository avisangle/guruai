export type FileSpec = { name: string; bytes: number; type: string };
export type LinkRequest = { device_id: string; child_code: string; session_id: string; files: FileSpec[] };

export const MAX_FILES = 200;
export const MAX_BYTES = 2_000_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Child codes skip I, O, 0 and 1, which read alike.
const CHILD_CODE = /^[A-HJ-NP-Z2-9]{4}$/;
const FILE_NAME = /^[a-z0-9-]+\.(wav|json)$/;
const TYPE_FOR_EXT: Record<string, string> = { wav: "audio/wav", json: "application/json" };

type Body = Record<string, unknown>;

const isObject = (v: unknown): v is Body => typeof v === "object" && v !== null && !Array.isArray(v);

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

function isFile(v: unknown): v is FileSpec {
  if (!isObject(v) || typeof v.name !== "string" || typeof v.type !== "string") return false;
  const ext = FILE_NAME.exec(v.name)?.[1];
  return (
    ext !== undefined &&
    TYPE_FOR_EXT[ext] === v.type &&
    Number.isInteger(v.bytes) &&
    (v.bytes as number) >= 0 &&
    (v.bytes as number) <= MAX_BYTES
  );
}

export function parseLinkRequest(body: unknown): LinkRequest | null {
  if (!isObject(body)) return null;
  const { device_id, child_code, session_id, files } = body;
  if (!isUuid(device_id) || !isUuid(session_id)) return null;
  if (typeof child_code !== "string" || !CHILD_CODE.test(child_code)) return null;
  if (!Array.isArray(files) || files.length > MAX_FILES || !files.every(isFile)) return null;
  return { device_id, child_code, session_id, files };
}

export function parseDeletionRequest(body: unknown): { device_id: string } | null {
  return isObject(body) && isUuid(body.device_id) ? { device_id: body.device_id } : null;
}
