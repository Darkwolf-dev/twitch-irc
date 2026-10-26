"use strict";

const KEY = "twitch-irc-secret";
const VIEW_KEY = "twitch-irc-view";
const $ = (id) => document.getElementById(id);
const LABELS = {
  joined: "connecté",
  joining: "connexion…",
  queued: "en file",
  retrying: "nouvel essai",
  parted: "désactivée",
  offline: "attend le live",
  full: "limite atteinte",
  schedule: "hors plage horaire",
  watched: "fini, quitté",
};
// Les marques « fini » tombent à minuit UTC : 1 h à Paris l'hiver, 2 h l'été
const RESET_AT = `${new Date(new Date().setUTCHours(24, 0, 0, 0)).getHours()} h`;
// Cartes streamer qu'on peut cocher sur chaque chaîne
const CARDS = [
  { rarity: "epic", label: "Épique" },
  { rarity: "legendary", label: "Légendaire" },
];
const STATE_HINTS = {
  offline: "Mode « si live » : le chat sera rejoint au début du prochain live",
  full: "Plafond de chats simultanés atteint (réglable dans Réglages)",
  schedule: "En live, mais en dehors de la plage horaire (réglable dans Réglages)",
  watched: `Finie pour aujourd'hui : chat quitté jusqu'à ${RESET_AT}`,
};

let secret = null;
let timer = null;
let lastStatus = null;
let view = "all";
let lastEventId = 0;
let eventItems = [];
const busy = new Set(); // chaînes dont une action est en cours

// --- Secret et API ---

function storage(kind) {
  try { return kind === "local" ? localStorage : sessionStorage; } catch { return null; }
}

function storedSecret() {
  return storage("session")?.getItem(KEY) || storage("local")?.getItem(KEY) || null;
}

function storeSecret(value, remember) {
  try { storage(remember ? "local" : "session")?.setItem(KEY, value); } catch {}
}

function clearSecret() {
  try { storage("local")?.removeItem(KEY); storage("session")?.removeItem(KEY); } catch {}
}

// Sans secret, la session Twitch passe par le cookie (envoyé automatiquement)
// Serveur injoignable (réseau coupé, ou tunnel Cloudflare coupé pendant un redémarrage)
const DOWN_STATUSES = new Set([502, 503, 504, 530]);
function setOffline(offline) {
  $("offline-banner").hidden = !offline;
}

