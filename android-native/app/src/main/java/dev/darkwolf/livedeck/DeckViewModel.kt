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

class DeckViewModel(app: Application) : AndroidViewModel(app) {
    private val api = Api(app.getSharedPreferences("deck", Context.MODE_PRIVATE))

    var paired by mutableStateOf(api.token != null)
        private set
    var status by mutableStateOf<DeckStatus?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var refreshing by mutableStateOf(false)
        private set
    var busy by mutableStateOf(false)
        private set

    fun refresh(showSpinner: Boolean = false) = viewModelScope.launch {
        if (showSpinner) refreshing = true
        try {
            status = parseStatus(api.call("/status"))
            error = null
        } catch (e: ApiException) {
            // Clé révoquée depuis le panneau : retour au jumelage
            if (e.code == 401) unpair()
            error = e.message
        } catch (e: Exception) {
            error = "Serveur injoignable : ${e.message ?: "pas de réseau"}"
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
    }

    private fun action(path: String, body: JSONObject) = viewModelScope.launch {
        busy = true
        try {
            api.call(path, body)
            status = parseStatus(api.call("/status"))
            error = null
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

    fun markInboxSeen() {
        val ids = status?.inbox?.filter { !it.seen }?.map { it.id }.orEmpty()
        if (ids.isNotEmpty()) action("/inbox/seen", JSONObject().put("ids", JSONArray(ids)))
    }
}
