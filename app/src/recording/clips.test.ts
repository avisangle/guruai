import { strFromU8, unzipSync } from 'fflate';

import lessonsJson from '../content/generated/lessons.json';
import type { Lesson } from '../lesson/types';
import {
  buildManifest,
  clipId,
  clipMeta,
  compactStamp,
  exportFileName,
  isChildCode,
  isoSeconds,
  parseAge,
  sanitizeChildCode,
  zipClips,
} from './clips';

const lessonJson = lessonsJson[0]; // स्वर १ (अ to ऊ): the cases below are written against it

const lesson = lessonJson as unknown as Lesson;
const itemA = lesson.items.find((i) => i.id === 'a')!;
const at = new Date('2026-11-15T10:42:01.456Z');

const metaA = clipMeta({
  id: clipId(compactStamp(at), 1),
  ext: 'm4a',
  child: 'C1',
  age: 5,
  templateId: lesson.template_id,
  item: itemA,
  kind: 'teach',
  label: 'correct',
  recordedAt: at,
  durationMs: 2380.4,
});

describe('names and stamps', () => {
  test('use UTC and whole seconds', () => {
    expect(isoSeconds(at)).toBe('2026-11-15T10:42:01Z');
    expect(compactStamp(at)).toBe('20261115-104201');
    expect(clipId('20261115-104201', 1)).toBe('c-20261115-104201-001');
    expect(clipId('20261115-104201', 12)).toBe('c-20261115-104201-012');
    expect(exportFileName(new Date('2026-01-02T03:04:05Z'))).toBe('guruai-clips-20260102-030405.zip');
  });

  test('child codes are short codes, never names', () => {
    expect(sanitizeChildCode(' c1 ')).toBe('C1');
    expect(sanitizeChildCode('ab-12')).toBe('AB12');
    expect(isChildCode('C1')).toBe(true);
    expect(isChildCode('AB123')).toBe(true);
    expect(isChildCode('RAHUL')).toBe(false);
    expect(isChildCode('C')).toBe(false);
    expect(isChildCode('')).toBe(false);
  });

  test('age is optional', () => {
    expect(parseAge('5')).toBe(5);
    expect(parseAge('')).toBeNull();
    expect(parseAge('0')).toBeNull();
    expect(parseAge('40')).toBeNull();
  });
});

describe('manifest', () => {
  test('clip entry matches docs/clip-export.md field for field', () => {
    expect(Object.keys(metaA)).toEqual([
      'id', 'file', 'child', 'age', 'template_id', 'item_id', 'item_key', 'display', 'expected',
      'accepted_variants', 'kind', 'label', 'recorded_at', 'duration_ms',
    ]);
    expect(metaA).toEqual({
      id: 'c-20261115-104201-001',
      file: 'clips/c-20261115-104201-001.m4a',
      child: 'C1',
      age: 5,
      template_id: 'tpl_kg_mr_swar_1',
      item_id: 'a',
      item_key: 'mr:letter:अ',
      display: 'अ',
      expected: ['अ'],
      accepted_variants: ['अ अननसाचा', 'अननस'],
      kind: 'teach',
      label: 'correct',
      recorded_at: '2026-11-15T10:42:01Z',
      duration_ms: 2380,
    });
  });

  test('copies the item lists rather than sharing them', () => {
    expect(metaA.expected).not.toBe(itemA.assessment.expected);
  });

  test('top level has format 1, export time and app version', () => {
    const m = buildManifest([metaA], new Date('2026-11-15T10:42:00.900Z'), '1.0.0');
    expect(Object.keys(m)).toEqual(['format', 'exported_at', 'app_version', 'clips']);
    expect(m).toMatchObject({ format: 1, exported_at: '2026-11-15T10:42:00Z', app_version: '1.0.0', clips: [metaA] });
  });
});

describe('zip', () => {
  test('holds manifest.json and clips/<id>.<ext> with the audio bytes untouched', () => {
    const audio = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 1, 2, 3, 250]);
    const manifest = buildManifest([metaA], at, '1.0.0');
    const files = unzipSync(zipClips(manifest, { [metaA.file]: audio }));
    expect(Object.keys(files).sort()).toEqual(['clips/c-20261115-104201-001.m4a', 'manifest.json']);
    expect(JSON.parse(strFromU8(files['manifest.json']))).toEqual(manifest);
    expect(Array.from(files[metaA.file])).toEqual(Array.from(audio));
  });

  test('an empty export is still a valid zip with a manifest', () => {
    const files = unzipSync(zipClips(buildManifest([], at, '1.0.0'), {}));
    expect(JSON.parse(strFromU8(files['manifest.json'])).clips).toEqual([]);
  });
});
