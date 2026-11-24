# Zodi AI Desktop

Lanceur officiel pour Windows et Linux.

## Fonctionnement

- Le programme ouvre le site Zodi AI dans le navigateur par défaut.
- La connexion Google reste dans le navigateur système, ce qui évite les restrictions OAuth des fenêtres intégrées.
- Les conversations et la mémoire restent synchronisées avec le compte Google entre le site, Android, Windows et Linux.
- Le lanceur ne stocke aucun mot de passe, jeton ou clé API.

Ce paquet est un lanceur de site, pas une application Electron qui embarque un moteur IA local.

## Génération

Depuis ce dossier :

```bash
npm install
npm run build:win
npm run build:linux
```

- Windows : installateur NSIS `.exe` (non signé).
- Linux : paquet `.AppImage`.

Les builds GitHub Actions publient les fichiers comme artefacts de workflow. Les exécutables ne sont pas signés ; Windows peut afficher un avertissement SmartScreen.