async function api(path, body) {
  const headers = { ...(secret && { Authorization: `Bearer ${secret}` }), ...(body && { "Content-Type": "application/json" }) };
  let res;
  try {
    res = await fetch(path, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
  } catch {
    setOffline(true);
    throw new Error("offline");
  }
  if (DOWN_STATUSES.has(res.status)) {
    setOffline(true);
    throw new Error("offline");
  }
  setOffline(false);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 429) {
    logout(res.status === 429 ? "Trop d'essais ratés, réessaie dans 15 minutes."
      : secret ? "Secret incorrect." : "Session expirée, reconnecte-toi.");
    throw new Error("auth");
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function showError(err) {
  // « offline » est signalé par le bandeau, « auth » par l'écran de connexion
  if (err.message !== "auth" && err.message !== "offline") $("error").textContent = err.message;
}

function showLogin(message = "") {
  clearInterval(timer);
  $("panel").hidden = true;
  $("login").hidden = false;
  $("login-error").textContent = message;
  $("irc").hidden = true; // l'état IRC n'est connu qu'une fois connecté
  if ($("twitch-login").hidden) $("secret-login").open = true;
  loadAuthConfig(); // le réglage a pu changer pendant la session
}

function logout(message) {
  const hadSession = !secret;
  secret = null;
  clearSecret();
  if (hadSession) fetch("/auth/logout", { method: "POST" }).catch(() => {});
  $("account").hidden = true;
  $("account-menu").hidden = true;
  $("open-settings").hidden = true;
  $("open-drops").hidden = true;
  $("profile-box").hidden = true;
  if ($("settings-dialog").open) $("settings-dialog").close();
  showLogin(message);
}

// --- Connexion avec Twitch (flux implicite) ---

const STATE_KEY = "twitch-irc-oauth-state";
let authConfig = { twitch: false };

async function loadAuthConfig() {
  try {
    authConfig = await (await fetch("/auth/config")).json();
  } catch {}
  $("twitch-login").hidden = !authConfig.twitch;
  // Connexion par secret désactivée dans les réglages : l'option disparaît de la page de connexion
  $("secret-login").hidden = authConfig.secret === false;
}

$("twitch-login").addEventListener("click", () => {
  const state = crypto.getRandomValues(new Uint32Array(4)).join("-");
  try { sessionStorage.setItem(STATE_KEY, state); } catch {}
  const url = new URL("https://id.twitch.tv/oauth2/authorize");
  url.search = new URLSearchParams({
    response_type: "token",
    client_id: authConfig.clientId,
    redirect_uri: `${location.origin}/`,
    scope: "",
    state,
  });
  location.assign(url);
});

// Retour de Twitch : le token arrive dans le fragment de l'URL (jamais envoyé au serveur par le navigateur)
async function handleOAuthReturn() {
  const params = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
  if (!params.has("access_token") && !params.has("error")) return false;
  history.replaceState(null, "", location.pathname);

  let expected = null;
  try { expected = sessionStorage.getItem(STATE_KEY); sessionStorage.removeItem(STATE_KEY); } catch {}

  if (params.has("error")) {
    showLogin(params.get("error") === "access_denied" ? "Connexion Twitch annulée." : `Erreur Twitch : ${params.get("error_description") || params.get("error")}`);
    return true;
  }
  if (!expected || params.get("state") !== expected) {
    showLogin("Réponse Twitch inattendue, réessaie.");
    return true;
  }

  try {
    const res = await fetch("/auth/twitch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken: params.get("access_token") }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    secret = null;
    start();
  } catch (err) {
    showLogin(err.message);
  }
  return true;
}

// --- Nouvelle version déployée : rechargement automatique ---

let loadedVersion = null;

// On ne recharge pas sous les doigts de l'utilisateur : saisie en cours = on attend
function isTyping() {
  const a = document.activeElement;
  return Boolean(a && (a.tagName === "TEXTAREA" || a.tagName === "SELECT" ||
    (a.tagName === "INPUT" && !["checkbox", "radio", "button", "submit"].includes(a.type))));
}

function checkVersion(version) {
  if (!version) return;
  loadedVersion ??= version.id;
  const at = new Date(version.deployedAt);
  const deployed = `${at.toLocaleDateString([], { day: "2-digit", month: "2-digit" })} à ${at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  $("version").textContent = `Version ${loadedVersion}${loadedVersion === version.id ? ` · déployée le ${deployed}` : ""}`;
  if (version.id === loadedVersion) return;
  $("update-banner").hidden = false;
  if (!isTyping()) location.reload();
}

async function refresh() {
  try {
    lastStatus = await api("/status");
    checkVersion(lastStatus.version);
    render();
    if ($("journal").open) await refreshEvents();
  } catch (err) {
    showError(err);
  }
}

// Lance une action sur des chaînes puis rafraîchit la liste
async function act(path, names, extra = {}) {
  names.forEach((n) => busy.add(n));
  render();
  $("error").textContent = "";
  try {
    await api(path, { channels: names, ...extra });
  } catch (err) {
    showError(err);
  } finally {
    names.forEach((n) => busy.delete(n));
    await refresh();
  }
}

// --- Rendu ---

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== "string") node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function externalIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ext");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M9 2h5v5M14 2 7.5 8.5M12 9.5V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3.5");
  svg.append(path);
  return svg;
}

function formatAge(seconds) {
  if (seconds < 60) return `il y a ${seconds} s`;
  if (seconds < 3600) return `il y a ${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `il y a ${Math.floor(seconds / 3600)} h`;
  return `il y a ${Math.floor(seconds / 86400)} j`;
}

// « aujourd'hui à 21:30 », « hier à 21:30 », « ven. 16/10 à 21:30 · il y a 3 j »
function formatLastLive(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOf = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (days <= 0) return `aujourd'hui à ${time}`;
  if (days === 1) return `hier à ${time}`;
  const date = d.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "2-digit" });
  return `${date} à ${time} · il y a ${days} j`;
}

// « 45 min », « 2h10 » : durée compacte pour la liste
function shortDuration(iso) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

const NEW_LIVE_MS = 15 * 60_000; // badge « nouveau » pendant les 15 premières minutes d'un live
const DROP_COOLDOWN_MS = 30 * 60_000; // écart minimum entre deux drops ChatDeck

// Miniature du live : Twitch la régénère toutes les ~5 min. Le paramètre change une fois par tranche
// de 5 min, donc le navigateur la redemande au plus toutes les 5 min (et seulement fiche ouverte).
function thumbnailUrl(url) {
  return `${url}?t=${Math.floor(Date.now() / 300_000)}`;
}

function formatDuration(iso) {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 60000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

const viewers = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });

// Mots tapés dans « chercher ou ajouter » (« #Chaine1, chaine2 » → ["chaine1", "chaine2"])
function typedNames() {
  return [...new Set($("names").value.toLowerCase().split(/[\s,;]+/).map((n) => n.replace(/^#/, "")).filter(Boolean))];
}

function visibleChannels() {
  const words = typedNames();
  return lastStatus.channels
    .filter((c) => {
      if (words.length && !words.some((w) => c.name.includes(w))) return false;
      if (view === "fav") return c.favorite;
      if (view === "live") return c.live;
      if (view === "done") return c.watched;
      if (view === "no-epic") return !c.cards.includes("epic");
      if (view === "no-legendary") return !c.cards.includes("legendary");
      if (view === "on") return c.enabled;
      if (view === "off") return !c.enabled;
      if (view.startsWith("group:")) return c.groups.includes(view.slice(6));
      return true;
    })
    .sort(SORTS[$("sort").value] ?? SORTS.status);
}

// Rang « statut » : en live et activées, en live désactivées, en live marquées « fini »,
// chats rejoints hors live, puis le reste
const statusRank = (c) =>
  c.live ? (c.watched ? 2 : c.enabled ? 0 : 1) : c.state === "joined" || c.state === "joining" ? 3 : 4;
const byName = (a, b) => a.name.localeCompare(b.name);
// Un favori marqué « fini » perd sa priorité jusqu'à la remise à zéro
const priority = (c) => Boolean(c.favorite && !c.watched);
const SORTS = {
  // lives d'abord ; dans chaque bloc (live / hors live) les favoris en tête, puis statut, puis nom
  status: (a, b) => (Boolean(b.live) - Boolean(a.live)) || (priority(b) - priority(a)) ||
    (statusRank(a) - statusRank(b)) || byName(a, b),
  // lives du plus gros au plus petit (les chaînes « fini » après), puis les autres par nom
  viewers: (a, b) => (a.watched - b.watched) || ((b.live?.viewers ?? -1) - (a.live?.viewers ?? -1)) || byName(a, b),
  name: byName,
  // dernier message reçu le plus récent en premier, les chats muets à la fin
  activity: (a, b) =>
    ((a.lastMessage?.ageSeconds ?? Infinity) - (b.lastMessage?.ageSeconds ?? Infinity)) || byName(a, b),
};

function scopeLabel() {
  if (view === "fav") return "les favoris";
  if (view === "live") return "les lives";
  if (view === "done") return "les chaînes finies";
  if (view === "no-epic") return "les chaînes sans carte épique";
  if (view === "no-legendary") return "les chaînes sans carte légendaire";
  if (view.startsWith("group:")) return `« ${view.slice(6)} »`;
  if (typedNames().length || view === "on" || view === "off") return "la sélection";
  return null;
}

function render() {
  if (!lastStatus) return;
  const { irc, counts, channels, limits } = lastStatus;

  // Revient sur « Toutes » si le groupe affiché n'existe plus
  if (view.startsWith("group:") && !lastStatus.groups.some((g) => `group:${g.name}` === view)) {
    return setView("all");
  }
  renderGroupTabs();

  const pill = $("irc");
  pill.hidden = false;
  // Le pseudo est déjà affiché par le menu du compte : la pastille ne donne que l'état (pseudo dans l'infobulle)
  pill.textContent = irc.paused ? "⏸ IRC en pause" : irc.connected ? "● IRC connecté" : "IRC déconnecté";
  pill.className = `pill ${irc.connected && !irc.paused ? "state-joined" : "state-off"}`;
  pill.setAttribute("aria-pressed", String(irc.paused));
  pill.title = irc.paused
    ? "IRC en pause : aucun chat rejoint. Clique pour reconnecter."
    : `${irc.connected ? `Connecté en tant que ${irc.username}\n` : ""}${irc.lastError ? `${irc.lastError}\n` : ""}Clique pour mettre l'IRC en pause (quitte tous les chats).`;

  const liveError = lastStatus.live.lastError ? `\n⚠ Statut live indisponible : ${lastStatus.live.lastError}` : "";
  pill.title = `${counts.joined} connectées · ${counts.desired}/${limits.concurrent} rejointes · ` +
    `${counts.live} en live · ${counts.saved} enregistrées${liveError}\n\n${pill.title}`;
  pill.classList.toggle("warn", Boolean(liveError));
  const viewCounts = {
    all: counts.saved, live: counts.live, fav: counts.favorites, on: counts.enabled, off: counts.saved - counts.enabled,
    done: channels.filter((c) => c.watched).length,
    "no-epic": channels.filter((c) => !c.cards.includes("epic")).length,
    "no-legendary": channels.filter((c) => !c.cards.includes("legendary")).length,
  };
  for (const n of document.querySelectorAll("[data-count]")) n.textContent = String(viewCounts[n.dataset.count] ?? "");
  renderSettings();
  renderProfiles();
  renderDormantCard();
  if (dialog.name) renderDialogHeader();
  renderAddButton();
  renderTokenBanner(lastStatus.token);

  const shown = visibleChannels();
  const scope = scopeLabel();
  $("all-on").textContent = scope ? `Activer ${scope}` : "Tout activer";
  $("all-off").textContent = scope ? `Désactiver ${scope}` : "Tout désactiver";
  $("all-on").disabled = !shown.some((c) => !c.enabled);
  $("all-off").disabled = !shown.some((c) => c.enabled);
  const liveOnlyCount = shown.filter((c) => c.liveOnly).length;
  const current = !shown.length ? ""
    : liveOnlyCount === 0 ? "toutes rejointes en permanence"
    : liveOnlyCount === shown.length ? "toutes rejointes seulement pendant leur live"
    : `${liveOnlyCount} seulement en live, ${shown.length - liveOnlyCount} en permanence`;
  $("bulk-scope").textContent = `Actions sur ${scope ?? "toutes les chaînes"} (${shown.length})`;
  $("mode-current").textContent = current;
  $("mode-always").disabled = liveOnlyCount === 0;
  $("mode-live").disabled = liveOnlyCount === shown.length;
  $("mode-always").classList.toggle("current", shown.length > 0 && liveOnlyCount === 0);
  $("mode-live").classList.toggle("current", shown.length > 0 && liveOnlyCount === shown.length);

  const list = $("channels");
  list.replaceChildren();

  if (shown.length === 0) {
    const text = !channels.length ? "Aucune chaîne enregistrée"
      : view === "fav" && !counts.favorites ? "Aucun favori : clique sur ☆ à côté d'une chaîne"
      : view === "live" ? "Aucune chaîne en live pour le moment"
      : "Aucune chaîne dans cette vue";
    list.append(el("li", { class: "empty" }, text));
    return;
  }

  for (const channel of shown) list.append(renderChannel(channel));
}

function renderChannel(channel) {
  const isBusy = busy.has(channel.name);

  const star = el("button", {
    class: `star${channel.favorite ? " is-fav" : ""}`,
    disabled: isBusy,
    "aria-pressed": String(channel.favorite),
    "aria-label": `${channel.name} en favori`,
    title: channel.favorite ? "Retirer des favoris" : "Ajouter aux favoris",
    onclick: () => act("/channels/favorite", [channel.name], { favorite: !channel.favorite }),
  }, channel.favorite ? "★" : "☆");

  const seen = el("button", {
    class: `seen${channel.watched ? " is-seen" : ""}`,
    disabled: isBusy,
    "aria-pressed": String(channel.watched),
    "aria-label": `${channel.name} assez regardée aujourd'hui`,
    title: channel.watched
      ? `Finie pour aujourd'hui : chat quitté et chaîne reléguée jusqu'à ${RESET_AT} (clic : annuler)`
      : `Finie pour aujourd'hui : quitter le chat et la reléguer en bas jusqu'à ${RESET_AT}`,
    onclick: () => act("/channels/watched", [channel.name], { watched: !channel.watched }),
  }, "✓");

  const box = el("input", {
    type: "checkbox",
    role: "switch",
    checked: channel.enabled,
    disabled: isBusy,
    "aria-label": `Activer ${channel.name}`,
    onchange: (e) => act(e.target.checked ? "/channels/join" : "/channels/part", [channel.name]),
  });
  const toggle = el("label", { class: "switch" }, box, el("span"));

  // Ligne 1 : nom (ouvre la fiche) + badge live + lien Twitch
  const badge = channel.live && el("span", {
    class: "live-badge",
    title: `En live depuis ${formatDuration(channel.live.startedAt)}`,
  }, el("span", { class: "live-tag" }, "LIVE"), viewers.format(channel.live.viewers),
  el("span", { class: "live-dur" }, ` · ${shortDuration(channel.live.startedAt)}`));
  const fresh = channel.live && Date.now() - Date.parse(channel.live.startedAt) < NEW_LIVE_MS &&
    el("span", { class: "new-badge", title: "Live commencé il y a moins de 15 minutes" }, "nouveau");
  // Drop il y a moins de 30 min : pas de nouveau drop possible avant la fin de l'attente
  const wait = channel.lastDrop && Math.ceil((Date.parse(channel.lastDrop) + DROP_COOLDOWN_MS - Date.now()) / 60_000);
  const dropped = wait > 0 && el("span", {
    class: `drop-badge${channel.live ? "" : " is-off"}`,
    title: `Drop à ${new Date(channel.lastDrop).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} : pas de nouveau drop possible avant ${wait} min`,
  }, el("span", { class: "drop-icon" }, "🎁"), el("span", { class: "drop-wait" }, ` ${wait} min`));

  const sanction = channel.sanction && el("span", {
    class: `sanction-badge ${channel.sanction.type}`,
    title: channel.sanction.type === "ban"
      ? `Ton compte est banni de ce chat depuis le ${new Date(channel.sanction.at).toLocaleString()}`
      : `Timeout jusqu'à ${new Date(channel.sanction.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  }, channel.sanction.type === "ban" ? "⛔ banni" : "⏱ timeout");

  const head = el("div", { class: "head" },
    el("button", {
      class: "open",
      title: `Chat, stats et réglages de ${channel.name}`,
      onclick: () => openChannel(channel.name),
    }, channel.name),
    badge,
    fresh,
    dropped,
    sanction,
    ...CARDS.filter((card) => channel.cards.includes(card.rarity)).map((card) =>
      el("span", { class: `card-badge ${card.rarity}`, title: `Carte streamer ${card.label.toLowerCase()} obtenue` }, card.label)),
    channel.watched && el("span", { class: "seen-badge", title: `Finie pour aujourd'hui : chat quitté jusqu'à ${RESET_AT}` }, "fini"),
    el("a", {
      class: "twitch-link",
      href: `https://www.twitch.tv/${encodeURIComponent(channel.name)}`,
      target: "_blank",
      rel: "noopener noreferrer",
      title: `Ouvrir ${channel.name} sur Twitch`,
      "aria-label": `Ouvrir ${channel.name} sur Twitch`,
    }, externalIcon()));

  // Ligne 2 : catégorie et titre du live
  const liveLine = channel.live && el("span", {
    class: "live-line",
    title: `${channel.live.game} — ${channel.live.title}`,
  }, el("span", { class: "live-game" }, channel.live.game || "Sans catégorie"),
  el("span", { class: "live-title" }, ` · ${channel.live.title}`));

  // Ligne 2 bis (hors live) : date du dernier live connu
  const lastLiveLine = !channel.live && channel.lastLive && el("span", {
    class: "last-live",
    title: new Date(channel.lastLive).toLocaleString(),
  }, `Dernier live : ${formatLastLive(channel.lastLive)}`);

  // Ligne 3 : dernier message reçu
  const last = channel.lastMessage;
  let message = null;
  if (last) {
    message = el("span", { class: "last", title: `${last.user} : ${last.text}` },
      el("time", { dateTime: last.at }, formatAge(last.ageSeconds)),
      " · ", el("strong", {}, last.user), ` : ${last.text}`);
  }

  // Ligne 4 : seulement les exceptions — mode « toujours » (24/7) et groupes. Le mode « si live »,
  // le plus courant, n'est plus affiché. Sur ordinateur, modifiables ici ; sur téléphone, dans la fiche.
  const modeTag = !channel.liveOnly && el("button", {
    class: "tag mode",
    disabled: isBusy,
    title: "Rejoint le chat tout le temps (clic : seulement pendant le live)",
    onclick: () => act("/channels/mode", [channel.name], { liveOnly: true }),
  }, "24/7");
  const groupTags = channel.groups.map((group) => el("button", {
    class: "tag group",
    disabled: isBusy,
    title: `Retirer ${channel.name} du groupe « ${group} »`,
    onclick: () => {
      if (confirm(`Retirer ${channel.name} du groupe « ${group} » ?`)) {
        act("/channels/group", [channel.name], { group, member: false });
      }
    },
  }, group));
  // Sur la ligne du nom, pour ne pas ajouter de ligne ; « + groupe » visible au survol (ordinateur)
  head.append(...[modeTag, ...groupTags].filter(Boolean), el("button", {
    class: "tag add desktop-only",
    disabled: isBusy,
    title: `Ajouter ${channel.name} à un groupe`,
    onclick: () => {
      const existing = lastStatus.groups.map((g) => g.name).filter((g) => !channel.groups.includes(g));
      const hint = existing.length ? `Groupes existants : ${existing.join(", ")}
` : "";
      const group = prompt(`${hint}Nom du groupe pour ${channel.name} :`, existing[0] ?? "");
      if (group && group.trim()) act("/channels/group", [channel.name], { group: group.trim(), member: true });
    },
  }, "+ groupe"));

  const name = el("div", { class: "name" }, head, liveLine, lastLiveLine, message);

  const remove = el("button", {
    class: "remove desktop-only",
    title: "Retirer de la liste",
    "aria-label": `Retirer ${channel.name} de la liste`,
    onclick: () => {
      if (confirm(`Retirer ${channel.name} de la liste ?`)) act("/channels/remove", [channel.name]);
    },
  }, "×");

  const state = el("span", {
    class: `detail state-${channel.state}`,
    title: channel.reason
      ? `${channel.reason}, nouvel essai à ${new Date(channel.retryAt).toLocaleTimeString()}`
      : STATE_HINTS[channel.state] ?? "",
  }, el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "label" }, LABELS[channel.state] || channel.state));

  const classes = [channel.enabled ? "on" : "off", channel.live ? "live" : "idle", channel.watched && "watched",
    dialog.name === channel.name && "selected"];
  return el("li", {
    class: classes.filter(Boolean).join(" "),
    onclick: (e) => {
      if (e.target.closest("button, a, input, label") || getSelection().toString()) return;
      openChannel(channel.name);
    },
  }, star, seen, toggle, avatar(channel), name, state, remove);
}

// Pastille à l'initiale de la chaîne, teinte stable dérivée du nom, anneau rouge pendant le live
function avatar(channel) {
  let hash = 0;
  for (const ch of channel.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const node = el("span", { class: `avatar${channel.live ? " is-live" : ""}`, "aria-hidden": "true" },
    channel.name[0].toUpperCase(),
    channel.avatar && el("img", { src: channel.avatar, alt: "", loading: "lazy", decoding: "async" }));
  node.style.setProperty("--hue", String(hash % 360)); // CSSOM : autorisé par la CSP
  return node;
}

// --- Fiche d'une chaîne : chat, stats, réglages ---

const dialog = { name: null, tab: "settings", lastId: 0, timer: null, statsFor: null };

// Écran large : la fiche s'ouvre en panneau à droite, la liste reste utilisable à côté
const wideScreen = matchMedia("(min-width: 1100px)");

function channelByName(name) {
  return lastStatus?.channels.find((c) => c.name === name) ?? null;
}

function openChannel(name, tab = dialog.name ? dialog.tab : "settings") {
  dialog.name = name;
  dialog.lastId = 0;
  dialog.statsFor = null;
  $("chat-log").replaceChildren();
  renderDialogHeader();
  showTab(tab);
  const box = $("channel-dialog");
  if (!box.open) {
    if (wideScreen.matches) box.show();
    else box.showModal();
    // Focus sur la fiche elle-même plutôt que sur le premier lien (pas de cadre de focus parasite)
    document.querySelector("#channel-dialog .dlg").focus();
  }
  document.body.classList.toggle("panel-open", !box.matches(":modal"));
  render();
}

function closeChannel() {
  clearInterval(dialog.timer);
  dialog.name = null;
  if ($("channel-dialog").open) $("channel-dialog").close();
}

function renderDialogHeader() {
  const channel = channelByName(dialog.name);
  if (!channel) return closeChannel();
  $("dlg-title").replaceChildren(...[
    el("span", {}, channel.name),
    channel.live && el("span", { class: "live-badge" }, el("span", { class: "live-tag" }, "LIVE"), viewers.format(channel.live.viewers)),
  ].filter(Boolean));
  $("dlg-twitch").href = `https://www.twitch.tv/${encodeURIComponent(channel.name)}`;
  $("dlg-sub").textContent = channel.live
    ? `${channel.live.game || "Sans catégorie"} · ${channel.live.title}`
    : `${LABELS[channel.state] ?? channel.state}${channel.enabled ? "" : " (désactivée)"}` +
      (channel.lastLive ? ` · dernier live ${formatAge(Math.round((Date.now() - new Date(channel.lastLive)) / 1000))}` : "");
  if (dialog.tab === "settings" && !$("tab-settings").contains(document.activeElement)) renderChannelSettings(channel);
}

function showTab(tab) {
  dialog.tab = tab;
  for (const b of document.querySelectorAll("#channel-dialog [data-tab]")) {
    const active = b.dataset.tab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  }
  for (const p of document.querySelectorAll("#channel-dialog .tab-panel")) p.hidden = p.id !== `tab-${tab}`;

  clearInterval(dialog.timer);
  if (tab === "chat") {
    loadChat();
    dialog.timer = setInterval(loadChat, 2000);
  } else if (tab === "stats") {
    loadStats();
  } else {
    renderChannelSettings(channelByName(dialog.name));
  }
}

// Mini-chat : ajoute les nouveaux messages et reste collé en bas si on y était déjà
async function loadChat() {
  const name = dialog.name;
  if (!name) return;
  try {
    const data = await api(`/channels/${encodeURIComponent(name)}/messages?after=${dialog.lastId}`);
    if (name !== dialog.name) return;
    const log = $("chat-log");
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    $("chat-note").hidden = data.joined;
    $("chat-note").textContent = data.joined ? "" : "Chat non rejoint en ce moment : seuls les messages déjà reçus s'affichent.";

    const me = lastStatus?.irc.username;
    for (const m of data.messages) {
      const mention = me && new RegExp(`(^|\\W)@?${me}(\\W|$)`, "i").test(m.text);
      log.append(el("li", { class: `msg${mention ? " mention" : ""}${m.action ? " action" : ""}` },
        el("time", { dateTime: new Date(m.at).toISOString() }, new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
        colored(el("strong", {}, m.user), m.color),
        el("span", {}, m.text)));
      dialog.lastId = m.id;
    }
    while (log.children.length > 200) log.firstChild.remove();
    if (!log.children.length) log.append(el("li", { class: "msg empty" }, "Aucun message pour le moment"));
    else log.querySelector(".empty")?.remove();
    if (atBottom || data.messages.length === log.children.length) log.scrollTop = log.scrollHeight;
  } catch (err) {
    showError(err);
  }
}

// Couleur de pseudo via CSSOM (les attributs style sont bloqués par la CSP)
function colored(node, color) {
  if (color) node.style.color = color;
  return node;
}

// --- Statistiques ---

async function loadStats() {
  const name = dialog.name;
  const box = $("tab-stats");
  box.replaceChildren(el("p", { class: "hint" }, "Chargement…"));
  try {
    const data = await api(`/channels/${encodeURIComponent(name)}/stats`);
    if (name !== dialog.name) return;
    renderStats(data);
  } catch (err) {
    box.replaceChildren(el("p", { class: "error" }, err.message));
  }
}

function renderStats({ summary, sessions, samples, sampleMinutes }) {
  const box = $("tab-stats");
  if (!samples.length) {
    box.replaceChildren(el("p", { class: "hint" },
      "Pas encore de statistiques : elles s'accumulent pendant les lives (un relevé toutes les 5 minutes, 7 jours gardés)."));
    return;
  }
  const fmt = (v, unit = "") => (v === null || v === undefined ? "—" : `${viewers.format(v)}${unit}`);
  const tile = (label, value) => el("div", { class: "tile" }, el("span", { class: "tile-value" }, value), el("span", { class: "tile-label" }, label));

  const msgSamples = samples.filter((s) => s.m !== null).map((s) => ({ t: s.t, v: Math.round((s.m / sampleMinutes) * 10) / 10 }));

  box.replaceChildren(
    el("div", { class: "tiles" },
      tile("heures de live (7 j)", fmt(summary.liveHours, " h")),
      tile("lives", fmt(summary.sessions)),
      tile("pic de spectateurs", fmt(summary.peakViewers)),
      tile("spectateurs en moyenne", fmt(summary.avgViewers)),
      tile("messages / minute", fmt(summary.messagesPerMinute)),
      tile("dernier live", summary.lastLive ? new Date(summary.lastLive).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) : "—")),
    lineChart("Spectateurs", samples.map((s) => ({ t: s.t, v: s.v })), (v) => `${viewers.format(v)} spectateurs`),
    msgSamples.length
      ? lineChart("Messages par minute", msgSamples, (v) => `${v} msg/min`)
      : el("p", { class: "hint" }, "Messages par minute : disponibles uniquement quand le chat est rejoint pendant le live."),
    el("details", { class: "sessions" },
      el("summary", {}, `Lives des 7 derniers jours (${sessions.length})`),
      el("table", {},
        el("thead", {}, el("tr", {}, el("th", {}, "Début"), el("th", {}, "Durée"), el("th", {}, "Pic"))),
        el("tbody", {}, ...sessions.slice().reverse().map((s) => el("tr", {},
          el("td", {}, new Date(s.start).toLocaleString([], { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })),
          el("td", {}, `${s.hours} h`),
          el("td", {}, viewers.format(s.peak))))))));
}

// Courbe d'une seule série sur 7 jours : trait de 2px, aire légère, grille discrète,
// coupures entre les lives, curseur + infobulle au survol (ou au toucher).
function lineChart(title, points, describe) {
  const ns = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => {
    const n = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  const W = 640, H = 180, L = 44, R = 8, T = 10, B = 24;
  const now = Date.now();
  const t0 = now - 7 * 24 * 3600_000;
  const max = Math.max(1, ...points.map((p) => p.v));
  const niceMax = (() => { const p = 10 ** Math.floor(Math.log10(max)); return Math.ceil(max / p) * p; })();
  const x = (t) => L + ((t - t0) / (now - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / niceMax) * (H - T - B);

  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": `${title} sur 7 jours` });

  // Grille horizontale et graduations
  for (const f of [0, 0.5, 1]) {
    const v = niceMax * f;
    svg.append(svgEl("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }));
    const label = svgEl("text", { x: L - 6, y: y(v) + 4, class: "axis", "text-anchor": "end" });
    label.textContent = viewers.format(v);
    svg.append(label);
  }
  // Un repère par jour
  for (let d = 0; d <= 7; d++) {
    const t = new Date(now - (7 - d) * 24 * 3600_000);
    if (d % 2) continue;
    const label = svgEl("text", { x: x(t.getTime()), y: H - 6, class: "axis", "text-anchor": d === 0 ? "start" : d === 7 ? "end" : "middle" });
    label.textContent = d === 7 ? "maint." : t.toLocaleDateString([], { weekday: "short" });
    svg.append(label);
  }

  // Segments : une coupure de plus de 20 min sépare deux lives
  const segments = [];
  for (const p of points) {
    const seg = segments.at(-1);
    if (!seg || p.t - seg.at(-1).t > 20 * 60_000) segments.push([p]);
    else seg.push(p);
  }
  for (const seg of segments) {
    const line = seg.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    if (seg.length > 1) {
      svg.append(svgEl("path", { d: `${line}L${x(seg.at(-1).t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`, class: "area" }));
      svg.append(svgEl("path", { d: line, class: "line" }));
    } else {
      svg.append(svgEl("circle", { cx: x(seg[0].t), cy: y(seg[0].v), r: 3, class: "dot-mark" }));
    }
  }

  // Survol : point le plus proche, ligne verticale et infobulle
  const cross = svgEl("line", { y1: T, y2: H - B, class: "cross", visibility: "hidden" });
  const marker = svgEl("circle", { r: 4, class: "marker", visibility: "hidden" });
  svg.append(cross, marker);
  const tip = el("div", { class: "chart-tip", hidden: true });

  const wrap = el("figure", { class: "chart-box" }, el("figcaption", {}, title), svg, tip);
  const hide = () => { cross.setAttribute("visibility", "hidden"); marker.setAttribute("visibility", "hidden"); tip.hidden = true; };
  svg.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect();
    const t = t0 + (((e.clientX - box.left) / box.width) * W - L) / (W - L - R) * (now - t0);
    let best = null;
    for (const p of points) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (!best || Math.abs(best.t - t) > 3 * 3600_000) return hide();
    const px = x(best.t), py = y(best.v);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    marker.setAttribute("cx", px); marker.setAttribute("cy", py); marker.setAttribute("visibility", "visible");
    tip.textContent = `${new Date(best.t).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${describe(best.v)}`;
    tip.hidden = false;
    // Centrée sur le point, mais toujours entièrement dans le cadre
    const half = tip.offsetWidth / 2;
    const left = (px / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, half), box.width - half)}px`;
  });
  svg.addEventListener("pointerleave", hide);
  return wrap;
}

// --- Réglages d'une chaîne ---

function renderChannelSettings(channel) {
  if (!channel) return;
  const box = $("tab-settings");
  const isBusy = busy.has(channel.name);
  const run = (path, extra) => act(path, [channel.name], extra).then(() => {
    renderDialogHeader();
    renderChannelSettings(channelByName(channel.name));
  });

  const modeBtn = (liveOnly, label) => el("button", {
    type: "button",
    class: channel.liveOnly === liveOnly ? "active" : "",
    "aria-pressed": String(channel.liveOnly === liveOnly),
    disabled: isBusy,
    title: channel.enabled ? "" : "Active aussi la chaîne",
    onclick: () => !channel.enabled ? run("/channels/join", { liveOnly })
      : channel.liveOnly !== liveOnly && run("/channels/mode", { liveOnly }),
  }, label);

  const groupInput = el("input", { list: "group-list", placeholder: "Nouveau groupe ou groupe existant", autocomplete: "off" });
  const datalist = el("datalist", { id: "group-list" },
    ...lastStatus.groups.map((g) => el("option", { value: g.name })));

  // Aperçu du live en cours (le détail sur 7 jours est dans l'onglet Stats)
  const last = channel.lastMessage;
  const tile = (value, label) => el("div", { class: "tile" },
    el("span", { class: "tile-value" }, value), el("span", { class: "tile-label" }, label));
  const thumb = channel.live?.thumbnail && el("a", {
    class: "live-thumb",
    href: `https://www.twitch.tv/${encodeURIComponent(channel.name)}`,
    target: "_blank",
    rel: "noopener noreferrer",
    title: `Ouvrir ${channel.name} sur Twitch`,
  }, el("img", { src: thumbnailUrl(channel.live.thumbnail), alt: `Aperçu du live de ${channel.name}`, width: "440", height: "248" }));
  const overview = channel.live
    ? el("div", { class: "tiles" },
      tile(viewers.format(channel.live.viewers), "spectateurs"),
      tile(formatDuration(channel.live.startedAt), "en live depuis"),
      tile(last ? formatAge(last.ageSeconds).replace("il y a ", "") : "—", "dernier message"))
    : el("p", { class: "hint overview-off" }, channel.lastLive
      ? `Hors live · dernier live ${formatLastLive(channel.lastLive)}`
      : "Hors live");

  box.replaceChildren(...[
    thumb,
    overview,
    el("div", { class: "field" },
      el("span", { class: "field-label" }, "Activée"),
      el("label", { class: "switch" },
        el("input", {
          type: "checkbox", role: "switch", checked: channel.enabled, disabled: isBusy,
          "aria-label": "Activer la chaîne",
          onchange: (e) => run(e.target.checked ? "/channels/join" : "/channels/part"),
        }),
        el("span"))),
    el("div", { class: "field" },
      el("span", { class: "field-label" }, "Favori"),
      el("button", {
        type: "button", class: `star big${channel.favorite ? " is-fav" : ""}`, disabled: isBusy,
        "aria-pressed": String(channel.favorite),
        onclick: () => run("/channels/favorite", { favorite: !channel.favorite }),
      }, channel.favorite ? "★ favori" : "☆ ajouter aux favoris")),
    el("div", { class: "field" },
      el("span", { class: "field-label" }, "Finie pour aujourd'hui"),
      el("button", {
        type: "button", class: `seen big${channel.watched ? " is-seen" : ""}`, disabled: isBusy,
        "aria-pressed": String(channel.watched),
        title: `Quitte le chat et relègue la chaîne en bas de la liste. Remise à zéro chaque jour à ${RESET_AT}`,
        onclick: () => run("/channels/watched", { watched: !channel.watched }),
      }, channel.watched ? `✓ finie jusqu'à ${RESET_AT}` : "marquer comme finie")),
    el("div", { class: "field" },
      el("span", { class: "field-label" }, "Carte streamer"),
      el("div", { class: "row" }, ...CARDS.map((card) => {
        const owned = channel.cards.includes(card.rarity);
        return el("button", {
          type: "button", class: `card big ${card.rarity}${owned ? " is-owned" : ""}`, disabled: isBusy,
          "aria-pressed": String(owned),
          title: owned ? `Carte ${card.label.toLowerCase()} obtenue (clic : retirer)` : `Noter la carte ${card.label.toLowerCase()} comme obtenue`,
          onclick: () => run("/channels/card", { rarity: card.rarity, owned: !owned }),
        }, `${owned ? "☑" : "☐"} ${card.label}`);
      }))),
    el("div", { class: "field column" },
      el("span", { class: "field-label" }, "Quand rejoindre le chat"),
      el("div", { class: "segmented" }, modeBtn(false, "Toujours"), modeBtn(true, "Seulement en live"))),
    el("div", { class: "field column" },
      el("span", { class: "field-label" }, "Groupes"),
      el("div", { class: "chips" },
        ...channel.groups.map((g) => el("button", {
          type: "button", class: "chip removable", disabled: isBusy,
          title: `Retirer du groupe « ${g} »`,
          onclick: () => run("/channels/group", { group: g, member: false }),
        }, `${g} ×`)),
        !channel.groups.length && el("span", { class: "hint" }, "Aucun groupe")),
      el("form", {
        class: "row",
        onsubmit: (e) => {
          e.preventDefault();
          const group = groupInput.value.trim();
          if (group) run("/channels/group", { group, member: true });
        },
      }, groupInput, datalist, el("button", { disabled: isBusy }, "Ajouter"))),
    el("div", { class: "field danger" },
      el("button", {
        type: "button", class: "ghost danger-btn", disabled: isBusy,
        onclick: () => {
          if (confirm(`Retirer ${channel.name} de la liste ? (favori, groupes et statistiques seront perdus)`)) {
            act("/channels/remove", [channel.name]);
            closeChannel();
          }
        },
      }, "Retirer de la liste")),
  ].filter(Boolean));
}

function renderGroupTabs() {
  const container = $("group-tabs");
  container.replaceChildren();
  for (const group of lastStatus.groups) {
    const active = view === `group:${group.name}`;
    container.append(el("button", {
      type: "button",
      class: `chip${active ? " active" : ""}`,
      "aria-pressed": String(active),
      onclick: () => setView(active ? "all" : `group:${group.name}`),
    }, `${group.name} · ${group.count}`));
  }
  container.hidden = lastStatus.groups.length === 0;
  $("group-sep").hidden = container.hidden;
}

function setView(value) {
  view = value;
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("active", b.dataset.view === view);
  try { localStorage.setItem(VIEW_KEY, view); } catch {}
  render();
}

// --- Réglages ---

function renderSettings() {
  const input = $("max-concurrent");
  input.max = String(lastStatus.limits.active);
  // Ne pas écraser ce que l'utilisateur est en train de taper
  if (document.activeElement !== input) input.value = String(lastStatus.settings.maxConcurrent);

  const waiting = lastStatus.channels.filter((c) => c.state === "full").length;
  $("settings-status").textContent = waiting
    ? `${waiting} chaîne(s) en live attendent une place à cause du plafond.`
    : "";

  const s = lastStatus.settings;
  $("discord-webhook").placeholder = s.discordWebhookSet
    ? "Webhook configuré ✓ (colle une nouvelle adresse pour le remplacer)"
    : "https://discord.com/api/webhooks/…";
  $("discord-test").disabled = !s.discordWebhookSet;
  $("discord-remove").disabled = !s.discordWebhookSet;
  if (document.activeElement !== $("discord-user-id")) $("discord-user-id").value = s.discordUserId;
  const keywordsInput = $("mention-keywords");
  if (document.activeElement !== keywordsInput) keywordsInput.value = s.mentionKeywords.join(", ");
  keywordsInput.placeholder = `${lastStatus.irc.username ?? "ton pseudo"} (par défaut)`;
  if (document.activeElement !== $("live-alerts")) $("live-alerts").value = s.discordLiveAlerts;
  if (!$("discord-form").contains(document.activeElement)) {
    $("quiet-enabled").checked = s.quietHours.enabled;
    $("quiet-start").value = s.quietHours.start;
    $("quiet-end").value = s.quietHours.end;
  }
  const sc = lastStatus.sanctions;
  $("sanctions-count").textContent = sc.active ? `⚠ ${sc.active}` : "";
  $("sanctions-count").title = sc.active ? `${sc.active} sanction(s) en cours` : "";

  // Plage horaire (ne pas écraser pendant la saisie)
  if (!$("schedule-form").contains(document.activeElement)) {
    $("schedule-enabled").checked = s.schedule.enabled;
    $("schedule-start").value = s.schedule.start;
    $("schedule-end").value = s.schedule.end;
    $("schedule-tz").value = s.schedule.timeZone;
  }
  const waitingSchedule = lastStatus.channels.filter((c) => c.state === "schedule").length;
  $("schedule-status").textContent = !s.schedule.enabled
    ? "Désactivée : les chaînes « si live » sont rejointes à toute heure."
    : `${s.scheduleOpen ? "🟢 Dans la plage" : "🌙 Hors plage"} (${s.schedule.start} → ${s.schedule.end}, ${s.schedule.timeZone})` +
      (waitingSchedule ? ` · ${waitingSchedule} live(s) en attente de la plage` : "");

  const b = lastStatus.backups;
  $("backup-status").textContent = b.latest
    ? `Sauvegardes de la liste : ${b.count} gardée(s) sur le serveur (max ${b.keep}), dernière le ${new Date(b.latest).toLocaleString()}.`
    : "Sauvegardes de la liste : aucune pour le moment.";
}

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const value = Number($("max-concurrent").value);
  const button = e.submitter;
  button.disabled = true;
  $("error").textContent = "";
  try {
    await api("/settings", { maxConcurrent: value });
    $("max-concurrent").blur();
    await refresh();
    $("settings-status").textContent = `Plafond enregistré : ${value} chat(s) en même temps.`;
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
});

async function saveDiscord(body, message) {
  $("discord-status").textContent = "";
  $("error").textContent = "";
  try {
    await api("/settings", body);
    $("discord-webhook").value = "";
    document.activeElement?.blur();
    await refresh();
    $("discord-status").textContent = message;
  } catch (err) {
    if (err.message !== "auth") $("discord-status").textContent = `⚠ ${err.message}`;
  }
}

$("discord-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const body = {
    mentionKeywords: $("mention-keywords").value.split(/[,;\n]+/).map((k) => k.trim()).filter(Boolean),
    discordUserId: $("discord-user-id").value.trim(),
    discordLiveAlerts: $("live-alerts").value,
    quietHours: {
      enabled: $("quiet-enabled").checked,
      start: $("quiet-start").value,
      end: $("quiet-end").value,
      timeZone: lastStatus.settings.quietHours.timeZone,
    },
  };
  const webhook = $("discord-webhook").value.trim();
  if (webhook) body.discordWebhook = webhook;
  saveDiscord(body, "Réglages Discord enregistrés. Clique sur « Envoyer un test » pour vérifier.");
});

