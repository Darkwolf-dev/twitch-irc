package dev.darkwolf.livedeck

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapShader
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Paint
import android.graphics.Shader
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.Switch
import androidx.glance.appwidget.SwitchDefaults
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.ToggleableStateKey
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.work.CoroutineWorker
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.URL
import java.util.concurrent.TimeUnit

// --- Données du widget : les chaînes du groupe miami ---

/** updatedAt : heure (ms) de l'état affiché ; stale : serveur injoignable, c'est le dernier état gardé en cache. */
private data class MiamiData(
    val channels: List<Channel>, val miamiMode: Boolean, val error: String?,
    val updatedAt: Long? = null, val stale: Boolean = false,
)

// Dernier /status reçu : téléphone verrouillé, Android coupe le réseau (mode veille) et les
// rafraîchissements de fond échouent ; on garde alors la dernière liste au lieu d'afficher l'erreur.
private const val CACHE_PREF = "widgetStatus"
private const val CACHE_TIME_PREF = "widgetStatusTime"

/** Verrou du grand widget : interrupteurs et palmier figés pour éviter les fausses manips. */
private const val LOCK_PREF = "widgetLocked"
private fun widgetLocked(context: Context) = deckPrefs(context).getBoolean(LOCK_PREF, false)

private suspend fun loadMiami(context: Context): MiamiData {
    val api = Api(deckPrefs(context))
    if (api.token == null) return MiamiData(emptyList(), false, "Ouvre l'appli pour la jumeler")
    val prefs = deckPrefs(context)
    var updatedAt = System.currentTimeMillis()
    var stale = false
    return try {
        val json = try {
            api.call("/status").also { prefs.edit().putString(CACHE_PREF, it.toString()).putLong(CACHE_TIME_PREF, updatedAt).apply() }
        } catch (e: Exception) {
            WidgetWorker.retryWhenOnline(context)
            val cached = prefs.getString(CACHE_PREF, null) ?: throw e
            updatedAt = prefs.getLong(CACHE_TIME_PREF, 0)
            stale = true
            JSONObject(cached)
        }
        val status = parseStatus(json)
        val miami = status.channels.filter { it.miami }
            .sortedWith(compareByDescending<Channel> { it.live != null }.thenByDescending { it.live?.viewers ?: -1 }.thenBy { it.name })
        MiamiData(miami, status.miamiMode, if (miami.isEmpty()) "Aucune chaîne dans le groupe miami" else null, updatedAt, stale)
    } catch (e: Exception) {
        MiamiData(emptyList(), false, e.message ?: "Serveur injoignable")
    }
}

/** Avatar rond (gardé 1 jour en cache), avec anneau néon si la chaîne est en live, grisé sinon (version compacte). */
private suspend fun avatar(context: Context, c: Channel, sizePx: Int, grayWhenOffline: Boolean): Bitmap? = withContext(Dispatchers.IO) {
    val url = c.avatar ?: return@withContext null
    val file = File(context.cacheDir, "avatars/${c.name}.png")
    val raw = runCatching {
        if (!file.exists() || System.currentTimeMillis() - file.lastModified() > 86_400_000) {
            file.parentFile?.mkdirs()
            URL(url).openStream().use { input -> file.outputStream().use { input.copyTo(it) } }
        }
        BitmapFactory.decodeFile(file.path)
    }.getOrNull() ?: return@withContext null

    val live = c.live != null
    val out = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(out)
    val ring = if (live) sizePx * 0.12f else 0f
    val r = sizePx / 2f
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    if (live) {
        paint.color = 0xFFFF4FA0.toInt(); canvas.drawCircle(r, r, r, paint)
        paint.color = 0xFF26D6E6.toInt(); canvas.drawCircle(r, r, r - ring * .55f, paint)
    }
    val inner = r - ring
    val scaled = Bitmap.createScaledBitmap(raw, (inner * 2).toInt().coerceAtLeast(1), (inner * 2).toInt().coerceAtLeast(1), true)
    val shader = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        shader = BitmapShader(scaled, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP).also {
            it.setLocalMatrix(android.graphics.Matrix().apply { setTranslate(r - inner, r - inner) })
        }
        if (!live && grayWhenOffline) colorFilter = ColorMatrixColorFilter(ColorMatrix().apply { setSaturation(0f) })
        if (!live && grayWhenOffline) alpha = 140
    }
    canvas.drawCircle(r, r, inner, shader)
    out
}

