# ZodiBot — bot Discord et interface desktop

Dépôt principal du projet ZodiBot développé avec VS Code.

## État du dépôt

Le code actuellement versionné se trouve à la racine du dépôt (branche `main`) :
- `index.js` : point d'entrée Node.js du bot.
- `main.js` et `renderer.html` : éléments de l'interface Electron actuellement présents à la racine.
- `package.json` et `package-lock.json` : manifeste et verrouillage des dépendances.
- `ecosystem.config.js`, `startup.js`, `stop.js`, `restart.js` : scripts de gestion du processus.
- `discord-bot/README.md` : documentation de cadrage du projet, pas le code du bot.

## Lancer le projet

Le manifeste définit actuellement :
- `npm start` → `node index.js`
- `npm run start:bot` → `node index.js`
- `npm run start:ui` → `electron electron/main.js`

Attention : lors de l'audit, le chemin `electron/main.js` référencé par le script n'était pas présent dans l'arborescence. Les scripts `start:local`, `startup:install`, `startup:remove`, `startup:status` et `stop` référencent aussi un dossier `tools/` absent de l'arborescence observée. Ces commandes doivent être vérifiées avant utilisation.

## Structure cible (à appliquer après validation)

La prochaine refonte devra séparer clairement :
- le cœur du bot et ses commandes/événements ;
- l'interface Electron ;
- les scripts d'exploitation ;
- la documentation et les tests ;
- les données runtime et journaux, qui ne doivent pas être versionnés sans raison.

Ne pas déplacer les fichiers avant d'avoir vérifié les chemins relatifs, les imports, les scripts npm et la configuration Render.

## Sécurité — action requise

Un fichier `.env` est actuellement suivi par Git dans l'historique du dépôt, malgré sa présence dans `.gitignore`. Le contenu n'a pas été consulté pendant l'audit. Ne pas considérer `.gitignore` comme une protection suffisante pour un fichier déjà suivi.

Avant de poursuivre :
1. vérifier localement quelles variables et quels secrets ont pu être exposés ;
2. renouveler tout token ou clé qui a été placé dans ce fichier ;
3. retirer le fichier du suivi Git et traiter son historique avec une procédure adaptée, après sauvegarde et validation.

Ne jamais publier de token Discord, clé API, mot de passe ou fichier `.env`.

## Déploiement

Le service Render associé utilise actuellement ce dépôt et sa branche `main`. Toute réorganisation des chemins devra être coordonnée avec ses paramètres de build et de démarrage. Ne pas modifier le service Render tant que la nouvelle structure n'a pas été testée.

## Vérifications à effectuer

- [ ] Confirmer le vrai point d'entrée du bot et ses dépendances.
- [ ] Corriger les chemins des scripts Electron et `tools/`.
- [ ] Séparer le code du bot, l'interface et les scripts d'exploitation.
- [ ] Identifier les fichiers JSON qui sont des données persistantes et ceux qui sont des journaux/runtime.
- [ ] Sécuriser le fichier `.env` et les éventuels secrets historiques.
- [ ] Ajouter des tests qui vérifient réellement le démarrage et les fonctions essentielles.
- [ ] Valider le déploiement sur une branche de test avant toute modification de production.