$("schedule-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("schedule-status").textContent = "";
  try {
    await api("/settings", {
      schedule: {
        enabled: $("schedule-enabled").checked,
        start: $("schedule-start").value,
        end: $("schedule-end").value,
        timeZone: $("schedule-tz").value.trim() || "Europe/Paris",
      },
    });
    document.activeElement?.blur();
    await refresh();
  } catch (err) {
    if (err.message !== "auth") $("schedule-status").textContent = `⚠ ${err.message}`;
  }
});

// --- Chaînes endormies : suggestion de nettoyage ---

function renderDormantCard() {
  const d = lastStatus.dormant;
  const show = d.count > 0 && !d.snoozed;
  $("dormant-badge").hidden = !show;
  $("dormant-badge").textContent = String(d.count);
  $("open-settings").title = show
    ? `Réglages · ${d.count} chaîne(s) sans live depuis ${d.days} jours ou plus`
    : "Réglages";
  if (document.activeElement !== $("dormant-days")) $("dormant-days").value = String(d.days);
}

function selectedDormant() {
  return [...document.querySelectorAll("#dormant-list input:checked")].map((i) => i.value);
}

function updateDormantButtons() {
  const n = selectedDormant().length;
  $("dormant-remove").textContent = `Retirer la sélection (${n})`;
  $("dormant-remove").disabled = !n;
  $("dormant-disable").disabled = !n;
}

