// Reads a 16 kHz mono 16-bit PCM WAV (what tools/stt_bench converts clips to).
export type Pcm = { pcm: Uint8Array; samples: Float32Array };

export function parseWav(bytes: Uint8Array): Pcm {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmtOk = false;
  for (let o = 12; o + 8 <= bytes.length; ) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') {
      const format = v.getUint16(o + 8, true);
      fmtOk = format === 1 && v.getUint16(o + 10, true) === 1 && v.getUint32(o + 12, true) === 16000 && v.getUint16(o + 22, true) === 16;
    } else if (id === 'data') {
      if (!fmtOk) throw new Error('need 16 kHz mono 16-bit PCM');
      let len = Math.min(size, bytes.length - o - 8);
      len -= len % 2;
      const pcm = bytes.subarray(o + 8, o + 8 + len);
      const samples = new Float32Array(pcm.length / 2);
      for (let i = 0; i < samples.length; i++) samples[i] = v.getInt16(o + 8 + 2 * i, true) / 32768;
      return { pcm, samples };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}
