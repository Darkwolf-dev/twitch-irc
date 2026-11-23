package dev.darkwolf.livedeck

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * Notif « Miami en direct » : une notification permanente avec les chaînes miami en live,
 * tenue à jour par les messages « miami » du serveur. Il faut le mode Miami (côté serveur)
 * et l'option « Notif Miami en direct » (Réglages de l'appli).
 */
object MiamiLive {
    // v2 : sans pastille sur l'icône (les réglages d'un canal ne changent plus une fois créé)
    private const val CHANNEL_ID = "miami_live_v2"
    private const val NOTIFICATION_ID = 4242
    private val clock = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault())

    fun enabled(context: Context) = deckPrefs(context).getBoolean("miamiLive", true)

    /** Donne au serveur l'identifiant Firebase du téléphone, et dit s'il veut la notif Miami en direct. */
    suspend fun register(context: Context, fcmToken: String? = deckPrefs(context).getString("fcmToken", null)) {
        fcmToken ?: return
        deckPrefs(context).edit().putString("fcmToken", fcmToken).apply()
        val api = Api(deckPrefs(context))
        if (api.token == null) return
        runCatching { api.call("/app/fcm", JSONObject().put("token", fcmToken).put("miamiLive", enabled(context))) }
    }

    fun setEnabled(context: Context, on: Boolean) {
        deckPrefs(context).edit().putBoolean("miamiLive", on).apply()
        // Le serveur arrête (ou reprend) l'envoi des mises à jour à ce téléphone
        CoroutineScope(Dispatchers.IO).launch { register(context) }
        if (on) {
            // On réaffiche la dernière liste reçue, s'il y en a une
            deckPrefs(context).getString("miamiLiveLast", null)?.let { show(context, it) }
        } else cancel(context)
    }

    private fun hiddenToday(context: Context) =
        deckPrefs(context).getString("miamiLiveHiddenDay", null) == LocalDate.now().toString()

    fun cancel(context: Context) = NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)

    /** Message « miami » du serveur : liste des chaînes miami en live (JSON). */
    fun update(context: Context, channelsJson: String) {
        deckPrefs(context).edit().putString("miamiLiveLast", channelsJson).apply()
        if (!enabled(context) || hiddenToday(context)) return
        show(context, channelsJson)
    }

    private fun show(context: Context, channelsJson: String) {
        val list = runCatching { JSONArray(channelsJson) }.getOrNull() ?: return
        if (list.length() == 0) return cancel(context)

        val manager = context.getSystemService(NotificationManager::class.java)
        manager.deleteNotificationChannel("miami_live") // ancien canal, avec pastille sur l'icône
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Miami en direct", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Chaînes miami en live, mises à jour en continu"
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false) // pas de point permanent sur l'icône de l'appli
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            },
        )

        val lines = (0 until list.length()).map { i ->
            val c = list.getJSONObject(i)
            val parts = mutableListOf("${formatViewers(c.optInt("v"))} · ${since(c.optString("s"))}")
            // Dans le chat ou non : hors du chat, les drops passent sans toi
            if (c.has("chat")) parts += if (c.optBoolean("chat")) "💬" else "⚠ hors chat"
            // Fin de l'attente de 30 min après un drop : aucun drop possible avant cette heure (après, rien n'est garanti)
            c.optString("drop").takeIf { it.isNotEmpty() && it != "null" }?.let { drop ->
                runCatching { Instant.parse(drop).plusSeconds(30 * 60) }.getOrNull()
                    ?.takeIf { it.isAfter(Instant.now()) }
                    ?.let { parts += "⏱ attente → ${clock.format(it)}" }
            }
            c.optInt("b").takeIf { it > 0 }?.let { parts += "🎁 $it" }
            "${c.optString("d")}  ${parts.joinToString(" · ")}"
        }
        val title = "🌴 Miami · ${list.length()} en live"

        val open = PendingIntent.getActivity(
            context, NOTIFICATION_ID,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_VIEW, "miami"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val hide = PendingIntent.getBroadcast(
            context, NOTIFICATION_ID, Intent(context, HideMiamiLiveReceiver::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_deck)
            .setContentTitle(title)
            .setContentText(lines.joinToString("  ·  ") { it.substringBefore("  ") })
            .setStyle(NotificationCompat.BigTextStyle().bigText(lines.joinToString("\n")))
            .setContentIntent(open)
            .setOngoing(true)
            // Pas « silencieuse » : Android masque les notifs silencieuses sur l'écran de verrouillage.
            // Le canal n'a ni son ni vibration, et elle ne prévient qu'une fois.
            .setOnlyAlertOnce(true)
            .setColor(0xFFFF4FA0.toInt())
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC) // visible sur l'écran de verrouillage
            .addAction(0, "Ouvrir Miami", open)
            .addAction(0, "Masquer jusqu'à demain", hide)
            // Android 16 : notif « en direct » mise en avant, avec une pastille dans la barre d'état
            .setRequestPromotedOngoing(true)
            .setShortCriticalText("🌴 ${list.length()}")
        runCatching { NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build()) }
    }
}

/** Bouton « Masquer jusqu'à demain ». */
class HideMiamiLiveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        deckPrefs(context).edit().putString("miamiLiveHiddenDay", LocalDate.now().toString()).apply()
        MiamiLive.cancel(context)
    }
}