async function openDormant() {
  $("dormant-status").textContent = "";
  $("dormant-list").replaceChildren(el("li", { class: "hint" }, "Chargement…"));
  if (!$("dormant-dialog").open) $("dormant-dialog").showModal();
  document.querySelector("#dormant-dialog .dlg").focus();
  try {
    const d = await api("/maintenance/dormant");
    $("dormant-sub").textContent = `Sans live depuis ${d.days} jours ou plus`;
    if (!d.channels.length) {
      $("dormant-list").replaceChildren(el("li", { class: "hint" }, "Aucune chaîne endormie : ta liste est propre ✨"));
      $("dormant-all").disabled = true;
      updateDormantButtons();
      return;
    }
    $("dormant-all").disabled = false;
    $("dormant-all").checked = true;
    $("dormant-list").replaceChildren(...d.channels.map((c) => el("li", {},
      el("label", { class: "check" },
        el("input", { type: "checkbox", value: c.name, checked: true, onchange: updateDormantButtons }),
        el("span", {},
          el("strong", {}, c.name),
          el("span", { class: "hint" }, c.lastLive
            ? ` · dernier live il y a ${c.days} j${c.source === "vod" ? " (d'après les VOD)" : ""}`
            : ` · ${c.reason}`))),
      el("button", {
        type: "button", class: "ghost small",
        title: "Ne plus jamais proposer cette chaîne",
        onclick: async (e) => {
          e.target.disabled = true;
          await api("/maintenance/dormant/keep", { channels: [c.name], keep: true }).catch(showError);
          e.target.closest("li").remove();
          updateDormantButtons();
          refresh();
        },
      }, "Garder"))));
    updateDormantButtons();
  } catch (err) {
    $("dormant-list").replaceChildren(el("li", { class: "error" }, err.message));
  }
}

