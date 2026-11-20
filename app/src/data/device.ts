// The single device row: created on first read.
import { randomUUID } from 'expo-crypto';

import { now, type Db } from './db';
import type { Device, Ids } from './types';

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
  const existing = db.get<DeviceRow>('SELECT * FROM device LIMIT 1');
  if (existing) return toDevice(existing);

  const uuid = ids.uuid ?? randomUUID;
  const at = now();
  db.run(
    "INSERT INTO device (id, device_id, parent_lang, created_at, updated_at) VALUES (?, ?, 'mr', ?, ?)",
    [uuid(), uuid(), at, at],
  );
  return toDevice(db.get<DeviceRow>('SELECT * FROM device LIMIT 1')!);
}
