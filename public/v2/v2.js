"use strict";

// Twitch Deck v2 (/v2/) : chargé après app.js, dont il garde tout (API, fiche, réglages, drops, journal).
// Il remplace seulement le rendu de la page principale : render, renderChannel, renderGroupTabs,
// visibleChannels et scopeLabel sont des fonctions globales d'app.js, réassignées ici.

const SVG_NS = "http://www.w3.org/2000/svg";
const ICONS = {
  star: "m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
  check: "m5 12 5 5 9-10",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  close: "M6 6l12 12M18 6 6 18",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
};

function icon(name, cls = "v2-icon") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", cls);
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// Barre de progression ; la largeur passe par le CSSOM (les attributs style sont bloqués par la CSP)
function bar(ratio) {
  const fill = el("span");
  fill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  return el("div", { class: "v2-bar" }, fill);
}

// --- Radar à drops : classement (boosters par jour) et drops du jour, relus toutes les 5 min ---

const DROPS_REFRESH_MS = 5 * 60_000;
let dropsReport = null;
let dropsLoadedAt = 0;
let dropsLoading = false;

async function loadDrops() {
  if (dropsLoading || Date.now() - dropsLoadedAt < DROPS_REFRESH_MS) return;
  dropsLoading = true;
  try {
    dropsReport = await api("/drops");
    dropsLoadedAt = Date.now();
    render();
  } catch {
    dropsLoadedAt = Date.now() - DROPS_REFRESH_MS + 30_000; // nouvel essai dans 30 s
  } finally {
    dropsLoading = false;
  }
}

function dropScore(name) {
  return dropsReport?.channels.find((c) => c.channel === name) ?? null;
}

// --- « À farmer » : en live, au moins une carte manquante, pas finie, pas bannie ---

const isTodo = (c) => Boolean(c.live && !c.watched && c.cards.length < CARDS.length && c.sanction?.type !== "ban");
// Sans aucune carte d'abord, puis les plus généreuses en drops, puis les plus gros lives
const byTodo = (a, b) => (a.cards.length - b.cards.length) ||
  ((dropScore(b.name)?.score ?? 0) - (dropScore(a.name)?.score ?? 0)) ||
  (b.live.viewers - a.live.viewers) || a.name.localeCompare(b.name);

function missingLabel(channel) {
  const missing = CARDS.filter((card) => !channel.cards.includes(card.rarity));
  return missing.length === CARDS.length ? "Manque : les deux cartes" : `Manque : ${missing[0].label.toLowerCase()}`;
}

const v1VisibleChannels = visibleChannels;
window.visibleChannels = function visibleChannels() {
  if (view !== "todo") return v1VisibleChannels();
  const words = typedNames();
  return lastStatus.channels
    .filter((c) => isTodo(c) && (!words.length || words.some((w) => c.name.includes(w))))
    .sort(byTodo);
};

const v1ScopeLabel = scopeLabel;
window.scopeLabel = function scopeLabel() {
  return view === "todo" ? "les chaînes à farmer" : v1ScopeLabel();
};

// --- Page principale ---