async function dormantBulk(path, verb) {
  const names = selectedDormant();
  if (!names.length || !confirm(`${verb} ${names.length} chaîne(s) ?\n${names.join(", ")}`)) return;
  try {
    await api(path, { channels: names });
    $("dormant-status").textContent = `${names.length} chaîne(s) : c'est fait ✓`;
    await refresh();
    openDormant();
  } catch (err) {
    showError(err);
  }
}

$("dormant-open-2").addEventListener("click", openDormant);
$("dormant-close").addEventListener("click", () => $("dormant-dialog").close());
$("dormant-dialog").addEventListener("click", (e) => { if (e.target === $("dormant-dialog")) $("dormant-dialog").close(); });
$("dormant-all").addEventListener("change", (e) => {
  for (const i of document.querySelectorAll("#dormant-list input[type=checkbox]")) i.checked = e.target.checked;
  updateDormantButtons();
});
$("dormant-remove").addEventListener("click", () => dormantBulk("/channels/remove", "Retirer de la liste"));
$("dormant-disable").addEventListener("click", () => dormantBulk("/channels/part", "Désactiver"));

$("dormant-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/maintenance/dormant/days", { days: Number($("dormant-days").value) });
    document.activeElement?.blur();
    await refresh();
  } catch (err) {
    showError(err);
  }
});

