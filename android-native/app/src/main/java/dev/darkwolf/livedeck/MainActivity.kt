package dev.darkwolf.livedeck

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

val TwitchPurple = Color(0xFF9146FF)
val MiamiPink = Color(0xFFFF4FA0)
val MiamiCyan = Color(0xFF26D6E6)
val LiveRed = Color(0xFFE91916)

class MainActivity : ComponentActivity() {
    private val vm: DeckViewModel by viewModels()

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        handle(intent)
        setContent {
            DeckApp(vm)
            // Une fois jumelé : autorisation des notifications (Android 13+) et identifiant Firebase
            LaunchedEffect(vm.paired) { if (vm.paired) setUpNotifications() }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        intent?.getStringExtra(EXTRA_CHANNEL)?.let { vm.pendingChannel = it }
    }

    private fun setUpNotifications() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        if (FirebaseApp.getApps(this).isNotEmpty()) {
            FirebaseMessaging.getInstance().token.addOnSuccessListener { vm.registerFcm(it) }
        }
    }
}

@Composable
fun DeckTheme(miami: Boolean, content: @Composable () -> Unit) {
    val accent = if (miami) MiamiPink else TwitchPurple
    val dark = isSystemInDarkTheme()
    val scheme = if (dark) {
        darkColorScheme(primary = accent, secondary = MiamiCyan, background = Color(0xFF0E0E10), surface = Color(0xFF18181B),
            surfaceContainer = Color(0xFF1F1F23), onPrimary = Color.White)
    } else {
        lightColorScheme(primary = accent, secondary = Color(0xFF0F8B97), onPrimary = Color.White)
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

@Composable
fun DeckApp(vm: DeckViewModel) {
    DeckTheme(miami = vm.status?.miamiMode == true) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
            if (!vm.paired) PairScreen(vm) else HomeScreen(vm)
        }
    }
}

// --- Jumelage ---

