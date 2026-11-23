package dev.darkwolf.livedeck

import android.content.Intent
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

private val TwitchPurple = Color(0xFF9146FF)
private val MiamiPink = Color(0xFFFF4FA0)
private val MiamiCyan = Color(0xFF26D6E6)
private val LiveRed = Color(0xFFE91916)

class MainActivity : ComponentActivity() {
    private val vm: DeckViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { DeckApp(vm) }
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

enum class Filter(val label: String) { Watch("À suivre"), Live("En live"), Favorites("Favoris"), All("Toutes") }

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
    val status = vm.status
    var filter by rememberSaveable { mutableStateOf(Filter.Watch) }
    var selected by remember { mutableStateOf<String?>(null) }
    var showInbox by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Twitch Deck", fontWeight = FontWeight.Bold)
                        status?.let {
                            Text(
                                if (it.ircConnected) "● ${it.joinedCount} chats" else "IRC déconnecté",
                                style = MaterialTheme.typography.labelMedium,
                                color = if (it.ircConnected) Color(0xFF22C55E) else MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                },
                actions = {
                    val unseen = status?.inbox?.count { !it.seen } ?: 0
                    BadgedBox(badge = { if (unseen > 0) Badge { Text(if (unseen > 9) "9+" else "$unseen") } }) {
                        IconButton(onClick = { showInbox = true; vm.markInboxSeen() }) { Text("🔔", fontSize = 20.sp) }
                    }
                    val miami = status?.miamiMode == true
                    IconButton(
                        onClick = { vm.setMiami(!miami) },
                        enabled = status != null && !vm.busy,
                        modifier = if (miami) Modifier.border(2.dp, MiamiPink, CircleShape) else Modifier,
                    ) { Text("🌴", fontSize = 20.sp, color = if (miami) Color.Unspecified else Color.Gray.copy(alpha = .5f)) }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(Filter.entries) { f ->
                    FilterChip(selected = filter == f, onClick = { filter = f }, label = { Text(f.label) })
                }
            }
            vm.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            PullToRefreshBox(isRefreshing = vm.refreshing, onRefresh = { vm.refresh(showSpinner = true) }, modifier = Modifier.fillMaxSize()) {
                if (status == null) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        if (vm.error == null) CircularProgressIndicator()
                        else TextButton(onClick = { vm.unpair() }) { Text("Jumeler à nouveau") }
                    }
                } else {
                    val shown = visibleChannels(status, filter)
                    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                        if (shown.isEmpty()) item {
                            Text(
                                if (filter == Filter.Watch) "Aucune chaîne à suivre en live pour l'instant." else "Aucune chaîne ici.",
                                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(24.dp),
                            )
                        }
                        items(shown, key = { it.name }) { c -> ChannelRow(c, status.miamiMode) { selected = c.name } }
                    }
                }
            }
        }
    }

    status?.channels?.find { it.name == selected }?.let { c ->
        ChannelSheet(c, vm, onDismiss = { selected = null })
    }
    if (showInbox && status != null) InboxDialog(status.inbox, onOpen = { name -> showInbox = false; selected = name }) { showInbox = false }
}

fun visibleChannels(status: DeckStatus, filter: Filter): List<Channel> {
    val list = when (filter) {
        // Mode Miami : chaînes miami et sans carte en live ; sinon les favoris en live
        Filter.Watch -> status.channels.filter { it.live != null && if (status.miamiMode) it.miami || it.noCard else it.favorite }
        Filter.Live -> status.channels.filter { it.live != null }
        Filter.Favorites -> status.channels.filter { it.favorite }
        Filter.All -> status.channels
    }
    return list.sortedWith(
        compareByDescending<Channel> { it.live != null }
            .thenByDescending { status.miamiMode && it.miami && it.live != null }
            .thenBy { it.watched }
            .thenByDescending { it.live?.viewers ?: -1 }
            .thenBy { it.name },
    )
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
fun ChannelRow(c: Channel, miamiMode: Boolean, onClick: () -> Unit) {
    val rowBg = if (c.miami) Modifier.background(
        Brush.horizontalGradient(listOf(MiamiPink.copy(alpha = .14f), Color(0xFFFFA64D).copy(alpha = .10f), MiamiCyan.copy(alpha = .08f))),
    ) else Modifier
    Row(
        rowBg.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 9.dp)
            .alpha(if (c.watched) .55f else 1f),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Avatar(c, miamiMode)
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(c.displayName + if (c.favorite) " ★" else "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                if (c.miami) Tag("miami", MiamiPink)
                if (c.noCard) Tag("sans carte", MiamiCyan)
            }
            Text(
                c.live?.let { listOf(it.game, it.title).filter(String::isNotBlank).joinToString(" · ") } ?: "Hors ligne",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        c.live?.let {
            Text(formatViewers(it.viewers), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelLarge)
        }
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

// --- Fiche d'une chaîne ---

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ChannelSheet(c: Channel, vm: DeckViewModel, onDismiss: () -> Unit) {
    val context = LocalContext.current
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Avatar(c, vm.status?.miamiMode == true, size = 56)
                Column(Modifier.weight(1f)) {
                    Text(c.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                    Text(
                        c.live?.let { "🔴 ${formatViewers(it.viewers)} spectateurs · depuis ${since(it.startedAt)}" } ?: "Hors ligne",
                        color = if (c.live != null) LiveRed else MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            c.live?.let {
                if (it.title.isNotBlank()) Text(it.title, style = MaterialTheme.typography.bodyLarge)
                if (it.game.isNotBlank()) Text("🎮 ${it.game}", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Button(
                onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.twitch.tv/${c.name}"))) },
                modifier = Modifier.fillMaxWidth(),
            ) { Text("Ouvrir sur Twitch") }

            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = c.enabled, onClick = { vm.setJoined(c, !c.enabled) }, enabled = !vm.busy,
                    label = { Text(if (c.enabled) "Chat rejoint" else "Rejoindre le chat") })
                FilterChip(selected = c.favorite, onClick = { vm.setFavorite(c, !c.favorite) }, enabled = !vm.busy,
                    label = { Text("★ Favori") })
                FilterChip(selected = c.watched, onClick = { vm.setWatched(c, !c.watched) }, enabled = !vm.busy,
                    label = { Text("Fini aujourd'hui") })
            }
            Text("Cartes", style = MaterialTheme.typography.titleSmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("epic" to "Épique", "legendary" to "Légendaire").forEach { (rarity, label) ->
                    val owned = rarity in c.cards
                    FilterChip(selected = owned, onClick = { vm.setCard(c, rarity, !owned) }, enabled = !vm.busy,
                        label = { Text(label) },
                        border = if (owned) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline))
                }
            }
            if (c.groups.isNotEmpty()) {
                Text("Groupes : ${c.groups.joinToString(", ")}", color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall)
            }
        }
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
