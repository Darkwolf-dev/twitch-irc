package dev.darkwolf.livedeck

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class ChannelTab(val label: String) { Overview("Aperçu"), Chat("Chat"), Stats("Stats 7 jours") }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelScreen(c: Channel, vm: DeckViewModel, initialTab: ChannelTab = ChannelTab.Overview, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    var tab by rememberSaveable(c.name) { mutableStateOf(initialTab) }
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Text("←", style = MaterialTheme.typography.titleLarge) } },
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Avatar(c, vm.status?.miamiMode == true, size = 32)
                        Text(c.displayName, fontWeight = FontWeight.Bold)
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.padding(padding).fillMaxSize()) {
            PrimaryTabRow(selectedTabIndex = tab.ordinal) {
                ChannelTab.entries.forEach { t -> Tab(selected = tab == t, onClick = { tab = t }, text = { Text(t.label) }) }
            }
            when (tab) {
                ChannelTab.Overview -> Overview(c, vm)
                ChannelTab.Chat -> ChatTab(c, vm)
                ChannelTab.Stats -> StatsTab(c, vm)
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Overview(c: Channel, vm: DeckViewModel) {
    val context = LocalContext.current
    var newGroup by remember(c.name) { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        c.live?.let { live ->
            live.thumbnail?.let { thumb ->
                // Paramètre qui change toutes les minutes : miniature à jour sans recharger à chaque rafraîchissement
                AsyncImage(
                    model = "$thumb?t=${System.currentTimeMillis() / 60_000}", contentDescription = "Miniature du live",
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxWidth().aspectRatio(16 / 9f).clip(RoundedCornerShape(12.dp)).background(Color.Black),
                )
            }
            Text("🔴 ${formatViewers(live.viewers)} spectateurs · depuis ${since(live.startedAt)}", color = LiveRed, fontWeight = FontWeight.SemiBold)
            if (live.title.isNotBlank()) Text(live.title, style = MaterialTheme.typography.bodyLarge)
            if (live.game.isNotBlank()) Text("🎮 ${live.game}", color = MaterialTheme.colorScheme.onSurfaceVariant)
        } ?: Text("Hors ligne", color = MaterialTheme.colorScheme.onSurfaceVariant)

        Button(
            onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.twitch.tv/${c.name}"))) },
            modifier = Modifier.fillMaxWidth(),
        ) { Text("Ouvrir sur Twitch") }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(selected = c.enabled, onClick = { vm.setJoined(c, !c.enabled) }, enabled = !vm.busy,
                label = { Text(if (c.enabled) "Chat activé" else "Activer le chat") })
            FilterChip(selected = c.favorite, onClick = { vm.setFavorite(c, !c.favorite) }, enabled = !vm.busy, label = { Text("★ Favori") })
            FilterChip(selected = c.watched, onClick = { vm.setWatched(c, !c.watched) }, enabled = !vm.busy, label = { Text("Fini aujourd'hui") })
        }
        Text(stateLabel(c), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

        Text("Cartes", style = MaterialTheme.typography.titleSmall)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("epic" to "Épique", "legendary" to "Légendaire").forEach { (rarity, label) ->
                val owned = rarity in c.cards
                FilterChip(selected = owned, onClick = { vm.setCard(c, rarity, !owned) }, enabled = !vm.busy, label = { Text(label) },
                    border = if (owned) null else BorderStroke(1.dp, MaterialTheme.colorScheme.outline))
            }
        }

        Text("Groupes", style = MaterialTheme.typography.titleSmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            val all = (vm.status?.groups.orEmpty() + c.groups).distinct().sorted()
            all.forEach { g ->
                val member = g in c.groups
                FilterChip(selected = member, onClick = { vm.setGroup(c, g, !member) }, enabled = !vm.busy, label = { Text(g) })
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(value = newGroup, onValueChange = { newGroup = it.take(20) }, singleLine = true,
                placeholder = { Text("Nouveau groupe") }, modifier = Modifier.weight(1f))
            TextButton(onClick = { vm.setGroup(c, newGroup.trim(), true); newGroup = "" }, enabled = newGroup.isNotBlank() && !vm.busy) { Text("Ajouter") }
        }
    }
}

private fun stateLabel(c: Channel) = when (c.state) {
    "joined" -> "● Chat rejoint"
    "joining" -> "Connexion au chat…"
    "full" -> "En attente : plafond de chats atteint"
    "offline" -> "Rejoint seulement quand la chaîne est en live"
    "schedule" -> "En attente : hors de la plage horaire"
    "watched" -> "Marquée « fini » pour aujourd'hui"
    "retrying" -> "Nouvel essai de connexion au chat…"
    else -> if (c.enabled) "Chat activé" else "Chat désactivé"
}

@Composable
private fun ChatTab(c: Channel, vm: DeckViewModel) {
    val messages = remember(c.name) { mutableStateListOf<ChatMessage>() }
    val listState = rememberLazyListState()
    LaunchedEffect(c.name) {
        while (true) {
            val after = messages.lastOrNull()?.id ?: 0L
            val fresh = vm.messages(c.name, after)
            if (fresh.isNotEmpty()) {
                val atBottom = !listState.canScrollForward
                messages.addAll(fresh)
                while (messages.size > 200) messages.removeAt(0)
                if (atBottom || after == 0L) listState.scrollToItem(messages.lastIndex)
            }
            delay(3_000)
        }
    }
    if (messages.isEmpty()) {
        Box(Modifier.fillMaxSize().padding(24.dp)) {
            Text(
                if (c.joined) "Aucun message reçu pour l'instant." else "Le chat n'est pas rejoint : active-le dans l'onglet Aperçu pour voir les messages.",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        return
    }
    val fmt = remember { DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()) }
    LazyColumn(state = listState, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        items(messages, key = { it.id }) { m ->
            val color = m.color?.let { runCatching { Color(android.graphics.Color.parseColor(it)) }.getOrNull() } ?: MaterialTheme.colorScheme.primary
            Text(buildAnnotatedString {
                withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append(fmt.format(Instant.ofEpochMilli(m.at)) + "  ") }
                withStyle(SpanStyle(color = color, fontWeight = FontWeight.Bold)) { append(m.user) }
                append(if (m.action) " " else " : ")
                if (m.action) withStyle(SpanStyle(fontStyle = FontStyle.Italic, color = color)) { append(m.text) } else append(m.text)
            }, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun StatsTab(c: Channel, vm: DeckViewModel) {
    var stats by remember(c.name) { mutableStateOf<ChannelStats?>(null) }
    var loaded by remember(c.name) { mutableStateOf(false) }
    LaunchedEffect(c.name) {
        stats = vm.stats(c.name)
        loaded = true
    }
    val s = stats
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        when {
            !loaded -> CircularProgressIndicator()
            s == null -> Text("Statistiques indisponibles.", color = MaterialTheme.colorScheme.error)
            s.sessions == 0 -> Text("Aucun live suivi ces 7 derniers jours.", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatTile("Heures de live", "%.1f h".format(Locale.FRANCE, s.liveHours), Modifier.weight(1f))
                    StatTile("Lives", "${s.sessions}", Modifier.weight(1f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    StatTile("Pic", s.peak?.let(::formatViewers) ?: "—", Modifier.weight(1f))
                    StatTile("Moyenne", s.avg?.let(::formatViewers) ?: "—", Modifier.weight(1f))
                    StatTile("Msg/min", s.messagesPerMinute?.let { "%.1f".format(Locale.FRANCE, it) } ?: "—", Modifier.weight(1f))
                }
                Text("Lives", style = MaterialTheme.typography.titleSmall)
                val fmt = DateTimeFormatter.ofPattern("EEE d MMM 'à' HH:mm", Locale.FRANCE).withZone(ZoneId.systemDefault())
                s.lives.forEach { l ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(runCatching { fmt.format(Instant.parse(l.start)) }.getOrDefault(l.start))
                        Text("${"%.1f".format(Locale.FRANCE, l.hours)} h · pic ${formatViewers(l.peak)}", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun StatTile(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainer).padding(12.dp)) {
        Text(value, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
