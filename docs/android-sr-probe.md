# On-device speech probe

A tester-only screen in the development build (`guruai://probe`) that runs speech judges on the phone, offline, over clips we already have, so their choices can be scored by `tools/stt_bench/` like every other provider:

- **IndicConformer (ours):** the closed-set judge `indicconformer_closed` as the app will run it: `mr_ctc_wav.int8.onnx` through `app/modules/guru-asr`, decision code in `app/src/asr` (D-STT-on-device-runtime).
- **Android's recognizer** (`mr-IN`): no offline Marathi on the phones checked so far (docs/stt-options.md); kept to recheck.

## Privacy

- Both judges run on the phone. The app only ever starts Android's **on-device** recognizer (`requiresOnDeviceRecognition: true`, i.e. `SpeechRecognizer.createOnDeviceSpeechRecognizer`), so audio is never sent to Google; without an offline model it fails instead of falling back to the cloud. The `download mr-IN offline` button downloads Google's model only.
- Clips and the model go from the Mac to the app's private files over USB (`adb exec-in` + `run-as`); they never sit in shared phone storage. Uninstalling the app deletes them.
- The EAS cloud build uploads the `app/` folder minus `app/.easignore` (no clips, exports, docs or keys). Clips and the model are never part of a build.

## Build and install

The probe needs native code, so it runs in a development build of the app, not Expo Go. Rebuild after any native change (a new native package, or `app/modules/`):

```bash
cd app
npx eas-cli@latest login          # once; in this terminal use: login --device --non-interactive
EAS_NO_VCS=1 npx eas-cli@latest build --platform android --profile development
```

`EAS_NO_VCS=1` is needed because the project is not a git repo. Install the APK from the build link, or download it and `adb install -r <apk>` (keeps the app's files). Package: `com.guruai.app`.

For recording sessions use the `preview` profile instead (`--profile preview`): a release build with the JavaScript inside, much faster (the debug build keeps the main thread at 100% CPU) and no Mac needed. Installing one over the other with `adb install -r` keeps the app's files (same signing key). A release build is not debuggable, so `android_probe.py` (run-as) needs the development build installed.

To skip the EAS free-plan queue, build on the Mac with the same EAS signing key: add `--local --output <file>.apk` to the build command, with `JAVA_HOME` set to JDK 17 (`brew install openjdk@17`) and `ANDROID_HOME` set to the Android SDK. Needs about 10 GB free disk; the first run downloads Gradle and an NDK.

A development build loads its JavaScript from the Mac: `npx expo start` in `app/`, then `adb reverse tcp:8081 tcp:8081` and `adb shell am start -a android.intent.action.VIEW -d "guruai://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`. JavaScript changes then need no rebuild.

## Run

Phone connected by USB with USB debugging on. From the project root, venv active:

```bash
python tools/stt_bench/android_probe.py push <export.zip|folder>...  # 16 kHz WAV + each clip's lesson candidates (token ids)
python tools/stt_bench/phone_model.py                                  # once: builds ~/.cache/indicconformer/onnx/mr_ctc_wav.int8.onnx
python tools/stt_bench/android_probe.py push-model                     # copies it into the app (files/models/)
adb shell am start -a android.intent.action.VIEW -d "guruai://probe?run=ic&threads=2"   # starts the IndicConformer run
```

Or open the probe screen and tap **run IndicConformer** / **run recognizer**. Results are saved after every clip, and a later run resumes where the last stopped (`fresh=1` in the link starts over). The screen stays awake during a run. The recognizer runs each clip twice: `plain` and `biased` (the clip's lesson answers as `contextualStrings`).

Then:

```bash
python tools/stt_bench/android_probe.py pull     # -> tools/stt_bench/results/android-probe[-ic]-<time>.json; prints the bench command
ANDROID_IC_RESULTS=<ic file> python tools/stt_bench/bench.py <export> --providers indicconformer_phone,indicconformer_closed
python tools/stt_bench/phone_model.py <export>... --phone <ic file>   # phone vs Mac on the same ONNX model: should agree
```

`push` refuses to replace results that were not pulled yet (`--force` discards them). The IndicConformer results also hold load time, threads and memory (PSS before and after loading the model, and the peak during the run).

## Limits

- IndicConformer: the judge constants are the bench ones (D-STT-other-margin for the "other" margin; the rest in pending.md). The probe reads WAV files pushed by USB; in lessons the judge scores the recorded clip (docs/clip-export.md).
- Android's recognizer: file input needs Android 13+; `contextualStrings` is only a hint; it is open dictation trained mostly on adults.
