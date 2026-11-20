// The single device row: created on first read; parent_lang defaults to 'mr' in the schema.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from './db';
import type { Device, Ids, JudgeCheck } from './types';

type DeviceRow = Omit<Device, 'allow_mobile_data' | 'consent_clips' | 'consent_summaries'> & {
  allow_mobile_data: number;
  consent_clips: number | null;
  consent_summaries: number | null;
};

const flag = (v: number | null) => (v === null ? null : v === 1);

function toDevice(row: DeviceRow): Device {
  return {
    ...row,
    allow_mobile_data: row.allow_mobile_data === 1,
    consent_clips: flag(row.consent_clips),
    consent_summaries: flag(row.consent_summaries),
  };
}

export function getDevice(db: Db, ids: Ids = {}): Device {
  if (!db.get('SELECT 1 FROM device')) {
    const uuid = ids.uuid ?? randomUUID;
    const at = now();
    db.run('INSERT INTO device (id, device_id, created_at, updated_at) VALUES (?, ?, ?, ?)', [
      uuid(),
      uuid(),
      at,
      at,
    ]);
  }
  return toDevice(db.get<DeviceRow>('SELECT * FROM device LIMIT 1')!);
}

export type DeviceUpdate = Partial<Pick<Device, 'parent_lang' | 'mic_last_granted_at'>>;

// Whitelist: column names are interpolated into SQL.
const DEVICE_UPDATABLE = ['parent_lang', 'mic_last_granted_at'] as const satisfies readonly (keyof DeviceUpdate)[];

/** Updates the given fields of the device row (created first if missing). */
export function updateDevice(db: Db, patch: DeviceUpdate): void {
  getDevice(db);
  const columns = DEVICE_UPDATABLE.filter((c) => patch[c] !== undefined);
  const sets = [...columns.map((c) => `${c} = ?`), 'updated_at = ?'].join(', ');
  db.run(`UPDATE device SET ${sets}`, [...columns.map((c) => patch[c] ?? null), now()]);
}

/** Stores the judge speed check (GURU-15); null clears it. */
export function setJudgeCheck(db: Db, check: JudgeCheck | null, p90Ms: number | null) {
  getDevice(db); // creates the row on first use
  db.run('UPDATE device SET judge_check = ?, judge_p90_ms = ?, updated_at = ?', [check, p90Ms, now()]);
}