@Composable
fun PairScreen(vm: DeckViewModel) {
    var code by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(
        Modifier.fillMaxSize().systemBarsPadding().imePadding().padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Text("Twitch Deck", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text(
            "Dans le panneau, ouvre Réglages → Sécurité → Appli Android, appuie sur « Associer un téléphone », puis tape le code ici.",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        OutlinedTextField(
            value = code,
            onValueChange = { code = it.uppercase().take(9) },
            label = { Text("Code de jumelage") },
            placeholder = { Text("ABCD-2345") },
            singleLine = true,
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, fontSize = 22.sp, letterSpacing = 3.sp),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters),
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        Button(
            onClick = {
                working = true
                scope.launch {
                    error = vm.pair(code)
                    working = false
                }
            },
            enabled = !working && code.count { it.isLetterOrDigit() } == 8,
            modifier = Modifier.fillMaxWidth(),
        ) { Text(if (working) "Jumelage…" else "Associer") }
    }
}

// --- Liste des chaînes ---

/** Vues de la liste, comme dans la colonne de gauche du panneau (« group:nom » pour un groupe). */
fun viewLabel(view: String) = when (view) {
    "watch" -> "À suivre"
    "todo" -> "À farmer"
    "live" -> "En live"
    "fav" -> "Favoris"
    "no-card" -> "Sans carte"
    "no-epic" -> "Sans épique"
    "no-legendary" -> "Sans légendaire"
    "done" -> "Finies"
    "all" -> "Toutes"
    else -> view.removePrefix("group:")
}
val baseViews = listOf("watch", "todo", "live", "fav", "no-card", "no-epic", "no-legendary", "done", "all")

enum class Sort(val label: String) { Status("Statut"), Viewers("Spectateurs"), Name("Nom"), Activity("Activité du chat") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: DeckViewModel) {
    val lifecycle = LocalLifecycleOwner.current
    // Rafraîchissement toutes les 15 s tant que l'appli est à l'écran
    LaunchedEffect(lifecycle) {
        lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            while (true) {
                vm.refresh()
                delay(15_000)
            }
        }
    }
    val context = LocalContext.current
    val status = vm.status
    val miami = status?.miamiMode == true
    var view by rememberSaveable { mutableStateOf("watch") }
    var sort by rememberSaveable { mutableStateOf(Sort.Status) }
    var query by rememberSaveable { mutableStateOf("") }
    var searching by rememberSaveable { mutableStateOf(false) }
    var sortMenu by remember { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf<String?>(null) }
    var showInbox by remember { mutableStateOf(false) }

    // Appui sur une notification : ouvrir la fiche de la chaîne
    LaunchedEffect(vm.pendingChannel) {
        vm.pendingChannel?.let { selected = it; vm.pendingChannel = null }
    }
    val open = status?.channels?.find { it.name == selected }
    if (open != null) {
        ChannelScreen(open, vm, onBack = { selected = null })
        return
    }

    Box(Modifier.fillMaxSize()) {
        if (miami) MiamiBackdrop()
        Scaffold(
            containerColor = Color.Transparent,
            topBar = {
                Column {
                    if (miami) Box(Modifier.statusBarsPadding()) { NeonLine() }
                    TopAppBar(
                        colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                        windowInsets = if (miami) WindowInsets(0) else TopAppBarDefaults.windowInsets,
                        title = {
                            Column {
                                Text("Twitch Deck", fontWeight = FontWeight.Bold,
                                    style = if (miami) LocalTextStyle.current.copy(brush = NeonTitleBrush) else LocalTextStyle.current)
                                status?.let {
                                    Text(
                                        when {
                                            it.ircPaused -> "⏸ IRC en pause"
                                            it.ircConnected -> "● ${it.joinedCount} / ${it.maxConcurrent} chats"
                                            else -> "IRC déconnecté"
                                        },
                                        style = MaterialTheme.typography.labelMedium,
                                        color = if (it.ircConnected && !it.ircPaused) Color(0xFF22C55E) else MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        },
                        actions = {
                            IconButton(onClick = { searching = !searching; if (!searching) query = "" }) { Text("🔍", fontSize = 18.sp) }
                            val unseen = status?.inbox?.count { !it.seen } ?: 0
                            BadgedBox(badge = { if (unseen > 0) Badge { Text(if (unseen > 9) "9+" else "$unseen") } }) {
                                IconButton(onClick = { showInbox = true; vm.markInboxSeen() }) { Text("🔔", fontSize = 18.sp) }
                            }
                            IconButton(
                                onClick = { vm.setMiami(!miami) },
                                enabled = status != null && !vm.busy,
                                modifier = if (miami) Modifier.border(2.dp, MiamiPink, CircleShape) else Modifier,
                            ) { Text("🌴", fontSize = 18.sp, color = if (miami) Color.Unspecified else Color.Gray.copy(alpha = .5f)) }
                            IconButton(onClick = {
                                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.PANEL_URL)))
                            }) { Text("🌐", fontSize = 18.sp) }
                        },
                    )
                }
            },
        ) { padding ->
            Column(Modifier.padding(padding).fillMaxSize()) {
                if (searching) {
                    OutlinedTextField(
                        value = query, onValueChange = { query = it }, singleLine = true,
                        placeholder = { Text("Chercher une chaîne") },
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    )
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    LazyRow(
                        Modifier.weight(1f),
                        contentPadding = PaddingValues(start = 12.dp, end = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        val views = baseViews + status?.groups.orEmpty().map { "group:$it" }
                        items(views) { v ->
                            val count = status?.let { st -> st.channels.count { inView(it, v, st.miamiMode) } }
                            FilterChip(selected = view == v, onClick = { view = v },
                                label = { Text(if (count != null) "${viewLabel(v)} $count" else viewLabel(v)) })
                        }
                    }
                    Box {
                        TextButton(onClick = { sortMenu = true }) { Text("↕ ${sort.label}", style = MaterialTheme.typography.labelMedium) }
                        DropdownMenu(expanded = sortMenu, onDismissRequest = { sortMenu = false }) {
                            Sort.entries.forEach { s ->
                                DropdownMenuItem(text = { Text(s.label) }, onClick = { sort = s; sortMenu = false })
                            }
                        }
                    }
                }
                vm.error?.let {
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                }
                // Nouvelle version de l'appli disponible sur le serveur
                val newer = status?.appVersionCode?.takeIf { it > BuildConfig.VERSION_CODE }
                var dismissed by rememberSaveable { mutableStateOf(0) }
                if (newer != null && dismissed != newer) {
                    val scope = rememberCoroutineScope()
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(10.dp))
                            .background(MaterialTheme.colorScheme.primary).padding(start = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("Nouvelle version ${status.appVersionName}", color = MaterialTheme.colorScheme.onPrimary, modifier = Modifier.weight(1f))
                        TextButton(onClick = { dismissed = newer }) { Text("Plus tard", color = MaterialTheme.colorScheme.onPrimary) }
                        TextButton(onClick = {
                            scope.launch {
                                // Téléchargement par le navigateur, qui propose ensuite d'installer l'APK
                                vm.updateLink()?.let { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) }
                            }
                        }) { Text("Installer", color = MaterialTheme.colorScheme.onPrimary, fontWeight = FontWeight.Bold) }
                    }
                }
                PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = { vm.refresh(showSpinner = true) }, modifier = Modifier.fillMaxSize()) {
                    if (status == null) {
                        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                            if (vm.error == null) CircularProgressIndicator()
                            else TextButton(onClick = { vm.unpair() }) { Text("Jumeler à nouveau") }
                        }
                    } else {
                        val shown = visibleChannels(status, view, sort, query)
                        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                            if (shown.isEmpty()) item {
                                Text(
                                    if (view == "watch") "Aucune chaîne à suivre en live pour l'instant." else "Aucune chaîne ici.",
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp),
                                )
                            }
                            items(shown, key = { it.name }) { c -> ChannelRow(c, status.miamiMode, vm) { selected = c.name } }
                        }
                    }
                }
            }
        }
    }

    if (showInbox && status != null) InboxDialog(status.inbox, onOpen = { name -> showInbox = false; selected = name }) { showInbox = false }
}

