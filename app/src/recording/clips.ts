// Answer clip records and the export zip, as specified in docs/clip-export.md.
// Pure: no React, no device APIs.
import { strToU8, zipSync, type Zippable } from 'fflate';

import type { ClipJudge } from '../asr/lessonJudge';
import { matchedOf } from '../lesson/engine';
import type { Answer, Heard, Item, Lang, ListenKind } from '../lesson/types';

// One manifest entry. Key order follows docs/clip-export.md.
export type ClipMeta = {
  id: string;
  file: string; // clips/<id>.<ext>
  child: string;
  age: number | null;
  template_id: string;
  item_id: string;
  item_key: string;
  display: string;
  expected: string[];
  accepted_variants: string[];
  kind: ListenKind;
  label: Answer;
  label_by?: 'judge'; // absent: the tester's tap (clips before the judge drove lessons)
  matched_text?: string; // the answer text the judge matched; absent for other and nothing
  matched_lang?: Lang; // its language, when it is the asked item's answer
  recorded_at: string;
  duration_ms: number;
  judge?: ClipJudge; // the on-device judge's verdict on this clip
};

export type Manifest = { format: 1; exported_at: string; app_version: string; clips: ClipMeta[] };

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

// 2026-11-15T10:42:01Z (UTC, whole seconds)
export const isoSeconds = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

// 20261115-104201 (UTC)
export const compactStamp = (date: Date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-` +
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;

// c-20261115-104201-001; seq counts clips started within the same second
export const clipId = (stamp: string, seq: number) => `c-${stamp}-${pad(seq, 3)}`;

export const exportFileName = (date: Date) => `guruai-clips-${compactStamp(date)}.zip`;

// Tester-typed child code: 1-2 letters then 1-3 digits (C1, C12, AB3). Never a name.
export const sanitizeChildCode = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
export const isChildCode = (code: string) => /^[A-Z]{1,2}\d{1,3}$/.test(code);

// Optional age in years; anything else is null.
export function parseAge(text: string): number | null {
  const n = Number.parseInt(text, 10);
  return Number.isInteger(n) && n >= 1 && n <= 15 ? n : null;
}

export function clipMeta(args: {
  id: string;
  ext: string; // without the dot
  child: string;
  age: number | null;
  templateId: string;
  item: Item;
  kind: ListenKind;
  label: Answer;
  labelBy?: 'judge';
  matched?: Heard; // the judge's Heard
  recordedAt: Date;
  durationMs: number;
}): ClipMeta {
  const { item } = args;
  return {
    id: args.id,
    file: `clips/${args.id}.${args.ext}`,
    child: args.child,
    age: args.age,
    template_id: args.templateId,
    item_id: item.id,
    item_key: item.item_key,
    display: item.display,
    expected: [...item.assessment.expected],
    accepted_variants: [...item.assessment.accepted_variants],
    kind: args.kind,
    label: args.label,
    ...(args.labelBy ? { label_by: args.labelBy } : {}),
    ...(args.matched ? matchedOf(args.matched) : {}),
    recorded_at: isoSeconds(args.recordedAt),
    duration_ms: Math.max(0, Math.round(args.durationMs)),
  };
}

export const buildManifest = (clips: ClipMeta[], exportedAt: Date, appVersion: string): Manifest =>
  ({ format: 1, exported_at: isoSeconds(exportedAt), app_version: appVersion, clips });

// manifest.json + clips/. Audio is stored without zip compression (fast on the phone).
export function zipClips(manifest: Manifest, audio: Record<string, Uint8Array>): Uint8Array {
  const files: Zippable = { 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) };
  for (const clip of manifest.clips) files[clip.file] = [audio[clip.file], { level: 0 }];
  return zipSync(files);
}
