package dev.darkwolf.livedeck

import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiException(message: String, val code: Int = 0) : Exception(message)

/** Appels au serveur du panneau, avec la clé d'accès de cet appareil (obtenue au jumelage). */
class Api(private val prefs: SharedPreferences) {
    private val client = OkHttpClient.Builder()
        .callTimeout(20, TimeUnit.SECONDS)
        // Cloudflare Access renvoie vers sa page de connexion : on veut le voir, pas la suivre
        .followRedirects(false)
        .build()

    var token: String?
        get() = prefs.getString("token", null)
        set(value) = prefs.edit().putString("token", value).apply()

    suspend fun call(path: String, body: JSONObject? = null): JSONObject = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(BuildConfig.PANEL_URL + path)
        if (BuildConfig.CF_ACCESS_ID.isNotEmpty()) {
            builder.header("CF-Access-Client-Id", BuildConfig.CF_ACCESS_ID)
            builder.header("CF-Access-Client-Secret", BuildConfig.CF_ACCESS_SECRET)
        }
        token?.let { builder.header("Authorization", "Bearer $it") }
        if (body != null) builder.post(body.toString().toRequestBody("application/json".toMediaType()))

        client.newCall(builder.build()).execute().use { res ->
            if (res.isRedirect || res.code == 403 && res.header("cf-access-domain") != null) {
                throw ApiException("Bloqué par Cloudflare Access : le jeton de service de l'appli manque ou n'est pas autorisé", res.code)
            }
            val text = res.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrNull()
            if (!res.isSuccessful) {
                val message = json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "Erreur du serveur (HTTP ${res.code})"
                throw ApiException(message, res.code)
            }
            json ?: throw ApiException("Réponse inattendue du serveur")
        }
    }
}

// --- Données du panneau ---

data class Live(val title: String, val game: String, val viewers: Int, val startedAt: String?, val thumbnail: String?)

data class Channel(
    val name: String,
    val displayName: String,
    val live: Live?,
    val avatar: String?,
    val groups: List<String>,
    val cards: List<String>,
    val favorite: Boolean,
    val enabled: Boolean,
    val state: String,
    val watched: Boolean,
    val lastMessageAge: Int?,
    val sanction: String?,      // "ban" ou "timeout"
    val sanctionUntil: String?,
    val lastDrop: String?,      // heure du dernier drop vu sur la chaîne
    val lastLive: String?,      // fin du dernier live connu
    val boostersToday: Int,     // boosters distribués aujourd'hui sur la chaîne (somme des drops repérés)
) {
    val banned get() = sanction == "ban"
    val miami get() = groups.any { it.equals("miami", ignoreCase = true) }
    val noCard get() = cards.isEmpty()
    val todo get() = live != null && !watched && !banned
    val joined get() = state == "joined" || state == "joining"
}

data class InboxItem(val id: String, val kind: String, val title: String, val body: String, val channel: String?, val at: String, val seen: Boolean)

data class DeckStatus(
    val channels: List<Channel>,
    val miamiMode: Boolean,
    val inbox: List<InboxItem>,
    val ircConnected: Boolean,
    val ircPaused: Boolean,
    val joinedCount: Int,
    val maxConcurrent: Int,
    val groups: List<String>,
    val appVersionCode: Int?,
    val appVersionName: String?,
    /** Destination de chaque type d'alerte : live, chat, account → "discord" | "push" | "both" */
    val pushRoutes: Map<String, String>,
    val quiet: QuietHours,
    val discordSet: Boolean,
)

data class QuietHours(val enabled: Boolean, val start: String, val end: String, val timeZone: String)

/** Radar à drops : boosters vus par jour de présence dans le chat. */
data class DropStat(val boosters: Int, val presenceDays: Int, val perDay: Double?, val score: Double)

fun parseDrops(j: JSONObject): Map<String, DropStat> = j.optJSONArray("channels")?.let { arr ->
    (0 until arr.length()).associate { i ->
        val d = arr.getJSONObject(i)
        d.getString("channel") to DropStat(
            d.optInt("boosters"), d.optInt("presenceDays"),
            if (d.isNull("perDay")) null else d.optDouble("perDay"), d.optDouble("score", 0.0),
        )
    }
} ?: emptyMap()

data class ChatMessage(val id: Long, val user: String, val color: String?, val text: String, val action: Boolean, val at: Long)

data class ChannelStats(val liveHours: Double, val sessions: Int, val peak: Int?, val avg: Int?, val messagesPerMinute: Double?, val lives: List<StatSession>)
data class StatSession(val start: String, val hours: Double, val peak: Int)

