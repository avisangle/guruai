// The single device row: created on first read; parent_lang defaults to 'mr' in the schema.
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
