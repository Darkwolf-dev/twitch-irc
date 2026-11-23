package dev.darkwolf.livedeck

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL

const val CHANNEL_ALERTS = "alerts"
const val CHANNEL_QUIET = "quiet"
const val EXTRA_CHANNEL = "dev.darkwolf.livedeck.CHANNEL"
const val EXTRA_VIEW = "dev.darkwolf.livedeck.VIEW"

/** Démarrage de l'appli : Firebase configuré à la main (sans google-services.json dans le dépôt) et canaux de notification. */
class DeckApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.FIREBASE_APP_ID.isNotEmpty() && FirebaseApp.getApps(this).isEmpty()) {
            FirebaseApp.initializeApp(
                this,
                FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FIREBASE_APP_ID)
                    .setApiKey(BuildConfig.FIREBASE_API_KEY)
                    .setProjectId(BuildConfig.FIREBASE_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID)
                    .build(),
            )
        }
        WidgetWorker.schedule(this)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Alertes", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Débuts de live, mentions, sécurité"
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_QUIET, "Heures calmes", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Alertes reçues pendant les heures calmes, sans son"
            },
        )
    }
}

fun deckPrefs(context: Context) = context.getSharedPreferences("deck", Context.MODE_PRIVATE)

/** Réception des alertes envoyées par le serveur du panneau. */
class DeckMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        // Nouvel identifiant Firebase : le serveur doit le connaître pour nous écrire
        runBlocking { MiamiLive.register(this@DeckMessagingService, token) }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        // Mise à jour de la notif « Miami en direct » (pas une alerte)
        if (d["type"] == "miami") {
            MiamiLive.update(this, d["channels"] ?: "[]")
            runBlocking { refreshWidgets(this@DeckMessagingService) }
            return
        }
        val title = d["title"] ?: "Twitch Deck"
        val body = d["body"].orEmpty()
        val channel = d["channel"]
        val inboxId = d["inboxId"]
        val silent = d["silent"] == "true"
        val notificationId = (d["tag"] ?: inboxId ?: title).hashCode()

        val open = PendingIntent.getActivity(
            this, notificationId,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .apply { channel?.let { putExtra(EXTRA_CHANNEL, it) } },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(this, if (silent) CHANNEL_QUIET else CHANNEL_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_deck)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(open)
            .setAutoCancel(true)
            .setColor(if (d["kind"] == "live") 0xFFE91916.toInt() else 0xFF9146FF.toInt())
        d["icon"]?.let { url -> downloadBitmap(url)?.let(builder::setLargeIcon) }
        d["unseen"]?.toIntOrNull()?.let(builder::setNumber)

        if (channel != null) {
            val twitch = PendingIntent.getActivity(
                this, notificationId + 1, Intent(Intent.ACTION_VIEW, Uri.parse("https://www.twitch.tv/$channel")),
                PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, "Ouvrir sur Twitch", twitch)
        }
        if (inboxId != null) {
            val seen = PendingIntent.getBroadcast(
                this, notificationId + 2,
                Intent(this, SeenReceiver::class.java).putExtra("inboxId", inboxId).putExtra("notificationId", notificationId),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(0, "Vu", seen)
        }
        runCatching { NotificationManagerCompat.from(this).notify(notificationId, builder.build()) }
        // Une alerte (souvent un début de live) : les widgets se mettent à jour tout de suite
        runBlocking { refreshWidgets(this@DeckMessagingService) }
    }

    private fun downloadBitmap(url: String): Bitmap? = runCatching {
        // Avatars Twitch uniquement (CDN public)
        if (!url.startsWith("https://static-cdn.jtvnw.net/")) return null
        URL(url).openStream().use(BitmapFactory::decodeStream)
    }.getOrNull()
}

/** Bouton « Vu » d'une notification : l'alerte est marquée vue partout, la notification disparaît. */
class SeenReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val inboxId = intent.getStringExtra("inboxId") ?: return
        NotificationManagerCompat.from(context).cancel(intent.getIntExtra("notificationId", 0))
        val pending = goAsync()
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            runCatching { Api(deckPrefs(context)).call("/inbox/seen", JSONObject().put("ids", JSONArray().put(inboxId))) }
            pending.finish()
        }
    }
}
