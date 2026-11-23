"use strict";

// Mises à jour de l'appli Android : le serveur récupère le dernier APK publié par la compilation
// GitHub (Release « android-vN » d'un dépôt privé, jeton en lecture seule), puis le sert à l'appli
// par un lien de téléchargement signé et de courte durée.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHECK_EVERY_MS = 10 * 60_000; // une compilation dure ~5 min : la nouvelle version arrive vite dans l'appli
const LINK_TTL_MS = 10 * 60_000;

class AppUpdater {
  // onNewVersion(latest) : appelée quand une version plus récente vient d'être récupérée
  constructor({ dataDir, repo, token, secret, log, onNewVersion = () => {} }) {
    this.onNewVersion = onNewVersion;
    this.dir = path.join(dataDir, "app");
    this.infoFile = path.join(this.dir, "latest.json");
    this.repo = repo;
    this.token = token;
    this.key = crypto.createHmac("sha256", secret).update("apk-download").digest();
    this.log = log;
    this.checking = false;
    try {
      this.latest = JSON.parse(fs.readFileSync(this.infoFile, "utf8"));
      if (!fs.existsSync(this.apkPath())) this.latest = null;
    } catch {
      this.latest = null;
    }
  }

  get enabled() {
    return Boolean(this.repo && this.token);
  }

  start() {
    if (!this.enabled) {
      this.log.log("[appli] GITHUB_TOKEN ou APP_REPO absent : pas de mises à jour de l'appli Android");
      return;
    }
    this.check();
    setInterval(() => this.check(), CHECK_EVERY_MS).unref();
  }

  apkPath() {
    return path.join(this.dir, "twitch-deck.apk");
  }

  async github(url, accept = "application/vnd.github+json") {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "twitch-deck" },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`GitHub : HTTP ${res.status}`);
    return res;
  }

  // Dernière Release android-vN avec un APK ; téléchargée si plus récente que celle qu'on a
  async check() {
    if (!this.enabled || this.checking) return this.latest;
    this.checking = true;
    try {
      const releases = await (await this.github(`https://api.github.com/repos/${this.repo}/releases?per_page=20`)).json();
      const release = releases
        .filter((r) => /^android-v\d+$/.test(r.tag_name) && !r.draft)
        .map((r) => ({ r, code: Number(r.tag_name.slice(9)), apk: r.assets.find((a) => a.name.endsWith(".apk")) }))
        .filter((x) => x.apk)
        .sort((a, b) => b.code - a.code)[0];
      if (!release || (this.latest && this.latest.versionCode >= release.code)) return this.latest;
      const hadVersion = Boolean(this.latest);

      // L'adresse de l'asset redirige vers un stockage signé : fetch n'y renvoie pas le jeton
      const res = await this.github(release.apk.url, "application/octet-stream");
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length !== release.apk.size) throw new Error("APK incomplet");
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = this.apkPath() + ".tmp";
      fs.writeFileSync(tmp, bytes);
      fs.renameSync(tmp, this.apkPath());
      this.latest = {
        versionCode: release.code,
        versionName: release.r.name?.replace(/^.*?(\d[\w.]*)$/, "$1") || String(release.code),
        size: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        publishedAt: release.r.published_at,
        notes: (release.r.body || "").slice(0, 500),
      };
      fs.writeFileSync(this.infoFile, JSON.stringify(this.latest, null, 2));
      this.log.log(`[appli] Nouvelle version de l'appli Android récupérée : ${this.latest.versionName} (${release.code})`);
      if (hadVersion) this.onNewVersion(this.latest);
      return this.latest;
    } catch (err) {
      this.log.error(`[appli] Vérification des mises à jour impossible : ${err.message}`);
      return this.latest;
    } finally {
      this.checking = false;
    }
  }

  // Lien de téléchargement valable 10 minutes, utilisable hors session (navigateur du téléphone)
  downloadToken() {
    const exp = Date.now() + LINK_TTL_MS;
    const sig = crypto.createHmac("sha256", this.key).update(String(exp)).digest("base64url");
    return `${exp}.${sig}`;
  }

  validToken(token) {
    const [exp, sig] = String(token ?? "").split(".");
    if (!/^\d+$/.test(exp ?? "") || Number(exp) < Date.now() || !sig) return false;
    const expected = crypto.createHmac("sha256", this.key).update(exp).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
}

module.exports = { AppUpdater };
