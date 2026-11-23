package dev.darkwolf.livedeck

import android.app.TimePickerDialog
import android.content.Intent
import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

private val ROUTE_KINDS = listOf(
    "live" to "Débuts de live",
    "chat" to "Mentions et personnes surveillées",
    "account" to "Timeouts, bans et sécurité",
)
private val ROUTES = listOf("discord" to "Discord", "push" to "Appli", "both" to "Les deux")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsScreen(vm: DeckViewModel, onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val status = vm.status
    var testResult by remember { mutableStateOf<String?>(null) }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                navigationIcon = { IconButton(onClick = onBack) { Text("←", style = MaterialTheme.typography.titleLarge) } },
                title = { Text("Notifications", fontWeight = FontWeight.Bold) },
            )
        },
    ) { padding ->
        if (status == null) {
            Box(Modifier.padding(padding).fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        Column(
            Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            // Test
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Tester", style = MaterialTheme.typography.titleMedium)
                Button(onClick = { scope.launch { testResult = "Envoi…"; testResult = vm.testNotification() } }) { Text("Envoyer une notification de test") }
                testResult?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                TextButton(onClick = {
                    context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName))
                }, contentPadding = PaddingValues(0.dp)) { Text("Réglages Android des notifications de l'appli") }
            }

            HorizontalDivider()

            // Où part chaque type d'alerte
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Où envoyer les alertes", style = MaterialTheme.typography.titleMedium)
                Text(
                    "« Appli » couvre l'appli et les notifications du navigateur (PC compris)." +
                        if (!status.discordSet) " Aucun webhook Discord n'est configuré : les alertes « Discord » ne partent nulle part." else "",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                ROUTE_KINDS.forEach { (kind, label) ->
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(label, style = MaterialTheme.typography.bodyMedium)
                        val current = status.pushRoutes[kind] ?: "discord"
                        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                            ROUTES.forEachIndexed { i, (value, text) ->
                                SegmentedButton(
                                    selected = current == value,
                                    onClick = { if (current != value) vm.setRoute(kind, value) },
                                    enabled = !vm.busy,
                                    shape = SegmentedButtonDefaults.itemShape(i, ROUTES.size),
                                ) { Text(text) }
                            }
                        }
                    }
                }
            }

            HorizontalDivider()

            // Heures calmes
            val q = status.quiet
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Heures calmes", style = MaterialTheme.typography.titleMedium)
                        Text("Alertes sans son ni vibration. La sécurité sonne toujours.",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Switch(checked = q.enabled, onCheckedChange = { vm.setQuiet(q.copy(enabled = it)) }, enabled = !vm.busy)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("De")
                    TimeButton(q.start, enabled = !vm.busy) { vm.setQuiet(q.copy(start = it)) }
                    Text("à")
                    TimeButton(q.end, enabled = !vm.busy) { vm.setQuiet(q.copy(end = it)) }
                }
            }
            vm.error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun TimeButton(value: String, enabled: Boolean, onPick: (String) -> Unit) {
    val context = LocalContext.current
    val (h, m) = value.split(":").map { it.toIntOrNull() ?: 0 }.let { (it.getOrElse(0) { 0 }) to (it.getOrElse(1) { 0 }) }
    OutlinedButton(onClick = {
        TimePickerDialog(context, { _, hour, minute -> onPick("%02d:%02d".format(hour, minute)) }, h, m, true).show()
    }, enabled = enabled) { Text(value) }
}
