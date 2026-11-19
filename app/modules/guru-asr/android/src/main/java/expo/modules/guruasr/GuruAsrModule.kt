package expo.modules.guruasr

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.os.Debug
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer

// Runs the IndicConformer phone model (tools/stt_bench/phone_model.py): 16 kHz mono PCM16 in,
// Marathi CTC log-probs out as little-endian float32 bytes, (frames x 257) row-major.
class GuruAsrModule : Module() {
  private val env by lazy { OrtEnvironment.getEnvironment() }
  private var session: OrtSession? = null

  override fun definition() = ModuleDefinition {
    Name("GuruAsr")

    AsyncFunction("load") { path: String, threads: Int ->
      session?.close()
      session = null
      val opts = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(threads)
        setInterOpNumThreads(1)
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      }
      session = env.createSession(path.removePrefix("file://"), opts)
      Unit
    }

    AsyncFunction("run") { pcm: ByteArray ->
      val s = session ?: throw IllegalStateException("model not loaded")
      val n = pcm.size / 2
      val shorts = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val wav = FloatBuffer.allocate(n)
      for (i in 0 until n) wav.put(i, shorts.get(i) / 32768f)
      OnnxTensor.createTensor(env, wav, longArrayOf(1, n.toLong())).use { input ->
        s.run(mapOf("wav" to input)).use { result ->
          val logp = (result.get(0) as OnnxTensor).floatBuffer
          val out = ByteBuffer.allocate(logp.remaining() * 4).order(ByteOrder.LITTLE_ENDIAN)
          out.asFloatBuffer().put(logp)
          out.array()
        }
      }
    }

    AsyncFunction("unload") {
      session?.close()
      session = null
      Unit
    }

    // Process memory in kB: total PSS and native heap (the model lives in native memory).
    Function("memory") {
      val info = Debug.MemoryInfo()
      Debug.getMemoryInfo(info)
      mapOf("pssKb" to info.totalPss, "nativeHeapKb" to Debug.getNativeHeapAllocatedSize() / 1024)
    }
  }
}
