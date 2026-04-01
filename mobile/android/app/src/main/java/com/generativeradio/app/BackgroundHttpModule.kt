package com.generativeradio.app

import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

/**
 * Native module for making HTTP requests from Android background.
 *
 * React Native's JS fetch() delivers responses via the networking module queue, which
 * Android deprioritizes in background (Doze mode) even with a foreground media service.
 * This module makes OkHttp calls on Dispatchers.IO and delivers results as RCTDeviceEventEmitter
 * events — the same delivery path expo-audio uses for playbackStatusUpdate, which is proven
 * to reach JS in Android background.
 *
 * Events emitted:
 *   "BackgroundHttp.statusResult" — response to fetchStatus()
 */
class BackgroundHttpModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext) {

    override fun getName() = "BackgroundHttp"

    // Module-scoped coroutine scope tied to the React context lifetime.
    // Using an unmanaged CoroutineScope(Dispatchers.IO) would let coroutines outlive
    // the JS context (e.g. after loading errors + app kill), causing stale events to
    // fire into a freshly launched JS context and creating ghost audio players.
    // SupervisorJob lets individual coroutines fail independently without cancelling siblings.
    private val moduleScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /**
     * GET [url] and emit the result as a "BackgroundHttp.statusResult" event.
     * [requestId] is echoed back in the event so the JS listener can match it.
     */
    @ReactMethod
    fun fetchStatus(url: String, requestId: String) {
        moduleScope.launch {
            Log.d(TAG, "fetchStatus — requestId=$requestId url=$url")
            try {
                val client = OkHttpClient.Builder()
                    .callTimeout(30, TimeUnit.SECONDS)
                    .build()
                val request = Request.Builder().url(url).get().build()
                val response = client.newCall(request).execute()
                val body = response.body?.string() ?: "{}"
                response.body?.close()
                Log.d(TAG, "fetchStatus OK — status=${response.code} requestId=$requestId")
                sendEvent(
                    "BackgroundHttp.statusResult",
                    Arguments.createMap().apply {
                        putString("requestId", requestId)
                        putString("body", body)
                        putInt("status", response.code)
                        putBoolean("ok", response.isSuccessful)
                    }
                )
            } catch (e: Exception) {
                Log.w(TAG, "fetchStatus error — requestId=$requestId: ${e.message}")
                sendEvent(
                    "BackgroundHttp.statusResult",
                    Arguments.createMap().apply {
                        putString("requestId", requestId)
                        putString("error", e.message ?: "unknown")
                        putBoolean("ok", false)
                    }
                )
            }
        }
    }

    /**
     * POST to [url] with an empty body — fire-and-forget.
     * Used for the track-ended signal; no JS callback needed.
     */
    @ReactMethod
    fun sendTrackEnded(url: String) {
        moduleScope.launch {
            Log.d(TAG, "sendTrackEnded — url=$url")
            try {
                val client = OkHttpClient.Builder()
                    .callTimeout(8, TimeUnit.SECONDS)
                    .build()
                val body = ByteArray(0).toRequestBody("application/json".toMediaType())
                val request = Request.Builder().url(url).post(body).build()
                val response = client.newCall(request).execute()
                response.body?.close()
                Log.d(TAG, "sendTrackEnded — HTTP ${response.code}")
            } catch (e: Exception) {
                Log.w(TAG, "sendTrackEnded failed: ${e.message}")
            }
        }
    }

    private fun sendEvent(name: String, params: WritableMap) {
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(name, params)
    }

    /** Called when the React Native instance is torn down (app kill, reload, etc.).
     *  Cancels all in-flight coroutines so no stale events fire into a new JS context. */
    override fun invalidate() {
        super.invalidate()
        moduleScope.cancel()
        Log.d(TAG, "invalidate — moduleScope cancelled")
    }

    override fun canOverrideExistingModule() = false

    companion object {
        private const val TAG = "BackgroundHttp"
    }
}