async function loadDormantKept() {
  try {
    const d = await api("/maintenance/dormant");
    const box = $("dormant-kept");
    if (!d.kept.length) return box.replaceChildren("Aucune chaîne gardée.");
    box.replaceChildren("Chaînes gardées (jamais proposées) : ", ...d.kept.map((n) => el("button", {
      type: "button", class: "chip removable", title: `Proposer de nouveau ${n} au nettoyage`,
      onclick: async () => {
        await api("/maintenance/dormant/keep", { channels: [n], keep: false }).catch(showError);
        loadDormantKept();
        refresh();
      },
    }, `${n} ×`)));
  } catch (err) {
    showError(err);
  }
}


// --- Sanctions de ton compte ---

async function loadSanctions() {
  try {
    const { sanctions } = await api("/sanctions");
    const list = $("sanction-list");
    if (!sanctions.length) return list.replaceChildren(el("li", { class: "hint" }, "Aucune sanction reçue 👍"));
    const now = Date.now();
    list.replaceChildren(...sanctions.map((x) => {
      const active = !x.cleared && (x.type === "ban" || Date.parse(x.until) > now);
      return el("li", { class: active ? "" : "past" },
        el("div", {},
          el("strong", {}, `${x.type === "ban" ? "⛔ Ban" : `⏱ Timeout ${formatSeconds(x.duration)}`} sur #${x.channel}`),
          el("div", { class: "hint" }, new Date(x.at).toLocaleString() +
            (x.cleared ? " · marqué comme levé" : x.type === "timeout" ? ` · jusqu'à ${new Date(x.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · en cours"))),
        x.type === "ban" && !x.cleared && el("button", {
          type: "button", class: "ghost small",
          title: "Si tu as été débanni : la chaîne n'affichera plus le badge",
          onclick: async () => {
            await api("/sanctions/clear", { id: x.id }).catch(showError);
            loadSanctions();
            refresh();
          },
        }, "Marquer comme levé"));
    }));
  } catch (err) {
    showError(err);
  }
}

function formatSeconds(s) {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}



// --- Radar à drops ChatDeck ---

const shortDate = (iso) => new Date(iso).toLocaleString([], { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const liveMoment = (minute) => minute === null ? "hors live"
  : minute < 60 ? `${minute} min de live` : `${Math.floor(minute / 60)} h ${String(minute % 60).padStart(2, "0")} de live`;

function dropItem(d) {
  return el("li", {},
    el("div", { class: "drops-msg" },
      el("strong", {}, d.channel), " ", d.manual ? el("em", {}, "ajouté à la main") : d.text,
      el("span", { class: "hint" }, `${shortDate(d.at)} · ${liveMoment(d.minute)}${d.viewers ? ` · ${d.viewers} viewers` : ""}`)),
    el("span", { class: "hint drops-actions" }, `${d.boosters ?? "?"} booster(s)`));
}

function momentBars(c) {
  if (!c.drops) return "–";
  const max = Math.max(1, ...c.moments.map((m) => m.count));
  const bars = c.moments.map((m) => {
    const bar = el("span", { class: m.count ? "" : "zero" });
    bar.style.height = `${Math.max(2, Math.round((m.count / max) * 22))}px`;
    return bar;
  });
  return el("div", { class: "moments" }, ...bars);
}

async function openDrops() {
  if (!$("drops-dialog").open) {
    $("drops-recent").replaceChildren(el("li", { class: "hint" }, "Chargement…"));
    $("drops-dialog").showModal();
    document.querySelector("#drops-dialog .dlg").focus();
  }
  try {
    const d = await api("/drops");
    const ranked = d.channels.filter((c) => c.drops || c.presenceHours);
    $("drops-ranking").replaceChildren(...(ranked.length ? ranked.map((c) => el("tr", {},
      el("td", {}, el("strong", {}, c.channel)),
      el("td", {}, String(c.drops)),
      el("td", {}, String(c.boosters)),
      el("td", {}, `${c.presenceHours} h · ${c.presenceDays} j`),
      el("td", {}, c.perDay === null ? "–" : String(c.perDay).replace(".", ",")),
      el("td", {
        title: c.moments.map((m) => `${m.label} : ${m.count}`).join("\n")
          + (c.medianMinute !== null ? `\nMoment médian : ${liveMoment(c.medianMinute)}` : ""),
      }, momentBars(c)),
      el("td", {}, c.lastAt ? shortDate(c.lastAt) : "–")))
      : [el("tr", {}, el("td", { colspan: "7", class: "hint" }, "Pas encore de données : le radar se remplit pendant que Twitch Deck est dans les chats en live."))]));

    $("drops-recent").replaceChildren(...(d.recent.length ? d.recent.map(dropItem)
      : [el("li", { class: "hint" }, "Aucun drop repéré pour l'instant.")]));
  } catch (err) {
    if (err.message !== "auth") $("drops-recent").replaceChildren(el("li", { class: "error" }, err.message));
  }
}

// Tranches de 30 min jusqu'à 8 h, comme le graphique « Moment du live »
{
  const hm = (m) => (m % 60 ? `${Math.floor(m / 60)} h 30` : `${m / 60} h`);
  const options = Array.from({ length: 16 }, (_, i) => el("option", { value: String(i * 30 + 15) }, `${hm(i * 30)} – ${hm((i + 1) * 30)}`));
  $("drops-manual-moment").replaceChildren(...options, el("option", { value: "500" }, "> 8 h"));
}

$("drops-manual").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await api("/drops/manual", {
      channel: $("drops-manual-channel").value,
      boosters: Number($("drops-manual-boosters").value),
      minute: Number($("drops-manual-moment").value),
    });
    $("drops-manual-channel").value = "";
    await openDrops();
  } catch (err) {
    showError(err);
  }
});

$("open-drops").addEventListener("click", openDrops);
$("drops-close").addEventListener("click", () => $("drops-dialog").close());
$("drops-dialog").addEventListener("click", (e) => { if (e.target === $("drops-dialog")) $("drops-dialog").close(); });

// --- Compte Twitch de l'IRC à reconnecter (token refusé) ---

function renderTokenBanner(token) {
  const device = token?.device;
  const pending = device?.state === "pending" && Date.parse(device.expiresAt) > Date.now();
  $("token-banner").hidden = !token?.needsAuth && !pending;
  if ($("token-banner").hidden) return;

  const text = $("token-text");
  const link = $("token-link");
  const button = $("token-reconnect");
  link.hidden = !pending;
  button.hidden = !token.canReconnect || pending;
  if (pending) {
    // Le lien contient déjà le code : il suffit de valider avec le compte du bot
    link.href = device.verificationUri;
    text.textContent = "Valide ce code sur Twitch avec le compte de l'IRC : ";
    const code = document.createElement("span");
    code.className = "token-code";
    code.textContent = device.userCode;
    text.append(code);
  } else {
    const expired = device?.state === "expired" || (device?.state === "pending" && !pending);
    text.textContent = expired ? "🔌 Code expiré : l'IRC est toujours déconnecté."
      : device?.state === "error" ? `🔌 Reconnexion échouée : ${device.error}`
      : token.canReconnect ? "🔌 Compte Twitch déconnecté : l'IRC ne peut plus se connecter."
      : "🔌 Token Twitch refusé : mets à jour TWITCH_OAUTH_TOKEN sur le serveur.";
    button.textContent = "Reconnecter";
  }
}

$("token-reconnect").addEventListener("click", async () => {
  const button = $("token-reconnect");
  button.disabled = true;
  try {
    const device = await api("/auth/device", {});
    lastStatus.token = { ...lastStatus.token, device };
    renderTokenBanner(lastStatus.token);
    window.open(device.verificationUri, "_blank", "noopener");
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
});

// --- Pause de l'IRC (clic sur l'indicateur en haut) ---

$("irc").addEventListener("click", async () => {
  const pause = !lastStatus?.irc.paused;
  if (pause && !confirm("Mettre l'IRC en pause ?\nLe serveur quitte tous les chats et se déconnecte jusqu'à ce que tu cliques à nouveau.")) return;
  $("irc").disabled = true;
  try {
    await api("/irc/pause", { paused: pause });
    await refresh();
  } catch (err) {
    showError(err);
  } finally {
    $("irc").disabled = false;
  }
});

// --- Profils ---

function renderProfiles() {
  const p = lastStatus.profiles;
  const select = $("profile-select");
  if (document.activeElement !== select) {
    select.replaceChildren(
      el("option", { value: "" }, p.names.length ? "— aucun —" : "aucun profil"),
      ...p.names.map((n) => el("option", { value: n }, n)));
    select.value = p.active ?? "";
  }
  select.disabled = !p.names.length;
  $("profile-state").textContent = p.active && p.modified ? "modifié" : "";
  $("profile-state").title = p.active && p.modified ? "La configuration a changé depuis l'application du profil" : "";
  $("profile-update").hidden = !p.active;
  if (p.active) $("profile-update").textContent = `↻ Mettre à jour « ${p.active} » avec l'état actuel`;
  $("profile-new").disabled = p.names.length >= p.max;

  // Suppression de n'importe quel profil, sans l'appliquer
  $("profile-delete-list").replaceChildren(...(p.names.length ? [
    el("p", { class: "menu-title" }, "Supprimer un profil"),
    ...p.names.map((name) => el("button", {
      type: "button",
      role: "menuitem",
      class: "menu-item danger-text",
      onclick: () => {
        if (confirm(`Supprimer le profil « ${name} » ? (la configuration actuelle ne change pas)`)) {
          profileAction("/profiles/delete", name);
        }
      },
    }, `🗑 ${name}${name === p.active ? " (actif)" : ""}`)),
  ] : []));
}

function toggleProfileMenu(open = $("profile-menu").hidden) {
  $("profile-menu").hidden = !open;
  $("profile-menu-btn").setAttribute("aria-expanded", String(open));
}

async function profileAction(path, name, message) {
  toggleProfileMenu(false);
  $("error").textContent = "";
  try {
    await api(path, { name });
    await refresh();
    if (message) $("profile-state").textContent = message;
  } catch (err) {
    showError(err);
    await refresh();
  }
}

$("profile-select").addEventListener("change", (e) => {
  const name = e.target.value;
  e.target.blur();
  if (!name) return renderProfiles();
  if (confirm(`Appliquer le profil « ${name} » ? Les chaînes, modes, plafond et plage horaire changent (une sauvegarde est faite avant).`)) {
    profileAction("/profiles/apply", name, "appliqué ✓");
  } else {
    renderProfiles();
  }
});

$("profile-menu-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleProfileMenu();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".profile-actions")) toggleProfileMenu(false);
});

$("profile-new").addEventListener("click", () => {
  const name = prompt("Nom du nouveau profil (ex. Soirée, Nuit, Week-end) :");
  if (name && name.trim()) profileAction("/profiles/save", name.trim(), "enregistré ✓");
});
$("profile-update").addEventListener("click", () => {
  const name = lastStatus.profiles.active;
  if (name && confirm(`Remplacer « ${name} » par l'état actuel ?`)) profileAction("/profiles/save", name, "mis à jour ✓");
});

// --- Fenêtre Réglages (onglets) ---

const SETTINGS_TAB_KEY = "twitch-irc-settings-tab";

function showSettingsTab(tab) {
  for (const b of document.querySelectorAll("[data-stab]")) {
    const active = b.dataset.stab === tab;
    b.classList.toggle("active", active);
    b.setAttribute("aria-selected", String(active));
  }
  for (const p of document.querySelectorAll(".settings-tab")) p.hidden = p.id !== `stab-${tab}`;
  try { localStorage.setItem(SETTINGS_TAB_KEY, tab); } catch {}
  if (tab === "security") { loadSessions(); loadSanctions(); }
  if (tab === "list") loadDormantKept();
}

function openSettings(tab) {
  let last = null;
  try { last = localStorage.getItem(SETTINGS_TAB_KEY); } catch {}
  if (!$("settings-dialog").open) $("settings-dialog").showModal();
  document.querySelector("#settings-dialog .dlg").focus();
  showSettingsTab(tab ?? last ?? "general");
}

for (const b of document.querySelectorAll("[data-stab]")) b.addEventListener("click", () => showSettingsTab(b.dataset.stab));
// Chaînes endormies signalées par la pastille : ouvrir directement l'onglet Liste
$("open-settings").addEventListener("click", () => openSettings($("dormant-badge").hidden ? undefined : "list"));
$("settings-close").addEventListener("click", () => $("settings-dialog").close());
$("settings-dialog").addEventListener("click", (e) => { if (e.target === $("settings-dialog")) $("settings-dialog").close(); });

// --- Sécurité : sessions et connexion par secret ---

async function loadSessions() {
  try {
    const data = await api("/auth/sessions");
    const list = $("session-list");
    $("allow-secret").checked = data.allowSecretLogin;
    if (!data.sessions.length) {
      list.replaceChildren(el("li", { class: "hint" }, "Aucune session Twitch ouverte."));
      $("revoke-others").disabled = true;
      return;
    }
    $("revoke-others").disabled = !data.sessions.some((s) => !s.current);
    list.replaceChildren(...data.sessions.map((s) => el("li", {},
      el("div", {},
        el("strong", {}, s.device), s.current && el("span", { class: "tag current" }, "cet appareil"),
        el("div", { class: "hint" },
          `${s.login} · IP ${s.ip ?? "?"}${s.location ? ` (${s.location})` : ""} · actif ${s.lastSeen ? formatAge(Math.round((Date.now() - new Date(s.lastSeen)) / 1000)) : "?"}` +
          ` · connecté le ${s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "?"}`)),
      !s.current && el("button", {
        type: "button", class: "ghost",
        onclick: async () => {
          if (!confirm(`Déconnecter ${s.device} (${s.ip ?? "IP inconnue"}) ?`)) return;
          await api("/auth/sessions/revoke", { id: s.id }).catch(showError);
          loadSessions();
        },
      }, "Déconnecter"))));
  } catch (err) {
    showError(err);
  }
}



$("revoke-others").addEventListener("click", async () => {
  if (!confirm("Déconnecter tous les autres appareils ?")) return;
  try {
    const { revoked } = await api("/auth/sessions/revoke", { others: true });
    $("security-status").textContent = `${revoked} appareil(s) déconnecté(s).`;
  } catch (err) {
    showError(err);
  }
  loadSessions();
});

$("allow-secret").addEventListener("change", async (e) => {
  const allow = e.target.checked;
  $("security-status").textContent = "";
  try {
    await api("/settings", { allowSecretLogin: allow });
    $("security-status").textContent = allow
      ? "Connexion par secret réactivée."
      : "Connexion par secret désactivée : seule la connexion Twitch fonctionne désormais.";
  } catch (err) {
    e.target.checked = !allow;
    if (err.message !== "auth") $("security-status").textContent = `⚠ ${err.message}`;
  }
});

// --- Fiche de chaîne : onglets et fermeture ---

for (const b of document.querySelectorAll("#channel-dialog [data-tab]")) {
  b.addEventListener("click", () => showTab(b.dataset.tab));
}
$("dlg-close").addEventListener("click", closeChannel);
$("channel-dialog").addEventListener("close", () => {
  clearInterval(dialog.timer);
  dialog.name = null;
  document.body.classList.remove("panel-open");
  render();
});
// En panneau (non modal), Échap ne ferme pas la fiche d'elle-même
$("channel-dialog").addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("channel-dialog").matches(":modal")) closeChannel();
});
// Clic sur le fond assombri : fermer
$("channel-dialog").addEventListener("click", (e) => {
  if (e.target === $("channel-dialog")) closeChannel();
});

$("discord-remove").addEventListener("click", () => {
  if (confirm("Supprimer le webhook Discord ? Plus aucune notification ne sera envoyée.")) {
    saveDiscord({ discordWebhook: "" }, "Webhook supprimé.");
  }
});

$("discord-test").addEventListener("click", async () => {
  const button = $("discord-test");
  button.disabled = true;
  $("discord-status").textContent = "";
  try {
    await api("/settings/test-discord", {});
    $("discord-status").textContent = "Message de test envoyé : regarde ton salon Discord.";
  } catch (err) {
    if (err.message !== "auth") $("discord-status").textContent = `⚠ ${err.message}`;
  } finally {
    button.disabled = false;
  }
});

// --- Journal ---

async function refreshEvents() {
  try {
    const { events } = await api(`/events?since=${lastEventId}`);
    if (!events.length) return;
    // Le serveur a redémarré : ses identifiants repartent de 1
    if (events[0].id <= lastEventId) eventItems = [];
    eventItems = eventItems.concat(events).slice(-300);
    lastEventId = events[events.length - 1].id;
    renderEvents();
  } catch (err) {
    showError(err);
  }
}

function renderEvents() {
  const level = $("journal-level").value;
  const filter = $("journal-filter").value.trim().toLowerCase();
  const shown = eventItems.filter((e) =>
    (level === "all" || e.level !== "info") &&
    (!filter || `${e.source} ${e.message}`.toLowerCase().includes(filter)));

  $("journal-count").textContent = shown.length === eventItems.length
    ? `(${eventItems.length})`
    : `(${shown.length} / ${eventItems.length})`;
  if (!shown.length) {
    $("events").replaceChildren(el("li", { class: "ev" }, el("span", { class: "msg" }, "Aucun événement")));
    return;
  }
  $("events").replaceChildren(...shown.slice().reverse().map((e) =>
    el("li", { class: `ev ev-${e.level}` },
      el("time", { dateTime: e.at }, new Date(e.at).toLocaleTimeString()),
      el("span", { class: "src" }, e.source),
      el("span", { class: "msg" }, e.message))));
}

// --- Démarrage et événements ---

// Qui est connecté au panneau : avatar et pseudo Twitch, ou « secret de l'API »
async function loadMe() {
  const box = $("me");
  try {
    const me = await api("/me");
    if (me.method === "twitch") {
      const avatar = me.avatar && me.avatar.startsWith("https://static-cdn.jtvnw.net/")
        ? el("img", { src: me.avatar, alt: "", width: "28", height: "28" })
        : el("span", { class: "avatar-fallback", "aria-hidden": "true" }, me.displayName.slice(0, 1).toUpperCase());
      box.replaceChildren(avatar, el("span", {}, me.displayName), el("span", { class: "caret", "aria-hidden": "true" }, "▾"));
      box.setAttribute("aria-label", `Compte ${me.displayName} : menu`);
      $("account-info").textContent = `Connecté avec le compte Twitch ${me.user}`;
    } else {
      box.replaceChildren(el("span", { class: "avatar-fallback", "aria-hidden": "true" }, "🔑"), el("span", {}, "secret de l'API"),
        el("span", { class: "caret", "aria-hidden": "true" }, "▾"));
      box.setAttribute("aria-label", "Connecté avec le secret de l'API : menu");
      $("account-info").textContent = "Connecté avec le secret de l'API";
    }
    $("account").hidden = false;
    $("open-settings").hidden = false;
    $("open-drops").hidden = false;
    $("profile-box").hidden = false;
  } catch (err) {
    $("account").hidden = true;
  }
}

// Menu du compte (avatar en haut à droite)
function toggleAccountMenu(open = $("account-menu").hidden) {
  $("account-menu").hidden = !open;
  $("me").setAttribute("aria-expanded", String(open));
}
$("me").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAccountMenu();
});
document.addEventListener("click", (e) => {
  if (!$("account").contains(e.target)) toggleAccountMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("account-menu").hidden) {
    toggleAccountMenu(false);
    $("me").focus();
  }
});
$("menu-settings").addEventListener("click", () => {
  toggleAccountMenu(false);
  openSettings();
});

function start() {
  $("login").hidden = true;
  $("panel").hidden = false;
  $("error").textContent = "";
  loadMe();
  refresh();
  clearInterval(timer);
  timer = setInterval(() => { if (busy.size === 0) refresh(); }, 3000);
}

$("secret-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  secret = $("secret").value.trim();
  try {
    lastStatus = await api("/status");
  } catch (err) {
    if (err.message !== "auth") $("login-error").textContent = err.message;
    return;
  }
  storeSecret(secret, $("remember").checked);
  $("secret").value = "";
  start();
});

