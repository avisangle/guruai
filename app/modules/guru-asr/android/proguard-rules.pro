# ONNX Runtime's native code finds its Java classes and methods by name (JNI FindClass/GetMethodID).
# R8 renames them in release builds, which aborts the app on the first OrtSession.run.
-keep class ai.onnxruntime.** { *; }
