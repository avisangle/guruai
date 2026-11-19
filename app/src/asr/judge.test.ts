// The TypeScript judge must match the Python bench judge (golden data from tools/stt_bench/phone_golden.py).
import golden from './__fixtures__/golden.json';
import { ctcLogLikelihood, ctcRepeatLogLikelihoods, decode, greedy, type LogProbs } from './ctc';
import { decide, type Candidate } from './judge';
import { normalise } from './normalise';
import { parseWav } from './wav';

const sine = (level: number) => Float32Array.from({ length: 16000 }, (_, i) => level * Math.sin((2 * Math.PI * 220 * i) / 16000));

describe('port of the Python judge', () => {
  it.each(golden.normalise)('normalise($in)', ({ in: input, out }) => {
    expect(normalise(input)).toBe(out);
  });

  it.each(golden.decode)('decodes $ids like sentencepiece', ({ ids, text }) => {
    expect(decode(ids, golden.pieces)).toBe(text);
  });

  describe.each(golden.cases)('$label', (c) => {
    const lp: LogProbs = { data: Float32Array.from(c.logp), frames: c.frames, vocab: 257 };
    const cands = golden.candidates as Candidate[];

    it('scores every candidate like torch ctc_loss', () => {
      const { scores } = decide(lp, sine(c.level), cands, golden.pieces);
      for (const [text, score] of Object.entries(c.scores)) expect(scores[text]).toBeCloseTo(score, 2);
    });

    it('makes the same choice and free decode', () => {
      const j = decide(lp, sine(c.level), cands, golden.pieces);
      expect(j.choice).toBe(c.choice);
      expect(j.unsure).toBe(c.unsure);
      if (c.choice !== 'nothing') expect(j.free).toBe(c.free);
    });
  });

  it('scores an answer said 1, 2 and 3 times in one pass, as three separate passes', () => {
    const c = golden.cases[0];
    const lp: LogProbs = { data: Float32Array.from(c.logp), frames: c.frames, vocab: 257 };
    for (const ids of [[5], [5, 5], [5, 9, 12]]) {
      const one = ctcRepeatLogLikelihoods(lp, ids, 3);
      [1, 2, 3].forEach((k, i) => expect(one[i]).toBeCloseTo(ctcLogLikelihood(lp, Array(k).fill(ids).flat()), 6));
    }
  });

  it('greedy collapses repeats and drops blanks', () => {
    const frames = [5, 5, 256, 5, 7, 7, 256];
    const data = new Float32Array(frames.length * 257).fill(-10);
    frames.forEach((k, t) => (data[t * 257 + k] = 0));
    expect(greedy({ data, frames: frames.length, vocab: 257 })).toEqual([5, 5, 7]);
  });
});

describe('parseWav', () => {
  const wav = (rate: number, samples: number[]) => {
    const b = new DataView(new ArrayBuffer(44 + samples.length * 2));
    const put = (o: number, s: string) => [...s].forEach((ch, i) => b.setUint8(o + i, ch.charCodeAt(0)));
    put(0, 'RIFF'); b.setUint32(4, 36 + samples.length * 2, true); put(8, 'WAVE');
    put(12, 'fmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
    b.setUint32(24, rate, true); b.setUint32(28, rate * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
    put(36, 'data'); b.setUint32(40, samples.length * 2, true);
    samples.forEach((s, i) => b.setInt16(44 + i * 2, s, true));
    return new Uint8Array(b.buffer);
  };

  it('reads 16 kHz mono PCM16', () => {
    const { pcm, samples } = parseWav(wav(16000, [0, 16384, -32768]));
    expect(pcm.length).toBe(6);
    expect(Array.from(samples)).toEqual([0, 0.5, -1]);
  });

  it('rejects other formats', () => {
    expect(() => parseWav(wav(44100, [0]))).toThrow('16 kHz');
  });
});