// --- Chercher ou ajouter ---
// Le champ filtre la liste ; les noms qui ne sont pas encore enregistrés peuvent être ajoutés
// avec les options par défaut (Réglages → Général) ou celles du menu ▾.

const ADD_PREFS_KEY = "twitch-irc-add-prefs";
function addPrefs() {
  try { return { join: true, liveOnly: true, ...JSON.parse(localStorage.getItem(ADD_PREFS_KEY) || "{}") }; } catch { return { join: true, liveOnly: true }; }
}
function saveAddPrefs() {
  try { localStorage.setItem(ADD_PREFS_KEY, JSON.stringify({ join: $("add-join").checked, liveOnly: $("add-live").checked })); } catch {}
}
$("add-join").checked = addPrefs().join;
$("add-live").checked = addPrefs().liveOnly;
$("add-join").addEventListener("change", saveAddPrefs);
$("add-live").addEventListener("change", saveAddPrefs);

function newNames() {
  const known = new Set(lastStatus?.channels.map((c) => c.name) ?? []);
  return typedNames().filter((n) => /^[a-z0-9_]{1,25}$/.test(n) && !known.has(n));
}

function renderAddButton() {
  const names = newNames();
  $("add-split").hidden = !names.length;
  $("add-btn").textContent = names.length === 1 ? `+ Ajouter « ${names[0]} »` : `+ Ajouter ${names.length} chaînes`;
}

