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

Un fichier `.env` était suivi par Git sur `main`, malgré sa présence dans `.gitignore`. Il a été retiré de la branche de travail `chore/audit-and-document-zodibot`, mais il reste présent dans l'historique antérieur et sur `main` tant que la PR n'est pas fusionnée. Le contenu n'a pas été consulté pendant l'audit.

Avant toute fusion ou réécriture d'historique :
1. renouveler les tokens et clés qui ont pu figurer dans ce fichier (sans les communiquer ici) ;
2. enregistrer les nouveaux secrets dans les variables d'environnement du service concerné, notamment Render si nécessaire ;
3. préparer une sauvegarde et une réécriture coordonnée de l'historique Git pour supprimer les anciennes versions du fichier ;
4. demander à chaque clone local de se resynchroniser après cette réécriture.

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