/** Heure de mise à jour : « 14:32 », « hier 22:10 » ou « 23/11 22:10 ». */
private fun clockLabel(t: Long): String {
    val day = { ms: Long -> java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()).toLocalDate() }
    val time = java.text.SimpleDateFormat("HH:mm", java.util.Locale.FRANCE).format(java.util.Date(t))
    val today = java.time.LocalDate.now()
    return when (day(t)) {
        today -> time
        today.minusDays(1) -> "hier $time"
        else -> java.text.SimpleDateFormat("dd/MM HH:mm", java.util.Locale.FRANCE).format(java.util.Date(t))
    }
}

/** Rafraîchit tous les widgets (après une action, une alerte reçue, ou toutes les 15 min). */
suspend fun refreshWidgets(context: Context) {
    runCatching { MiamiWidget().updateAll(context) }
    runCatching { MiamiCompactWidget().updateAll(context) }
}

private val Pink = Color(0xFFFF4FA0)
private val LiveWidgetRed = Color(0xFFE91916)
private val textColor = ColorProvider(day = Color(0xFF1D1420), night = Color(0xFFF4EFF7))
private val mutedColor = ColorProvider(day = Color(0xFF6E5F75), night = Color(0xFFB9AEC4))
private val okColor = ColorProvider(day = Color(0xFF15803D), night = Color(0xFF22C55E))
private val amberColor = ColorProvider(day = Color(0xFFB45309), night = Color(0xFFF59E0B))
private val pinkColor = ColorProvider(day = Color(0xFFC0216A), night = Pink)
private val liveColor = ColorProvider(day = LiveWidgetRed, night = Color(0xFFFF5A55))

private val NameKey = ActionParameters.Key<String>("channel")
private val ChannelExtra = ActionParameters.Key<String>(EXTRA_CHANNEL)

// --- Grand widget (4 × 3) ---

class MiamiWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = loadMiami(context)
        val avatars = data.channels.associate { it.name to avatar(context, it, 96, grayWhenOffline = false) }
        val locked = widgetLocked(context)
        provideContent { MiamiContent(data, avatars, locked) }
    }
}

@Composable
private fun MiamiContent(data: MiamiData, avatars: Map<String, Bitmap?>, locked: Boolean) {
    val live = data.channels.count { it.live != null }
    val joined = data.channels.count { it.live != null && it.joined }
    Column(GlanceModifier.fillMaxSize().background(ImageProvider(R.drawable.widget_bg))) {
        Box(GlanceModifier.fillMaxWidth().height(3.dp).background(ImageProvider(R.drawable.widget_neon))) {}
        Column(GlanceModifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(GlanceModifier.defaultWeight().clickable(actionStartActivity<MainActivity>())) {
                    Text("🌴 Miami", style = TextStyle(color = pinkColor, fontSize = 16.sp, fontWeight = FontWeight.Bold))
                    Text(
                        data.error ?: "$live en live · $joined chat${if (joined > 1) "s" else ""} connecté${if (joined > 1) "s" else ""}",
                        style = TextStyle(color = mutedColor, fontSize = 11.sp),
                    )
                }
                // Heure de la dernière mise à jour sous le ⟳ (orange + ⚠ = serveur injoignable, dernier état gardé),
                // sans ajouter de ligne à l'en-tête : la liste déborderait et une barre de défilement apparaîtrait
                Column(GlanceModifier.padding(horizontal = 6.dp).clickable(actionRunCallback<RefreshAction>()),
                    horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("⟳", style = TextStyle(color = textColor, fontSize = 18.sp))
                    data.updatedAt?.let {
                        Text(if (data.stale) "⚠ ${clockLabel(it)}" else clockLabel(it), maxLines = 1,
                            style = TextStyle(color = if (data.stale) amberColor else mutedColor, fontSize = 9.sp))
                    }
                }
                Text(if (locked) "🔒" else "🔓", modifier = GlanceModifier.padding(8.dp)
                    .clickable(actionRunCallback<ToggleLockAction>(actionParametersOf(LockKey to !locked))),
                    style = TextStyle(color = if (locked) pinkColor else mutedColor, fontSize = 16.sp))
                val palm = GlanceModifier.padding(8.dp)
                Text("🌴", modifier = if (locked) palm
                    else palm.clickable(actionRunCallback<ToggleMiamiAction>(actionParametersOf(MiamiOnKey to !data.miamiMode))),
                    style = TextStyle(fontSize = 18.sp, color = if (data.miamiMode) pinkColor else mutedColor))
            }
            Spacer(GlanceModifier.height(4.dp))
            LazyColumn(GlanceModifier.fillMaxSize()) {
                items(data.channels, itemId = { it.name.hashCode().toLong() }) { c -> ChannelLine(c, avatars[c.name], locked) }
            }
        }
    }
}