window.render = function render() {
  if (!lastStatus) return;
  const { irc, counts, channels, limits } = lastStatus;
  loadDrops();

  if (view.startsWith("group:") && !lastStatus.groups.some((g) => `group:${g.name}` === view)) {
    return setView("all");
  }
  renderGroupTabs();

  const pill = $("irc");
  pill.hidden = false;
  pill.textContent = irc.paused ? "⏸ IRC en pause" : irc.connected ? `● ${counts.joined} chats` : "IRC déconnecté";
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
    todo: channels.filter(isTodo).length,
    done: channels.filter((c) => c.watched).length,
    "no-epic": channels.filter((c) => !c.cards.includes("epic")).length,
    "no-legendary": channels.filter((c) => !c.cards.includes("legendary")).length,
    "no-card": channels.filter((c) => !c.cards.length).length,
  };
  for (const n of document.querySelectorAll("[data-count]")) n.textContent = String(viewCounts[n.dataset.count] ?? "");
  renderSettings();
  renderProfiles();
  renderDormantCard();
  if (dialog.name) renderDialogHeader();
  renderAddButton();
  renderTokenBanner(lastStatus.token);
  renderSummary(viewCounts);
  renderTodo();
  renderCollection();

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
      : view === "todo" ? "Rien à farmer : aucune chaîne en live sans ses cartes"
      : "Aucune chaîne dans cette vue";
    list.append(el("li", { class: "empty" }, text));
    return;
  }

  // Tri par statut ou spectateurs : les lives d'abord, sous deux intertitres
  const sections = ["status", "viewers"].includes($("sort").value) && view !== "todo";
  const liveCount = shown.filter((c) => c.live).length;
  shown.forEach((channel, i) => {
    if (sections && i === 0 && liveCount) list.append(el("li", { class: "v2-section" }, `En live · ${liveCount}`));
    if (sections && i === liveCount && liveCount < shown.length) {
      list.append(el("li", { class: "v2-section" }, `Hors ligne · ${shown.length - liveCount}`));
    }
    list.append(renderChannel(channel));
  });
};

function renderSummary(viewCounts) {
  const { counts, limits } = lastStatus;
  const today = new Date().setHours(0, 0, 0, 0);
  const dropsToday = dropsReport?.recent.filter((d) => Date.parse(d.at) >= today) ?? null;
  const boostersToday = dropsToday?.reduce((n, d) => n + (d.boosters ?? 1), 0);
  const tile = (label, value, detail, onclick, extra) => el("button", { type: "button", class: "v2-tile", onclick },
    el("span", { class: "v2-tile-label" }, label),
    el("span", { class: "v2-tile-value" }, value, " ", el("small", {}, detail)),
    extra);
  $("v2-summary").replaceChildren(
    tile("En live", String(counts.live), `/ ${counts.saved}`, () => setView("live")),
    tile("Chats rejoints", String(counts.joined), `/ ${limits.concurrent} max`, () => $("open-settings").click(),
      bar(counts.joined / limits.concurrent)),
    tile("Drops aujourd'hui", dropsToday ? String(dropsToday.length) : "–",
      dropsToday ? `· ${boostersToday} booster${boostersToday > 1 ? "s" : ""}` : "", () => $("open-drops").click()),
    tile("Finies aujourd'hui", String(viewCounts.done), `· jusqu'à ${RESET_AT}`, () => setView("done")),
  );
}

function renderTodo() {
  const box = $("v2-todo");
  const todo = lastStatus.channels.filter(isTodo).sort(byTodo);
  box.hidden = todo.length === 0 || view === "todo";
  if (box.hidden) return box.replaceChildren();
  box.replaceChildren(
    el("div", { class: "v2-todo-head" },
      el("h2", { id: "v2-todo-title" }, "À farmer maintenant"),
      el("p", { class: "hint" }, "En live, pas encore finies · sans aucune carte d'abord, puis les plus généreuses en drops"),
      el("button", { type: "button", onclick: () => setView("todo") }, `Tout voir (${todo.length})`)),
    el("div", { class: "v2-todo-grid" }, ...todo.slice(0, 4).map((c) => {
      const score = dropScore(c.name);
      return el("button", { type: "button", class: "v2-todo-card", onclick: () => openChannel(c.name) },
        el("span", { class: "v2-thumb" },
          c.live.thumbnail && el("img", { src: thumbnailUrl(c.live.thumbnail), alt: "", loading: "lazy", decoding: "async" }),
          el("span", { class: "live-tag" }, "LIVE"),
          el("span", { class: "v2-thumb-meta" }, `${viewers.format(c.live.viewers)} · ${shortDuration(c.live.startedAt)}`)),
        el("span", { class: "v2-todo-body" },
          el("strong", {}, c.name),
          el("span", { class: "hint" }, c.live.game || "Sans catégorie"),
          el("span", { class: "v2-missing" }, missingLabel(c),
            score?.perDay ? el("span", { class: "hint" }, ` · ${String(score.perDay).replace(".", ",")} boosters/j`) : null)));
    })));
}

