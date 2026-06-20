package expo.modules.backgroundhttp

import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Local Expo module — performs HTTP from Android background.
 *
 * React Native's JS fetch() is deprioritized by Android in Doze even with a
 * foreground media service. This issues the call on a background Executor and
 * delivers the result as an Expo module event ("onStatusResult") — the same
 * event path expo-audio's playbackStatusUpdate uses, which reliably reaches JS
 * in background.
 *
 * It lives under modules/ (autolinked by Expo) instead of android/, so
 * `expo prebuild --clean` cannot delete it. Android-only: on iOS the native
 * module is absent and the JS wrapper (src/modules/backgroundHttp.ts) no-ops.
 *
 * Events:
 *   "onStatusResult" — { requestId, body, status, ok } or { requestId, error, ok:false }
 */
class BackgroundHttpModule : Module() {
  // Recreated per module instance. shutdownNow() on teardown cancels in-flight
  // requests so a stale response can't fire an event into a freshly-launched JS
  // context (which previously spawned ghost audio players).
  private var executor: ExecutorService = Executors.newCachedThreadPool()

  override fun definition() = ModuleDefinition {
    Name("BackgroundHttp")

    Events("onStatusResult")

    // GET [url]; [requestId] is echoed back so the JS listener can match it.
    Function("fetchStatus") { url: String, requestId: String ->
      executor.execute {
        try {
          val (code, body, ok) = httpGet(url)
          this@BackgroundHttpModule.sendEvent(
            "onStatusResult",
            mapOf("requestId" to requestId, "body" to body, "status" to code, "ok" to ok),
          )
        } catch (e: Exception) {
          Log.w(TAG, "fetchStatus error — requestId=$requestId: ${e.message}")
          this@BackgroundHttpModule.sendEvent(
            "onStatusResult",
            mapOf("requestId" to requestId, "error" to (e.message ?: "unknown"), "ok" to false),
          )
        }
      }
    }

    // Fire-and-forget POST with an empty body (track-ended signal). No callback.
    Function("sendTrackEnded") { url: String ->
      executor.execute {
        try {
          httpPostEmpty(url)
        } catch (e: Exception) {
          Log.w(TAG, "sendTrackEnded failed: ${e.message}")
        }
      }
    }

    OnDestroy {
      executor.shutdownNow()
      Log.d(TAG, "OnDestroy — executor shut down")
    }
  }

  private fun httpGet(urlStr: String): Triple<Int, String, Boolean> {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
      requestMethod = "GET"
      connectTimeout = 30_000
      readTimeout = 30_000
    }
    try {
      val code = conn.responseCode
      val ok = code in 200..299
      val stream = if (ok) conn.inputStream else (conn.errorStream ?: conn.inputStream)
      val body = stream?.bufferedReader()?.use { it.readText() } ?: "{}"
      return Triple(code, body, ok)
    } finally {
      conn.disconnect()
    }
  }

  private fun httpPostEmpty(urlStr: String) {
    val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
      requestMethod = "POST"
      connectTimeout = 8_000
      readTimeout = 8_000
      doOutput = true
      setRequestProperty("Content-Type", "application/json")
    }
    try {
      conn.outputStream.use { it.write(ByteArray(0)) }
      conn.responseCode // force the request to be sent
    } finally {
      conn.disconnect()
    }
  }

  companion object {
    private const val TAG = "BackgroundHttp"
  }
}
