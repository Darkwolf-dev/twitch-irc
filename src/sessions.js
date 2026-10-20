"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const COOKIE = "sid";

// Sessions du panneau (connexion Twitch). On ne stocke que l'empreinte de l'identifiant :
// une copie du fichier ne permet pas de se connecter.
class SessionStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, "sessions.json");
    this.sessions = new Map(); // sha256(sid) -> { login, expiresAt }
    try {
      for (const [hash, s] of Object.entries(JSON.parse(fs.readFileSync(this.file, "utf8")))) {
        if (s.expiresAt > Date.now()) this.sessions.set(hash, s);
      }
    } catch {}
  }

  static hash(sid) {
    return crypto.createHash("sha256").update(sid).digest("hex");
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // profile : { displayName, avatar } (affichage) ; meta : { ip, userAgent } (gestion des sessions)
  create(login, profile = {}, meta = {}) {
    const sid = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    this.sessions.set(SessionStore.hash(sid), {
      login,
      ...profile,
      ip: meta.ip ?? null,
      location: meta.location ?? null,
      userAgent: String(meta.userAgent ?? "").slice(0, 300),
      createdAt: now,
      lastSeen: now,
      expiresAt: now + SESSION_TTL_MS,
    });
    this.save();
    return sid;
  }

  // Dernière activité : en mémoire à chaque requête, écrite sur disque au plus toutes les 5 min
  touch(sid, ip, userAgent, location) {
    const s = this.sessions.get(SessionStore.hash(sid));
    if (!s) return;
    s.lastSeen = Date.now();
    if (ip) s.ip = ip;
    if (location) s.location = location;
    // Sessions ouvertes avant le suivi des appareils : on complète
    if (!s.userAgent && userAgent) s.userAgent = String(userAgent).slice(0, 300);
    if (!s.createdAt) s.createdAt = s.expiresAt - SESSION_TTL_MS;
    if (!this.lastTouchSave || Date.now() - this.lastTouchSave > 5 * 60_000) {
      this.lastTouchSave = Date.now();
      this.save();
    }
  }

  // Liste pour le panneau. L'identifiant public est un préfixe de l'empreinte : il ne permet pas de se connecter.
  list(currentSid) {
    const current = currentSid ? SessionStore.hash(currentSid) : null;
    return [...this.sessions.entries()]
      .filter(([, s]) => s.expiresAt > Date.now())
      .map(([hash, s]) => ({
        id: hash.slice(0, 16),
        login: s.login,
        ip: s.ip ?? null,
        location: s.location ?? null,
        userAgent: s.userAgent ?? "",
        createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null,
        current: hash === current,
      }))
      .sort((a, b) => (b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""));
  }

  // Révoque par identifiant public ; exceptSid : garde la session courante
  revoke({ id, exceptSid } = {}) {
    const keep = exceptSid ? SessionStore.hash(exceptSid) : null;
    let count = 0;
    for (const hash of [...this.sessions.keys()]) {
      if (hash === keep) continue;
      if (id && !hash.startsWith(id)) continue;
      this.sessions.delete(hash);
      count++;
    }
    if (count) this.save();
    return count;
  }

  setProfile(sid, profile) {
    const s = this.sessions.get(SessionStore.hash(sid));
    if (s) {
      Object.assign(s, profile);
      this.save();
    }
  }

  get(sid) {
    if (!sid) return null;
    const hash = SessionStore.hash(sid);
    const s = this.sessions.get(hash);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(hash);
      this.save();
      return null;
    }
    return s;
  }

  destroy(sid) {
    if (sid && this.sessions.delete(SessionStore.hash(sid))) this.save();
  }
}

function readCookie(req, name) {
  for (const part of (req.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i !== -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function cookieHeader(value, maxAgeMs, secure) {
  return [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure && "Secure",
  ].filter(Boolean).join("; ");
}

module.exports = { SessionStore, readCookie, cookieHeader, COOKIE, SESSION_TTL_MS };