function renderCollection() {
  const { channels } = lastStatus;
  if (!channels.length) return $("v2-collection").replaceChildren();
  $("v2-collection").replaceChildren(el("h2", {}, "Collection"), ...CARDS.map((card) => {
    const owned = channels.filter((c) => c.cards.includes(card.rarity)).length;
    return el("div", { class: `v2-meter ${card.rarity}` },
      el("span", { class: "v2-meter-head" }, el("strong", {}, `${card.label}s`), `${owned} / ${channels.length}`),
      bar(owned / channels.length));
  }));
}

window.renderGroupTabs = function renderGroupTabs() {
  const container = $("group-tabs");
  container.replaceChildren();
  if (lastStatus.groups.length) container.append(el("p", { class: "v2-nav-title" }, "Groupes"));
  for (const group of lastStatus.groups) {
    const active = view === `group:${group.name}`;
    container.append(el("button", {
      type: "button",
      class: `v2-nav${active ? " active" : ""}`,
      "aria-pressed": String(active),
      onclick: () => setView(active ? "all" : `group:${group.name}`),
    }, group.name, el("span", { class: "n" }, String(group.count))));
  }
  container.hidden = lastStatus.groups.length === 0;
};

window.renderChannel = function renderChannel(channel) {
  const isBusy = busy.has(channel.name);

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
    class: `v2-drop${channel.live ? "" : " is-off"}`,
    title: `Drop à ${new Date(channel.lastDrop).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} : pas de nouveau drop possible avant ${wait} min`,
  }, icon("clock"), `drop dans ${wait} min`);
  const sanction = channel.sanction && el("span", {
    class: `sanction-badge ${channel.sanction.type}`,
    title: channel.sanction.type === "ban"
      ? `Ton compte est banni de ce chat depuis le ${new Date(channel.sanction.at).toLocaleString()}`
      : `Timeout jusqu'à ${new Date(channel.sanction.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
  }, channel.sanction.type === "ban" ? "⛔ banni" : "⏱ timeout");
  const favMark = channel.favorite ? icon("star", "v2-fav-mark") : null;
  favMark?.setAttribute("aria-label", "Favori");

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

  const head = el("div", { class: "head" },
    el("button", {
      class: "open",
      title: `Chat, stats et réglages de ${channel.name}`,
      onclick: () => openChannel(channel.name),
    }, channel.name),
    favMark, badge, fresh, dropped, sanction, modeTag, ...groupTags,
    channel.watched && el("span", { class: "seen-badge", title: `Finie pour aujourd'hui : chat quitté jusqu'à ${RESET_AT}` }, "fini"));

  // Ligne 2 : jeu et titre en live ; sinon dernier message reçu, ou date du dernier live
  const last = channel.lastMessage;
  const sub = channel.live
    ? el("span", { class: "live-line", title: `${channel.live.game} — ${channel.live.title}` },
      el("span", { class: "live-game" }, channel.live.game || "Sans catégorie"),
      el("span", { class: "live-title" }, ` · ${channel.live.title}`))
    : last
      ? el("span", { class: "last", title: `${last.user} : ${last.text}` },
        el("time", { dateTime: last.at }, formatAge(last.ageSeconds)), " · ", el("strong", {}, last.user), ` : ${last.text}`)
      : channel.lastLive && el("span", { class: "last-live", title: new Date(channel.lastLive).toLocaleString() },
        `Dernier live : ${formatLastLive(channel.lastLive)}`);

  const pips = el("div", { class: "v2-pips" }, ...CARDS.map((card) => {
    const owned = channel.cards.includes(card.rarity);
    return el("button", {
      type: "button",
      class: `v2-pip ${card.rarity}${owned ? " is-owned" : ""}`,
      disabled: isBusy,
      "aria-pressed": String(owned),
      "aria-label": `Carte ${card.label.toLowerCase()} de ${channel.name}`,
      title: owned ? `Carte ${card.label.toLowerCase()} obtenue (clic : retirer)` : `Pas encore la carte ${card.label.toLowerCase()} (clic : obtenue)`,
      onclick: () => act("/channels/card", [channel.name], { rarity: card.rarity, owned: !owned }),
    }, card.label[0]);
  }));

  const actions = el("div", { class: "v2-actions" },
    el("button", {
      type: "button",
      class: channel.favorite ? "is-fav" : "",
      disabled: isBusy,
      "aria-pressed": String(channel.favorite),
      "aria-label": `${channel.name} en favori`,
      title: channel.favorite ? "Retirer des favoris" : "Ajouter aux favoris",
      onclick: () => act("/channels/favorite", [channel.name], { favorite: !channel.favorite }),
    }, icon("star")),
    el("button", {
      type: "button",
      class: channel.watched ? "is-seen" : "",
      disabled: isBusy,
      "aria-pressed": String(channel.watched),
      "aria-label": `${channel.name} assez regardée aujourd'hui`,
      title: channel.watched
        ? `Finie pour aujourd'hui : chat quitté et chaîne reléguée jusqu'à ${RESET_AT} (clic : annuler)`
        : `Finie pour aujourd'hui : quitter le chat et la reléguer en bas jusqu'à ${RESET_AT}`,
      onclick: () => act("/channels/watched", [channel.name], { watched: !channel.watched }),
    }, icon("check")),
    el("a", {
      class: "desktop-only",
      href: `https://www.twitch.tv/${encodeURIComponent(channel.name)}`,
      target: "_blank",
      rel: "noopener noreferrer",
      title: `Ouvrir ${channel.name} sur Twitch`,
      "aria-label": `Ouvrir ${channel.name} sur Twitch`,
    }, icon("external")),
    el("button", {
      type: "button",
      class: "desktop-only",
      title: "Retirer de la liste",
      "aria-label": `Retirer ${channel.name} de la liste`,
      onclick: () => {
        if (confirm(`Retirer ${channel.name} de la liste ?`)) act("/channels/remove", [channel.name]);
      },
    }, icon("close")));

  const state = el("span", {
    class: `detail state-${channel.state}`,
    title: channel.reason
      ? `${channel.reason}, nouvel essai à ${new Date(channel.retryAt).toLocaleTimeString()}`
      : STATE_HINTS[channel.state] ?? "",
  }, el("span", { class: "dot", "aria-hidden": "true" }), el("span", { class: "label" }, LABELS[channel.state] || channel.state));

  const toggle = el("label", { class: "switch" }, el("input", {
    type: "checkbox",
    role: "switch",
    checked: channel.enabled,
    disabled: isBusy,
    "aria-label": `Activer ${channel.name}`,
    onchange: (e) => act(e.target.checked ? "/channels/join" : "/channels/part", [channel.name]),
  }), el("span"));

  const classes = [channel.enabled ? "on" : "off", channel.live ? "live" : "idle", channel.watched && "watched",
    dialog.name === channel.name && "selected"];
  return el("li", {
    class: classes.filter(Boolean).join(" "),
    onclick: (e) => {
      if (e.target.closest("button, a, input, label") || getSelection().toString()) return;
      openChannel(channel.name);
    },
  }, avatar(channel), el("div", { class: "name" }, head, sub), pips, actions, state, toggle);
};

// Le premier rendu d'app.js a eu lieu avant ce fichier (sans données) : on remet la vue enregistrée
try { setView(localStorage.getItem(VIEW_KEY) || "all"); } catch { setView("all"); }