fun inView(c: Channel, view: String, miamiMode: Boolean): Boolean = when (view) {
    // Mode Miami : chaînes miami et sans carte en live ; sinon les favoris en live
    "watch" -> c.live != null && if (miamiMode) c.miami || c.noCard else c.favorite
    "todo" -> c.todo
    "live" -> c.live != null
    "fav" -> c.favorite
    "no-card" -> c.noCard
    "no-epic" -> "epic" !in c.cards
    "no-legendary" -> "legendary" !in c.cards
    "done" -> c.watched
    "all" -> true
    else -> c.groups.contains(view.removePrefix("group:"))
}

private fun statusRank(c: Channel) = when {
    c.live != null -> if (c.watched) 2 else if (c.enabled) 0 else 1
    c.joined -> 3
    else -> 4
}

fun visibleChannels(status: DeckStatus, view: String, sort: Sort, query: String): List<Channel> {
    val words = query.lowercase().split(Regex("[\\s,;]+")).filter { it.isNotBlank() }
    val list = status.channels.filter { c ->
        inView(c, view, status.miamiMode) && (words.isEmpty() || words.any { c.name.contains(it) })
    }
    val base: Comparator<Channel> = when {
        // « À farmer » : le moins de cartes d'abord, puis les plus gros lives
        view == "todo" -> compareBy<Channel> { it.cards.size }.thenByDescending { it.live?.viewers ?: -1 }
        sort == Sort.Viewers -> compareBy<Channel> { it.watched }.thenByDescending { it.live?.viewers ?: -1 }
        sort == Sort.Name -> compareBy { it.name }
        sort == Sort.Activity -> compareBy { it.lastMessageAge ?: Int.MAX_VALUE }
        else -> compareByDescending<Channel> { it.live != null }
            .thenByDescending { it.favorite && !it.watched }
            .thenBy { statusRank(it) }
            .thenByDescending { it.live?.viewers ?: -1 }
    }
    // Mode Miami : les chaînes miami en live passent en tête, quel que soit le tri
    val miamiFirst = compareByDescending<Channel> { status.miamiMode && it.miami && it.live != null }
    return list.sortedWith(miamiFirst.then(base).thenBy { it.name })
}

