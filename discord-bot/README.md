# ZodiBot — documentation du projet

Ce dossier contient la documentation du bot Discord développé dans VS Code. Le code source actuellement présent sur GitHub est encore à la racine du dépôt `ZodiBoomer/zodi-projects` ; il n'a pas encore été déplacé dans ce dossier.

## État vérifié

- Runtime : Node.js, CommonJS.
- Bibliothèque Discord : `discord.js` 14.x.
- Point d'entrée déclaré : `index.js` à la racine.
- Interface desktop : Electron, avec `main.js` et `renderer.html` à la racine.
- Dépendances déclarées : `discord.js`, `dotenv`, `express` ; Electron en dépendance de développement.
- Le manifeste indique un script de démarrage du bot avec `node index.js`.

## Incohérences à corriger avant déplacement du code

- Le script `start:ui` référence `electron/main.js`, chemin absent de l'arborescence auditée.
- Plusieurs scripts npm référencent `tools/`, dossier absent de l'arborescence auditée.
- `main.js` charge `renderer.html` à la racine et tente de charger `index.js` depuis le dossier parent ; il faut revoir ces chemins ensemble si les fichiers sont déplacés.
- Le dépôt contient des fichiers JSON et journaux dont le rôle et la sensibilité doivent être déterminés avant de les conserver dans Git.

## Organisation recommandée

La structure finale sera définie après analyse des imports et chemins réels. Cible indicative :

```text
src/
  bot/
  commands/
  events/
desktop/
  main.js
  renderer.html
scripts/
tests/
docs/
.env.example
package.json
README.md
```

Cette structure est une proposition, pas une description de l'état actuel. Ne pas déplacer ou réécrire les fichiers avant validation des dépendances, des chemins et du déploiement.

## Sécurité

- Ne jamais ajouter `.env`, tokens Discord, clés API ou identifiants à Git.
- Utiliser les variables d'environnement et les secrets du fournisseur d'hébergement.
- Le dépôt contient actuellement un `.env` suivi par Git. Son contenu n'a pas été consulté. Il faut vérifier l'exposition éventuelle et renouveler les secrets concernés avant de poursuivre.
- Les journaux et fichiers runtime doivent être filtrés pour éviter d'enregistrer des secrets ou des données personnelles.

## Critères de validation

- [ ] Le bot démarre avec une commande documentée.
- [ ] L'interface desktop démarre indépendamment du bot.
- [ ] Les chemins relatifs fonctionnent après installation propre des dépendances.
- [ ] Les tests couvrent au minimum le démarrage et les fonctions essentielles.
- [ ] Le déploiement est validé sur une branche de test avant toute mise en production.
