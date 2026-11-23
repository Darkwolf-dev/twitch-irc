package dev.darkwolf.livedeck

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class DeckViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("deck", Context.MODE_PRIVATE)
    private val api = Api(prefs)
    // Dernière liste reçue, gardée sur le téléphone : affichée dès l'ouverture, avant la réponse du serveur
    private val cacheFile = File(app.filesDir, "status.json")

    var paired by mutableStateOf(api.token != null)
        private set
    var status by mutableStateOf<DeckStatus?>(null)
        private set
    /** Heure de la dernière réponse du serveur (0 : jamais). */
    var updatedAt by mutableStateOf(0L)
        private set
    /** Dernier rafraîchissement raté : la liste affichée est celle gardée en mémoire. */
    var offline by mutableStateOf(false)
        private set

    // Préférences de l'appli
    var dynamicColors by mutableStateOf(prefs.getBoolean("dynamicColors", false))
        private set
    var biometricLock by mutableStateOf(prefs.getBoolean("biometricLock", false))
        private set
    /** Écran verrouillé en attendant l'empreinte. */
    var locked by mutableStateOf(prefs.getBoolean("biometricLock", false))

    fun changeDynamicColors(on: Boolean) { dynamicColors = on; prefs.edit().putBoolean("dynamicColors", on).apply() }
    fun changeBiometricLock(on: Boolean) { biometricLock = on; prefs.edit().putBoolean("biometricLock", on).apply() }

    init {
        if (paired) runCatching {
            status = parseStatus(JSONObject(cacheFile.readText()))
            updatedAt = cacheFile.lastModified()
        }
    }

    private fun store(json: JSONObject) {
        status = parseStatus(json)
        updatedAt = System.currentTimeMillis()
        offline = false
        runCatching { cacheFile.writeText(json.toString()) }
    }
    var error by mutableStateOf<String?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set
    /** Radar à drops, rechargé toutes les 5 minutes au plus. */
    var drops by mutableStateOf<Map<String, DropStat>>(emptyMap())
        private set
    private var dropsAt = 0L
    /** Chaîne à ouvrir (appui sur une notification). */
    var pendingChannel by mutableStateOf<String?>(null)
    /** Vue à afficher (« miami » : appui sur la notif Miami en direct). */
    var pendingView by mutableStateOf<String?>(null)

    /** Envoie l'identifiant Firebase de ce téléphone au serveur (notifications de l'appli). */
    fun registerFcm(token: String) = viewModelScope.launch {
        if (api.token != null) runCatching { api.call("/app/fcm", JSONObject().put("token", token)) }
    }

    fun refresh(showSpinner: Boolean = false) = viewModelScope.launch {
        if (showSpinner) refreshing = true
        try {
            store(api.call("/status"))
            error = null
            if (System.currentTimeMillis() - dropsAt > 5 * 60_000) {
                dropsAt = System.currentTimeMillis()
                runCatching { drops = parseDrops(api.call("/drops")) }
            }
        } catch (e: ApiException) {
            // Clé révoquée depuis le panneau : retour au jumelage
            if (e.code == 401) unpair()
            offline = true
            error = e.message
        } catch (e: Exception) {
            offline = true
            // Avec une liste en mémoire, la bannière « hors ligne » suffit
            error = if (status == null) "Serveur injoignable : ${e.message ?: "pas de réseau"}" else null
        } finally {
            refreshing = false
        }
    }

    /** Échange le code affiché dans le panneau contre la clé de cet appareil. Renvoie un message d'erreur ou null. */
    suspend fun pair(code: String): String? = try {
        val label = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}"
        val res = api.call("/app/pair", JSONObject().put("code", code.trim()).put("label", label))
        api.token = res.getString("token")
        paired = true
        error = null
        refresh(showSpinner = true)
        null
    } catch (e: Exception) {
        e.message ?: "Jumelage impossible"
    }

    fun unpair() {
        api.token = null
        paired = false
        status = null
        cacheFile.delete()
    }

    private fun action(path: String, body: JSONObject) = viewModelScope.launch {
        busy = true
        try {
            api.call(path, body)
            store(api.call("/status"))
            error = null
            refreshWidgets(getApplication())
        } catch (e: Exception) {
            error = e.message ?: "Action impossible"
        } finally {
            busy = false
        }
    }

    private fun one(name: String) = JSONObject().put("channels", JSONArray().put(name))

    fun setMiami(on: Boolean) = action("/settings", JSONObject().put("miamiMode", on))
    fun setJoined(c: Channel, join: Boolean) = action(if (join) "/channels/join" else "/channels/part", one(c.name))
    fun setFavorite(c: Channel, favorite: Boolean) = action("/channels/favorite", one(c.name).put("favorite", favorite))
    fun setCard(c: Channel, rarity: String, owned: Boolean) = action("/channels/card", one(c.name).put("rarity", rarity).put("owned", owned))
    fun setWatched(c: Channel, watched: Boolean) = action("/channels/watched", one(c.name).put("watched", watched))

    fun setGroup(c: Channel, group: String, member: Boolean) =
        action("/channels/group", one(c.name).put("group", group).put("member", member))

    /** Messages du chat reçus après l'identifiant donné (0 : les 100 derniers). */
    suspend fun messages(name: String, after: Long): List<ChatMessage> =
        runCatching { parseMessages(api.call("/channels/$name/messages?after=$after")) }.getOrDefault(emptyList())

    suspend fun stats(name: String): ChannelStats? = runCatching { parseStats(api.call("/channels/$name/stats")) }.getOrNull()

    /** Lien de téléchargement signé (10 min) de la dernière version de l'appli. */
    suspend fun updateLink(): String? = try {
        BuildConfig.PANEL_URL + api.call("/app/download-link", JSONObject()).getString("url")
    } catch (e: Exception) {
        error = e.message
        null
    }

    fun setRoute(kind: String, route: String) {
        val routes = JSONObject()
        status?.pushRoutes?.forEach { (k, v) -> routes.put(k, v) }
        action("/settings", JSONObject().put("pushRoutes", routes.put(kind, route)))
    }

    fun setQuiet(q: QuietHours) = action(
        "/settings",
        JSONObject().put("quietHours", JSONObject().put("enabled", q.enabled).put("start", q.start).put("end", q.end).put("timeZone", q.timeZone)),
    )

    /** Notification de test vers l'appli. Renvoie le message à afficher. */
    suspend fun testNotification(): String = try {
        api.call("/app/fcm/test", JSONObject())
        refresh()
        "Notification envoyée : elle devrait arriver dans quelques secondes."
    } catch (e: Exception) {
        e.message ?: "Envoi impossible"
    }

    fun showError(message: String) { error = message }

    /** Demande au serveur de chercher tout de suite une nouvelle version sur GitHub. */
    suspend fun checkUpdate(): Pair<String, Boolean> = try {
        val latest = api.call("/app/check", JSONObject()).optJSONObject("latest")
        refresh()
        val code = latest?.optInt("versionCode") ?: 0
        if (code > BuildConfig.VERSION_CODE) "Version ${latest?.optString("versionName")} disponible : appuie sur Installer dans la bannière." to true
        else "Tu as la dernière version (${BuildConfig.VERSION_NAME})." to false
    } catch (e: Exception) {
        (e.message ?: "Vérification impossible") to false
    }

    fun markInboxSeen() {
        val ids = status?.inbox?.filter { !it.seen }?.map { it.id }.orEmpty()
        if (ids.isNotEmpty()) action("/inbox/seen", JSONObject().put("ids", JSONArray(ids)))
    }
}
