// The on-device IndicConformer model file and its single loaded session (app/modules/guru-asr).
// Today the file is copied over USB (docs/android-sr-probe.md); downloading it is pending.md work.
import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

import GuruAsr from '../../modules/guru-asr';

export const THREADS = 2;
export const modelFile = () => new File(new Directory(Paths.document, 'models'), 'mr_ctc_wav.int8.onnx');
export const modelAvailable = () => Platform.OS === 'android' && GuruAsr != null && modelFile().exists;

let loading: Promise<void> | null = null;

/** Loads the model once per app run; later calls share the same promise. */
export function ensureModel(): Promise<void> {
  if (!GuruAsr) return Promise.reject(new Error('this build has no GuruAsr module'));
  loading ??= GuruAsr.load(modelFile().uri, THREADS).catch((e) => {
    loading = null; // let a later turn retry
    throw e;
  });
  return loading;
}

/** Marks the shared session as gone (the probe screen unloads and reloads it). */
export function forgetModel() {
  loading = null;
}