@Composable
fun Avatar(c: Channel, miamiMode: Boolean, size: Int = 44) {
    val neon = miamiMode && c.miami && c.live != null
    val ring = when {
        neon -> Modifier.shadow(10.dp, CircleShape, ambientColor = MiamiPink, spotColor = MiamiPink)
            .border(3.dp, MiamiPink, CircleShape).padding(3.dp).border(2.dp, MiamiCyan, CircleShape).padding(2.dp)
        c.live != null -> Modifier.border(2.dp, LiveRed, CircleShape).padding(3.dp)
        else -> Modifier.padding(3.dp)
    }
    Box(ring.size(size.dp).clip(CircleShape).background(TwitchPurple.copy(alpha = .5f)), contentAlignment = Alignment.Center) {
        Text(c.name.take(1).uppercase(), color = Color.White, fontWeight = FontWeight.Bold)
        if (c.avatar != null) {
            AsyncImage(model = c.avatar, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

@Composable
fun Tag(text: String, color: Color) {
    Text(
        text, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
        modifier = Modifier.border(1.dp, color.copy(alpha = .7f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 1.dp),
    )
}

@Composable
fun ChannelRow(c: Channel, miamiMode: Boolean, vm: DeckViewModel, onClick: () -> Unit) {
    val rowBg = if (c.miami) Modifier.background(
        Brush.horizontalGradient(listOf(MiamiPink.copy(alpha = .14f), Color(0xFFFFA64D).copy(alpha = .10f), MiamiCyan.copy(alpha = .08f))),
    ) else Modifier
    Row(
        rowBg.fillMaxWidth().clickable(onClick = onClick).padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp)
            .alpha(if (c.watched) .55f else 1f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Avatar(c, miamiMode)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(c.displayName + if (c.favorite) " ★" else "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                c.live?.let {
                    Text("LIVE", color = Color.White, fontSize = 10.sp, fontWeight = FontWeight.Bold,
                        modifier = Modifier.clip(RoundedCornerShape(4.dp)).background(LiveRed).padding(horizontal = 5.dp, vertical = 1.dp))
                    Text("${formatViewers(it.viewers)} · ${since(it.startedAt)}", color = LiveRed, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
                }
            }
            Text(
                c.live?.let { listOf(it.game, it.title).filter(String::isNotBlank).joinToString(" · ") } ?: "Hors ligne",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                RowState(c)
                if (c.miami) Tag("miami", MiamiPink)
                if (c.noCard) Tag("sans carte", MiamiCyan)
            }
        }
        // Cartes : pastilles É / L cliquables, comme sur le site
        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CardPip("É", "epic" in c.cards, Color(0xFFA855F7), enabled = !vm.busy) { vm.setCard(c, "epic", "epic" !in c.cards) }
            CardPip("L", "legendary" in c.cards, Color(0xFFF97316), enabled = !vm.busy) { vm.setCard(c, "legendary", "legendary" !in c.cards) }
        }
        Switch(checked = c.enabled, onCheckedChange = { vm.setJoined(c, it) }, enabled = !vm.busy)
    }
}

@Composable
fun RowState(c: Channel) {
    val (label, color) = when (c.state) {
        "joined" -> "● connecté" to Color(0xFF22C55E)
        "joining" -> "connexion…" to Color(0xFFF59E0B)
        "full" -> "plafond atteint" to Color(0xFFF59E0B)
        "offline" -> "si live" to MaterialTheme.colorScheme.onSurfaceVariant
        "schedule" -> "hors plage" to MaterialTheme.colorScheme.onSurfaceVariant
        "watched" -> "fini" to MaterialTheme.colorScheme.onSurfaceVariant
        "retrying" -> "nouvel essai…" to MaterialTheme.colorScheme.error
        else -> (if (c.enabled) "activé" else "désactivé") to MaterialTheme.colorScheme.onSurfaceVariant
    }
    Text(label, color = color, fontSize = 11.sp, maxLines = 1)
}

@Composable
fun CardPip(letter: String, owned: Boolean, color: Color, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier.size(26.dp).clip(RoundedCornerShape(7.dp))
            .then(if (owned) Modifier.background(color) else Modifier.border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(7.dp)))
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(letter, fontSize = 12.sp, fontWeight = FontWeight.Bold,
            color = if (owned) Color.White else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

fun formatViewers(n: Int) = if (n >= 1000) "%.1f k".format(n / 1000f).replace(".0 ", " ") else "$n"

fun since(iso: String?): String {
    val t = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: return ""
    val m = Duration.between(t, Instant.now()).toMinutes().coerceAtLeast(0)
    return when {
        m < 60 -> "$m min"
        m < 1440 -> "${m / 60} h ${m % 60}"
        else -> "${m / 1440} j"
    }
}

// --- Cloche ---

@Composable
fun InboxDialog(items: List<InboxItem>, onOpen: (String) -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        confirmButton = { TextButton(onClick = onDismiss) { Text("Fermer") } },
        title = { Text("Notifications") },
        text = {
            if (items.isEmpty()) Text("Rien de nouveau.")
            else LazyColumn(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.heightIn(max = 420.dp)) {
                items(items, key = { it.id }) { n ->
                    Column(
                        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp))
                            .background(if (!n.seen) MaterialTheme.colorScheme.primary.copy(alpha = .12f) else Color.Transparent)
                            .clickable(enabled = n.channel != null) { n.channel?.let(onOpen) }
                            .padding(8.dp),
                    ) {
                        Text(n.title, fontWeight = FontWeight.SemiBold)
                        if (n.body.isNotBlank()) Text(n.body, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Text("il y a ${since(n.at)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        },
    )
}
