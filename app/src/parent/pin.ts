// GuruAI PIN record: salted, iterated SHA-256, kept in expo-secure-store only.
import { CryptoDigestAlgorithm } from 'expo-crypto';
import type * as ExpoCrypto from 'expo-crypto';

export type PinCrypto = Pick<typeof ExpoCrypto, 'getRandomBytes' | 'digest'>;

export type PinRecord = { salt: string; rounds: number; hash: string };

const ROUNDS = 1000;
const SALT_BYTES = 16;

export const isValidPin = (pin: string) => /^\d{4}$/.test(pin);

export const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/** SHA-256(salt + pin), then SHA-256 of the result until `rounds` digests in all. */
async function hashPin(crypto: PinCrypto, pin: string, salt: Uint8Array, rounds: number) {
  const pinBytes = new TextEncoder().encode(pin);
  const first = new Uint8Array(salt.length + pinBytes.length);
  first.set(salt);
  first.set(pinBytes, salt.length);
  let h = await crypto.digest(CryptoDigestAlgorithm.SHA256, first);
  for (let i = 1; i < rounds; i++) h = await crypto.digest(CryptoDigestAlgorithm.SHA256, h);
  return toHex(new Uint8Array(h));
}

export async function createPinRecord(crypto: PinCrypto, pin: string): Promise<PinRecord> {
  const salt = crypto.getRandomBytes(SALT_BYTES);
  return { salt: toHex(salt), rounds: ROUNDS, hash: await hashPin(crypto, pin, salt, ROUNDS) };
}

export async function pinMatches(crypto: PinCrypto, pin: string, record: PinRecord) {
  return (await hashPin(crypto, pin, fromHex(record.salt), record.rounds)) === record.hash;
}
