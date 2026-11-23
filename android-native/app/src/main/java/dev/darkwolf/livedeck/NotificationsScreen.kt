package dev.darkwolf.livedeck

import android.app.TimePickerDialog
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.biometric.BiometricManager
import android.widget.Toast
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
                title = { Text("Réglages", fontWeight = FontWeight.Bold) },
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

            // Notif « Miami en direct »
            var miamiLive by remember { mutableStateOf(MiamiLive.enabled(context)) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Notif Miami en direct", style = MaterialTheme.typography.titleMedium)
                    Text(
                        "Une notification permanente avec tes chaînes miami en live, mise à jour en continu, visible aussi sur l'écran de verrouillage." +
                            if (status.miamiMode) "" else " Elle ne s'affiche que quand le mode Miami 🌴 est actif.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = miamiLive, onCheckedChange = { miamiLive = it; MiamiLive.setEnabled(context, it) })
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

            HorizontalDivider()

            // Apparence
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Couleurs du fond d'écran", style = MaterialTheme.typography.titleMedium)
                    Text(
                        if (Build.VERSION.SDK_INT >= 31) "Hors mode Miami, l'appli reprend les couleurs de ton fond d'écran."
                        else "Nécessite Android 12 ou plus récent.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = vm.dynamicColors, onCheckedChange = { vm.changeDynamicColors(it) }, enabled = Build.VERSION.SDK_INT >= 31)
            }

            HorizontalDivider()

            // Sécurité
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Déverrouiller avec l'empreinte", style = MaterialTheme.typography.titleMedium)
                    Text("Demandée quand tu rouvres l'appli après le délai choisi. Les widgets et les notifications restent visibles.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = vm.biometricLock, onCheckedChange = { on ->
                    val activity = context as? MainActivity
                    val auth = if (Build.VERSION.SDK_INT >= 30) BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
                    else BiometricManager.Authenticators.BIOMETRIC_WEAK or BiometricManager.Authenticators.DEVICE_CREDENTIAL
                    when {
                        !on -> activity?.authenticate { vm.changeBiometricLock(false) }
                        BiometricManager.from(context).canAuthenticate(auth) != BiometricManager.BIOMETRIC_SUCCESS ->
                            Toast.makeText(context, "Aucune empreinte ni code de verrouillage configuré sur ce téléphone", Toast.LENGTH_LONG).show()
                        // Une première empreinte pour confirmer avant d'activer
                        else -> activity?.authenticate { vm.changeBiometricLock(true); vm.markActive() }
                    }
                })
            }
            if (vm.biometricLock) {
                Text("Pas d'empreinte si tu reviens dans l'appli dans les", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                val delays = listOf(1 to "1 min", 5 to "5 min", 15 to "15 min", 60 to "1 h")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                    delays.forEachIndexed { i, (minutes, label) ->
                        SegmentedButton(
                            selected = vm.lockDelay == minutes,
                            onClick = { vm.changeLockDelay(minutes) },
                            shape = SegmentedButtonDefaults.itemShape(i, delays.size),
                        ) { Text(label) }
                    }
                }
            }

            HorizontalDivider()
            // Version installée : utile pour vérifier qu'une mise à jour est bien passée
            var checking by remember { mutableStateOf(false) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Twitch Deck ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})",
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                )
                TextButton(enabled = !checking, onClick = {
                    scope.launch {
                        checking = true
                        val (message, available) = vm.checkUpdate()
                        checking = false
                        Toast.makeText(context, message, Toast.LENGTH_LONG).show()
                        // Nouvelle version : retour à la liste, où la bannière propose l'installation
                        if (available) onBack()
                    }
                }) { Text(if (checking) "Recherche…" else "Rechercher une mise à jour") }
            }
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