function toggleAddMenu(open = $("add-menu").hidden) {
  $("add-menu").hidden = !open;
  $("add-more").setAttribute("aria-expanded", String(open));
}

// Bandeau après un ajout : ouvrir la fiche ou annuler
const toast = { timer: null, names: [] };
function showToast(names, label) {
  toast.names = names;
  $("toast-text").textContent = `${names.length === 1 ? names[0] : `${names.length} chaînes`} ajoutée${names.length > 1 ? "s" : ""} · ${label}`;
  $("toast-open").hidden = names.length !== 1;
  $("toast").hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $("toast").hidden = true; }, 10_000);
}

async function addChannels({ join, liveOnly }) {
  const names = newNames();
  if (!names.length) return;
  toggleAddMenu(false);
  $("add-btn").disabled = true;
  $("error").textContent = "";
  try {
    if (join) {
      await api("/channels/join", { channels: names, liveOnly });
    } else {
      await api("/channels/add", { channels: names });
      if (liveOnly) await api("/channels/mode", { channels: names, liveOnly: true });
    }
    $("names").value = "";
    showToast(names, `${join ? "activée" : "désactivée"}${names.length > 1 ? "s" : ""}, ${liveOnly ? "si live" : "toujours"}`);
    await refresh();
  } catch (err) {
    showError(err);
  } finally {
    $("add-btn").disabled = false;
  }
}

$("names").addEventListener("input", render);
// Entrée : ajoute les nouveaux noms, sinon ouvre la fiche si une seule chaîne correspond
$("add").addEventListener("submit", (e) => {
  e.preventDefault();
  if (newNames().length) return addChannels(addPrefs());
  const shown = lastStatus ? visibleChannels() : [];
  if (typedNames().length && shown.length === 1) openChannel(shown[0].name);
});
$("add-btn").addEventListener("click", () => addChannels(addPrefs()));
$("add-more").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleAddMenu();
});
for (const b of document.querySelectorAll("[data-add]")) {
  b.addEventListener("click", () => addChannels(b.dataset.add === "off"
    ? { join: false, liveOnly: addPrefs().liveOnly }
    : { join: true, liveOnly: false }));
}
$("toast-open").addEventListener("click", () => {
  $("toast").hidden = true;
  openChannel(toast.names[0]);
});
$("toast-undo").addEventListener("click", () => {
  $("toast").hidden = true;
  act("/channels/remove", toast.names);
});

// Menu des actions groupées
function toggleBulkMenu(open = $("bulk-menu").hidden) {
  $("bulk-menu").hidden = !open;
  $("bulk-btn").setAttribute("aria-expanded", String(open));
}
$("bulk-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  toggleBulkMenu();
});
for (const id of ["all-on", "all-off", "mode-always", "mode-live"]) {
  $(id).addEventListener("click", () => toggleBulkMenu(false));
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".bulk-actions")) toggleBulkMenu(false);
  if (!e.target.closest(".add-split")) toggleAddMenu(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  toggleBulkMenu(false);
  toggleAddMenu(false);
});

$("all-on").addEventListener("click", () => {
  const names = visibleChannels().filter((c) => !c.enabled).map((c) => c.name);
  if (names.length) act("/channels/join", names);
});

$("all-off").addEventListener("click", () => {
  const names = visibleChannels().filter((c) => c.enabled).map((c) => c.name);
  if (names.length && confirm(`Désactiver ${names.length} chaîne(s) ?`)) act("/channels/part", names);
});

$("mode-always").addEventListener("click", () => {
  const names = visibleChannels().filter((c) => c.liveOnly).map((c) => c.name);
  if (names.length) act("/channels/mode", names, { liveOnly: false });
});

$("mode-live").addEventListener("click", () => {
  const names = visibleChannels().filter((c) => !c.liveOnly).map((c) => c.name);
  if (names.length) act("/channels/mode", names, { liveOnly: true });
});

for (const b of document.querySelectorAll("[data-view]")) {
  b.addEventListener("click", () => setView(b.dataset.view));
}

const SORT_KEY = "twitch-irc-sort";
try { const saved = localStorage.getItem(SORT_KEY); if (saved && SORTS[saved]) $("sort").value = saved; } catch {}
$("sort").addEventListener("change", () => {
  try { localStorage.setItem(SORT_KEY, $("sort").value); } catch {}
  render();
});
$("journal").addEventListener("toggle", () => { if ($("journal").open) refreshEvents(); });
$("journal-level").addEventListener("change", renderEvents);
$("journal-filter").addEventListener("input", renderEvents);

// Téléchargement via fetch : l'authentification (secret ou cookie) est jointe comme pour l'API
$("journal-download").addEventListener("click", async () => {
  const button = $("journal-download");
  button.disabled = true;
  try {
    const res = await fetch("/events/download?days=30", { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!res.ok) throw new Error(`Téléchargement impossible (HTTP ${res.status})`);
    const url = URL.createObjectURL(await res.blob());
    const link = el("a", { href: url, download: `journal-${new Date().toISOString().slice(0, 10)}.txt` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    showError(err);
  } finally {
    button.disabled = false;
  }
});
$("logout").addEventListener("click", () => logout(""));

try { setView(localStorage.getItem(VIEW_KEY) || "all"); } catch { setView("all"); }

async function boot() {
  await loadAuthConfig();
  if (await handleOAuthReturn()) return;

  secret = storedSecret();
  if (secret) return start();

  // Session Twitch déjà ouverte ? (une requête sans identifiant ne compte pas comme échec)
  try {
    const res = await fetch("/status");
    if (res.ok) {
      lastStatus = await res.json();
      return start();
    }
  } catch {}
  showLogin();
}

boot();

// Bouton « remonter en haut » : visible dès qu'on a un peu défilé
$("update-now").addEventListener("click", () => location.reload());

const toTop = $("to-top");
const updateToTop = () => toTop.classList.toggle("visible", window.scrollY > 300);
window.addEventListener("scroll", updateToTop, { passive: true });
updateToTop();
toTop.addEventListener("click", () => {
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
});

// Appli installable sur l'écran d'accueil (le service worker ne met rien en cache)
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
