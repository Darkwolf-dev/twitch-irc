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

data class Live(val title: String, val game: String, val viewers: Int, val startedAt: String?)

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
) {
    val miami get() = groups.any { it.equals("miami", ignoreCase = true) }
    val noCard get() = cards.isEmpty()
    val joined get() = state == "joined" || state == "joining"
}

data class InboxItem(val id: String, val kind: String, val title: String, val body: String, val channel: String?, val at: String, val seen: Boolean)

data class DeckStatus(
    val channels: List<Channel>,
    val miamiMode: Boolean,
    val inbox: List<InboxItem>,
    val ircConnected: Boolean,
    val joinedCount: Int,
)

private fun JSONArray?.strings(): List<String> =
    if (this == null) emptyList() else (0 until length()).map { getString(it) }

private fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key).takeIf { it.isNotEmpty() }

fun parseStatus(j: JSONObject): DeckStatus {
    val channels = j.optJSONArray("channels")?.let { arr ->
        (0 until arr.length()).map { i ->
            val c = arr.getJSONObject(i)
            val live = c.optJSONObject("live")?.let { l ->
                Live(l.optString("title"), l.optString("game"), l.optInt("viewers"), l.str("startedAt"))
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
        joinedCount = j.optJSONObject("counts")?.optInt("joined") ?: 0,
    )
}
