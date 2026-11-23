# Appli Android Twitch Deck

Le panneau (`https://tw.darkwolf-bots.com`) dans une appli Android (Capacitor), nom de package
`dev.darkwolf.livedeck`, enregistré sur l'Android Developer Console (compte gratuit, distribution limitée).

## Compilation

- **Automatique** : chaque modification de `android-app/` lance le workflow GitHub « Appli Android »,
  qui publie l'APK signé en Release `android-vN`. Le serveur du panneau le récupère (jeton
  `GITHUB_TOKEN` en lecture seule, toutes les 30 min) et l'appli propose la mise à jour.
- **En local** : JDK 21 et SDK Android dans `C:\Users\Darkwolf\Android`, puis
  `npx cap sync android` et `android\gradlew assembleRelease` (JAVA_HOME vers le JDK 21).

## Signature

La clé n'est jamais dans le dépôt : `android/keystore.properties` en local (ignoré par git),
secrets `ANDROID_KEYSTORE_BASE64` et `ANDROID_KEYSTORE_PASSWORD` sur GitHub.
Sans cette clé, l'appli installée ne peut plus être mise à jour.