fun parseMessages(j: JSONObject): List<ChatMessage> = j.optJSONArray("messages")?.let { arr ->
    (0 until arr.length()).map { i ->
        val m = arr.getJSONObject(i)
        ChatMessage(m.getLong("id"), m.optString("user"), m.str("color"), m.optString("text"), m.optBoolean("action"), m.optLong("at"))
    }
} ?: emptyList()

fun parseStats(j: JSONObject): ChannelStats {
    val s = j.optJSONObject("summary") ?: JSONObject()
    val lives = j.optJSONArray("sessions")?.let { arr ->
        (0 until arr.length()).map { i -> arr.getJSONObject(i).let { StatSession(it.optString("start"), it.optDouble("hours"), it.optInt("peak")) } }
    } ?: emptyList()
    return ChannelStats(
        liveHours = s.optDouble("liveHours", 0.0),
        sessions = s.optInt("sessions"),
        peak = if (s.isNull("peakViewers")) null else s.optInt("peakViewers"),
        avg = if (s.isNull("avgViewers")) null else s.optInt("avgViewers"),
        messagesPerMinute = if (s.isNull("messagesPerMinute")) null else s.optDouble("messagesPerMinute"),
        lives = lives.reversed(),
    )
}

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { getString(it) }

private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

fun parseStatus(j: JSONObject): DeckStatus {
    val channels = j.optJSONArray("channels")?.let { arr ->
        (0 until arr.length()).map { i ->
            val c = arr.getJSONObject(i)
            val live = c.optJSONObject("live")?.let { l ->
                Live(l.optString("title"), l.optString("game"), l.optInt("viewers"), l.str("startedAt"), l.str("thumbnail"))
            }
            Channel(
                name = c.getString("name"),
                displayName = live?.let { c.optJSONObject("live")?.str("displayName") } ?: c.getString("name"),
                live = live,
                avatar = c.str("avatar"),
                groups = c.optJSONArray("groups").strings(),
                cards = c.optJSONArray("cards").strings(),
                favorite = c.optBoolean("favorite"),
                enabled = c.optBoolean("enabled"),
                state = c.optString("state"),
                watched = c.optBoolean("watched"),
                lastMessageAge = c.optJSONObject("lastMessage")?.optInt("ageSeconds"),
                sanction = c.optJSONObject("sanction")?.str("type"),
                sanctionUntil = c.optJSONObject("sanction")?.str("until"),
                lastDrop = c.str("lastDrop"),
                lastLive = c.str("lastLive"),
                boostersToday = c.optInt("boostersToday"),
            )
        }
    } ?: emptyList()
    val inbox = j.optJSONArray("inbox")?.let { arr ->
        (0 until arr.length()).map { i ->
            val n = arr.getJSONObject(i)
            InboxItem(n.getString("id"), n.optString("kind"), n.optString("title"), n.optString("body"), n.str("channel"), n.optString("at"), n.str("seenAt") != null)
        }
    } ?: emptyList()
    return DeckStatus(
        channels = channels,
        miamiMode = j.optJSONObject("settings")?.optBoolean("miamiMode") == true,
        inbox = inbox,
        ircConnected = j.optJSONObject("irc")?.optBoolean("connected") == true,
        ircPaused = j.optJSONObject("irc")?.optBoolean("paused") == true,
        joinedCount = j.optJSONObject("counts")?.optInt("joined") ?: 0,
        maxConcurrent = j.optJSONObject("limits")?.optInt("concurrent") ?: 0,
        pushRoutes = j.optJSONObject("settings")?.optJSONObject("pushRoutes")?.let { r ->
            listOf("live", "chat", "account").associateWith { r.optString(it, "discord") }
        } ?: emptyMap(),
        quiet = j.optJSONObject("settings")?.optJSONObject("quietHours")?.let {
            QuietHours(it.optBoolean("enabled"), it.optString("start", "01:00"), it.optString("end", "09:00"), it.optString("timeZone", "Europe/Paris"))
        } ?: QuietHours(false, "01:00", "09:00", "Europe/Paris"),
        discordSet = j.optJSONObject("settings")?.optBoolean("discordWebhookSet") == true,
        appVersionCode = j.optJSONObject("app")?.optInt("versionCode"),
        appVersionName = j.optJSONObject("app")?.optString("versionName"),
        groups = j.optJSONArray("groups")?.let { arr -> (0 until arr.length()).map { arr.getJSONObject(it).getString("name") } } ?: emptyList(),
    )
}
