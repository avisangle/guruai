import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class GuruAsrModule extends NativeModule<{}> {
  /** Loads the ONNX model at a file path or file:// URI. */
  load(path: string, threads: number): Promise<void>;
  /** 16 kHz mono PCM16 (little-endian) -> CTC log-probs as little-endian float32 bytes, frames x 257. */
  run(pcm: Uint8Array): Promise<Uint8Array>;
  unload(): Promise<void>;
  memory(): { pssKb: number; nativeHeapKb: number };
}

// null where the native code is absent (Expo Go, an older build): the app then runs without the judge.
export default requireOptionalNativeModule<GuruAsrModule>('GuruAsr');
