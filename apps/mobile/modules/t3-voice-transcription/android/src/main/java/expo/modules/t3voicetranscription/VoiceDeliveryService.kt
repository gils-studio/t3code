package expo.modules.t3voicetranscription

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager

private const val CHANNEL_ID = "voice-delivery"
private const val NOTIFICATION_ID = 0x7600
private const val EXTRA_TITLE = "title"
private const val EXTRA_TEXT = "text"
/** Matches the outbox's background polling; past it the app waits until it is opened again. */
private const val MAX_RUN_MS = 30 * 60_000L

internal fun voiceDeliveryNotification(context: Context, title: String, text: String): Notification {
  val manager = context.getSystemService(NotificationManager::class.java)
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Sending voice messages", NotificationManager.IMPORTANCE_LOW)
    )
  }
  val builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(context, CHANNEL_ID)
    else @Suppress("DEPRECATION") Notification.Builder(context)
  val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
  return builder
    .setSmallIcon(context.applicationInfo.icon)
    .setContentTitle(title)
    .setContentText(text)
    .setOngoing(true)
    .setOnlyAlertOnce(true)
    .apply {
      if (launch != null) {
        setContentIntent(
          PendingIntent.getActivity(context, 0, launch, PendingIntent.FLAG_IMMUTABLE)
        )
      }
    }
    .build()
}

/**
 * Keeps the app process, and with it the JS outbox, alive while a sent voice message still
 * depends on this phone, so it is delivered with the screen locked or the app put away.
 */
class VoiceDeliveryService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private val handler = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val notification =
      voiceDeliveryNotification(
        this,
        intent?.getStringExtra(EXTRA_TITLE) ?: "Sending voice message",
        intent?.getStringExtra(EXTRA_TEXT) ?: ""
      )
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    } catch (_: IllegalStateException) {
      // The app went to the background between the start and now; the next foreground retries.
      stopSelf()
      return START_NOT_STICKY
    }
    if (wakeLock == null) {
      wakeLock =
        getSystemService(PowerManager::class.java)
          .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t3code:voice-delivery")
          .apply { acquire(MAX_RUN_MS) }
      handler.postDelayed({ stopSelf() }, MAX_RUN_MS)
    }
    // A killed process takes the outbox with it; restarting only the service would help nobody.
    return START_NOT_STICKY
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  override fun onDestroy() {
    running = false
    handler.removeCallbacksAndMessages(null)
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    super.onDestroy()
  }

  companion object {
    @Volatile private var running = false

    /** False when Android refuses, say because the app is already in the background. */
    fun show(context: Context, title: String, text: String): Boolean {
      // Starting a foreground service from the background is refused; updating its notification is not.
      if (running) {
        context
          .getSystemService(NotificationManager::class.java)
          .notify(NOTIFICATION_ID, voiceDeliveryNotification(context, title, text))
        return true
      }
      val intent =
        Intent(context, VoiceDeliveryService::class.java)
          .putExtra(EXTRA_TITLE, title)
          .putExtra(EXTRA_TEXT, text)
      return try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
        else context.startService(intent)
        running = true
        true
      } catch (_: IllegalStateException) {
        false
      } catch (_: SecurityException) {
        false
      }
    }

    fun hide(context: Context) {
      if (!running) return
      running = false
      context.stopService(Intent(context, VoiceDeliveryService::class.java))
    }
  }
}
