// Tester-only run of the on-device IndicConformer judge over the probe clips (docs/android-sr-probe.md).
// Model: <documents>/models/mr_ctc_wav.int8.onnx (tools/stt_bench/phone_model.py, pushed over USB).
// Results: <documents>/probe/results-ic.json, scored on the Mac by the indicconformer_phone bench provider.
import { File } from 'expo-file-system';

import GuruAsrModule from '../../modules/guru-asr';
import { forgetModel, modelFile } from '../asr/model';
import type { LogProbs } from '../asr/ctc';
import { decide, isSilent, type Candidate } from '../asr/judge';
import { parseWav } from '../asr/wav';
import { probeDir } from './androidProbe';

export { modelFile };
const resultsFile = () => new File(probeDir(), 'results-ic.json');
const VOCAB = 257;

function asr() {
  if (!GuruAsrModule) throw new Error('this build has no GuruAsr module');
  return GuruAsrModule;
}

export type IcClip = {
  choice: string;
  free: string;
  note: string;
  scores: Record<string, number>;
  frames: number;
  ms: { read: number; model: number; judge: number };
  error?: string;
};
export type Memory = { pssKb: number; nativeHeapKb: number };
export type IcResults = {
  format: 1;
  model: { bytes: number; threads: number; loadMs: number };
  memory: { beforeLoad: Memory; afterLoad: Memory; peakPssKb: number };
  clips: Record<string, IcClip>;
};

export async function loadModel(threads: number): Promise<Pick<IcResults, 'model' | 'memory'>> {
  const f = modelFile();
  if (!f.exists) throw new Error(`no model at ${f.uri}`);
  const GuruAsr = asr();
  await GuruAsr.unload();
  forgetModel(); // the lesson judge reloads with its own settings
  const beforeLoad = GuruAsr.memory();
  const t0 = Date.now();
  await GuruAsr.load(f.uri, threads);
  const loadMs = Date.now() - t0;
  const afterLoad = GuruAsr.memory();
  return { model: { bytes: f.size ?? 0, threads, loadMs }, memory: { beforeLoad, afterLoad, peakPssKb: afterLoad.pssKb } };
}

export function loadIcResults(head: Pick<IcResults, 'model' | 'memory'>, resume: boolean): IcResults {
  const f = resultsFile();
  const old = resume && f.exists ? (JSON.parse(f.textSync()) as IcResults) : null;
  return { format: 1, ...head, clips: old?.clips ?? {} };
}

export const saveIcResults = (r: IcResults) => resultsFile().writeSync(JSON.stringify(r));

export async function judgeClip(file: string, candidates: Candidate[], pieces: string[]): Promise<IcClip> {
  const t0 = Date.now();
  const { pcm, samples } = parseWav(new Uint8Array(await new File(probeDir(), file).arrayBuffer()));
  const t1 = Date.now();
  if (isSilent(samples)) {
    const j = decide({ data: new Float32Array(0), frames: 0, vocab: VOCAB }, samples, candidates, pieces);
    return { ...j, frames: 0, ms: { read: t1 - t0, model: 0, judge: Date.now() - t1 } };
  }
  const out = await asr().run(pcm);
  const t2 = Date.now();
  const data = new Float32Array(out.slice().buffer); // copy: the view may not be 4-byte aligned
  const lp: LogProbs = { data, frames: data.length / VOCAB, vocab: VOCAB };
  const j = decide(lp, samples, candidates, pieces);
  return { ...j, frames: lp.frames, ms: { read: t1 - t0, model: t2 - t1, judge: Date.now() - t2 } };
}