@Composable
private fun ChannelLine(c: Channel, avatar: Bitmap?, locked: Boolean) {
    Row(
        GlanceModifier.fillMaxWidth().padding(vertical = 5.dp)
            .clickable(actionStartActivity<MainActivity>(actionParametersOf(ChannelExtra to c.name))),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (avatar != null) Image(ImageProvider(avatar), contentDescription = null, modifier = GlanceModifier.size(36.dp))
        else Box(GlanceModifier.size(36.dp)) {}
        Spacer(GlanceModifier.width(10.dp))
        Column(GlanceModifier.defaultWeight()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(c.displayName, maxLines = 1, style = TextStyle(color = textColor, fontSize = 14.sp, fontWeight = FontWeight.Bold))
                c.live?.let {
                    Spacer(GlanceModifier.width(6.dp))
                    Text(" LIVE ", modifier = GlanceModifier.background(ImageProvider(R.drawable.widget_live)),
                        style = TextStyle(color = ColorProvider(day = Color.White, night = Color.White), fontSize = 9.sp, fontWeight = FontWeight.Bold))
                    Spacer(GlanceModifier.width(5.dp))
                    Text("${formatViewers(it.viewers)} · ${since(it.startedAt)}", maxLines = 1,
                        style = TextStyle(color = liveColor, fontSize = 11.sp, fontWeight = FontWeight.Bold))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                val (chat, chatColor) = when {
                    !c.enabled -> "désactivé" to mutedColor
                    c.joined -> "● connecté" to okColor
                    else -> "si live" to amberColor
                }
                if (c.live == null) {
                    Text("hors ligne${c.lastLive?.let { " · ${since(it)}" } ?: ""} · ", maxLines = 1, style = TextStyle(color = mutedColor, fontSize = 11.sp))
                }
                Text(chat, maxLines = 1, style = TextStyle(color = chatColor, fontSize = 11.sp))
                if (c.boostersToday > 0) {
                    Text("  🎁 ${c.boostersToday}", maxLines = 1, style = TextStyle(color = okColor, fontSize = 11.sp, fontWeight = FontWeight.Bold))
                }
                val wait = minutesSince(c.lastDrop)?.let { 30 - it }
                if (wait != null && wait > 0) {
                    Text("  ⏱ attente $wait min", maxLines = 1, style = TextStyle(color = amberColor, fontSize = 11.sp, fontWeight = FontWeight.Bold))
                }
            }
        }
        // Verrouillé : un interrupteur dessiné, sans action (un Switch sans action basculerait quand même à l'écran)
        if (locked) Box(GlanceModifier.size(width = 38.dp, height = 22.dp)
            .background(ImageProvider(if (c.enabled) R.drawable.widget_switch_on else R.drawable.widget_switch_off))) {}
        else Switch(
            checked = c.enabled,
            onCheckedChange = actionRunCallback<ToggleChatAction>(actionParametersOf(NameKey to c.name)),
            colors = SwitchDefaults.colors(
                checkedThumbColor = ColorProvider(day = Color.White, night = Color.White),
                uncheckedThumbColor = ColorProvider(day = Color.White, night = Color(0xFFCCC4D6)),
                checkedTrackColor = ColorProvider(day = Color(0xFFE0287A), night = Pink),
                uncheckedTrackColor = ColorProvider(day = Color(0x33000000), night = Color(0x33FFFFFF)),
            ),
        )
    }
}

class MiamiWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MiamiWidget()
}

// --- Version compacte (4 × 1) ---

class MiamiCompactWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val data = loadMiami(context)
        val avatars = data.channels.take(6).map { it to avatar(context, it, 84, grayWhenOffline = true) }
        provideContent {
            val live = data.channels.count { it.live != null }
            Row(
                GlanceModifier.fillMaxSize().background(ImageProvider(R.drawable.widget_bg)).padding(horizontal = 12.dp)
                    .clickable(actionStartActivity<MainActivity>()),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Miami", style = TextStyle(color = pinkColor, fontSize = 14.sp, fontWeight = FontWeight.Bold))
                Spacer(GlanceModifier.width(10.dp))
                Row(GlanceModifier.defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
                    avatars.forEach { (c, bmp) ->
                        if (bmp != null) Image(ImageProvider(bmp), contentDescription = c.name, modifier = GlanceModifier.size(30.dp))
                        Spacer(GlanceModifier.width(5.dp))
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(data.error?.let { "!" } ?: "$live / ${data.channels.size} en live",
                        style = TextStyle(color = mutedColor, fontSize = 11.sp))
                    data.updatedAt?.let {
                        Text(if (data.stale) "⚠ ${clockLabel(it)}" else clockLabel(it), maxLines = 1,
                            style = TextStyle(color = if (data.stale) amberColor else mutedColor, fontSize = 9.sp))
                    }
                }
            }
        }
    }
}

class MiamiCompactReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = MiamiCompactWidget()
}

// --- Actions des widgets ---

private val MiamiOnKey = ActionParameters.Key<Boolean>("miami")
private val LockKey = ActionParameters.Key<Boolean>("locked")

class ToggleLockAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val locked = parameters[LockKey] ?: return
        deckPrefs(context).edit().putBoolean(LOCK_PREF, locked).apply()
        refreshWidgets(context)
    }
}

class ToggleChatAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val name = parameters[NameKey] ?: return
        val on = parameters[ToggleableStateKey] ?: return
        if (widgetLocked(context)) return refreshWidgets(context)
        runCatching {
            Api(deckPrefs(context)).call(if (on) "/channels/join" else "/channels/part", JSONObject().put("channels", JSONArray().put(name)))
        }
        refreshWidgets(context)
    }
}

class ToggleMiamiAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val on = parameters[MiamiOnKey] ?: return
        if (widgetLocked(context)) return refreshWidgets(context)
        runCatching { Api(deckPrefs(context)).call("/settings", JSONObject().put("miamiMode", on)) }
        refreshWidgets(context)
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) = refreshWidgets(context)
}

/** Rafraîchissement de fond toutes les 15 minutes (le minimum autorisé par Android). */
class WidgetWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val prefs = deckPrefs(applicationContext)
        val before = prefs.getLong(CACHE_TIME_PREF, 0)
        refreshWidgets(applicationContext)
        // Serveur toujours injoignable (cache pas mis à jour) : Android relancera plus tard, avec un délai croissant
        val ok = prefs.getLong(CACHE_TIME_PREF, 0) != before || Api(prefs).token == null
        return if (ok || runAttemptCount >= 5) Result.success() else Result.retry()
    }

    companion object {
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                "widgets", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<WidgetWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
            )
        }

        /** Après un échec réseau : un rafraîchissement unique, lancé par Android dès que le réseau revient. */
        fun retryWhenOnline(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork(
                "widgets-retry", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<WidgetWorker>().setConstraints(online).build(),
            )
        }

        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
    }
}
