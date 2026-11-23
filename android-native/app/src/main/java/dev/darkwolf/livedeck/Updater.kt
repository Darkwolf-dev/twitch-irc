package dev.darkwolf.livedeck

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.widget.Toast
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Mise à jour faite par l'appli elle-même : l'APK est téléchargé dans le cache privé de l'appli
 * (rien dans Téléchargements), installé avec PackageInstaller, puis supprimé.
 */
object Updater {
    private val client = OkHttpClient.Builder().readTimeout(60, TimeUnit.SECONDS).build()

    /** L'appli a-t-elle le droit d'installer des applis ? Sinon, ouvre le réglage Android correspondant. */
    fun ensureAllowed(context: Context): Boolean {
        if (context.packageManager.canRequestPackageInstalls()) return true
        context.startActivity(
            Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
        return false
    }

    /** Télécharge puis installe. Renvoie un message d'erreur, ou null si l'installation est lancée. */
    suspend fun downloadAndInstall(context: Context, url: String, onProgress: (Int) -> Unit): String? = withContext(Dispatchers.IO) {
        val apk = File(context.cacheDir, "update.apk")
        try {
            client.newCall(Request.Builder().url(url).build()).execute().use { res ->
                if (!res.isSuccessful) return@withContext "Téléchargement refusé (HTTP ${res.code})"
                val body = res.body ?: return@withContext "Téléchargement vide"
                val total = body.contentLength().takeIf { it > 0 }
                apk.outputStream().use { out ->
                    body.byteStream().use { input ->
                        val buf = ByteArray(64 * 1024)
                        var done = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            done += n
                            if (total != null) onProgress((done * 100 / total).toInt())
                        }
                    }
                }
            }

            val installer = context.packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(context.packageName)
                // Android 12+ : pas de confirmation quand l'appli se met à jour elle-même (si le système l'accepte)
                if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
            val sessionId = installer.createSession(params)
            installer.openSession(sessionId).use { session ->
                session.openWrite("twitch-deck.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val result = PendingIntent.getBroadcast(
                    context, sessionId, Intent(context, InstallReceiver::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
                )
                session.commit(result.intentSender)
            }
            null
        } catch (e: Exception) {
            e.message ?: "Mise à jour impossible"
        } finally {
            apk.delete()
        }
    }
}

/** Résultat de l'installation : demande de confirmation à afficher, ou erreur. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                else intent.getParcelableExtra(Intent.EXTRA_INTENT)
                confirm?.let { context.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
            }
            PackageInstaller.STATUS_SUCCESS -> Unit // l'appli redémarre sur la nouvelle version
            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "raison inconnue"
                Toast.makeText(context, "Mise à jour annulée : $message", Toast.LENGTH_LONG).show()
            }
        }
    }
}
