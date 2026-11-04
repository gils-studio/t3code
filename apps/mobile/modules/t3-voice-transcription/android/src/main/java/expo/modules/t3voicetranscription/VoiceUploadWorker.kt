package expo.modules.t3voicetranscription

import android.content.Context
import android.net.Uri
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val KEY_AUDIO = "audio"
private const val KEY_META = "meta"
private const val KEY_URL = "url"
private const val KEY_TOKEN = "token"
private const val CONNECT_TIMEOUT_MS = 30_000
private const val READ_TIMEOUT_MS = 120_000
private const val NEWLINE = 10

/** Scheduled by the system, so an upload continues after the app is closed or killed. */
class VoiceUploadWorker(context: Context, parameters: WorkerParameters) :
  CoroutineWorker(context, parameters) {
  override suspend fun doWork(): Result =
    withContext(Dispatchers.IO) {
      val audio = File(requireNotNull(inputData.getString(KEY_AUDIO)))
      val meta = File(requireNotNull(inputData.getString(KEY_META)))
      // The outbox removes both files once the job is finished, which also ends stale work.
      if (!audio.exists() || !meta.exists()) return@withContext Result.success()
      try {
        if (upload(audio, meta)) Result.success() else Result.retry()
      } catch (_: IOException) {
        Result.retry()
      }
    }

  /** A rejected upload retries too: the audio must stay deliverable until it is on the server. */
  private fun upload(audio: File, meta: File): Boolean {
    val metaBytes = meta.readBytes()
    val connection = URL(requireNotNull(inputData.getString(KEY_URL))).openConnection() as HttpURLConnection
    try {
      connection.requestMethod = "PUT"
      connection.doOutput = true
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.setRequestProperty("Authorization", "Bearer ${inputData.getString(KEY_TOKEN)}")
      connection.setRequestProperty("Content-Type", "application/octet-stream")
      connection.setFixedLengthStreamingMode(metaBytes.size + 1L + audio.length())
      connection.outputStream.use { output ->
        output.write(metaBytes)
        output.write(NEWLINE)
        audio.inputStream().use { it.copyTo(output) }
      }
      return connection.responseCode in 200..299
    } finally {
      connection.disconnect()
    }
  }

  companion object {
    fun enqueue(
      context: Context,
      id: String,
      audioUri: String,
      metaUri: String,
      url: String,
      token: String
    ) {
      val request =
        OneTimeWorkRequestBuilder<VoiceUploadWorker>()
          .setConstraints(
            Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
          )
          .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
          .setInputData(
            workDataOf(
              KEY_AUDIO to requireNotNull(Uri.parse(audioUri).path),
              KEY_META to requireNotNull(Uri.parse(metaUri).path),
              KEY_URL to url,
              KEY_TOKEN to token
            )
          )
          .build()
      WorkManager.getInstance(context)
        .enqueueUniqueWork("voice-upload-$id", ExistingWorkPolicy.KEEP, request)
    }
  }
}
