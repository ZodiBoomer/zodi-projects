# Zodi Projects

Espace de travail pour les projets indépendants liés à l'écosystème Zodi.

## Démarrage Replit — ZodiBot

Ce dépôt est directement importable dans Replit. Le point d'entrée racine installe les dépendances du bot situé dans `discord-bot/`, puis lance le bot avec `npm start`.

1. Importer le dépôt GitHub dans Replit.
2. Ajouter le secret `DISCORD_TOKEN` dans **Secrets**.
3. Pour une publication permanente, utiliser **Reserved VM** (Web server), avec le port local `3000`.
4. Ajouter aussi `DISCORD_TOKEN` dans les secrets de la publication (**Published App Secrets**) si Replit les gère séparément.

Le token est lu depuis `process.env.DISCORD_TOKEN`. Aucun fichier `.env` n'est utilisé. Ne jamais committer de token.

## Code source du bot

Le code canonique est dans [discord-bot](./discord-bot/README.md).

## Autres projets de l'écosystème
- https://github.com/ZodiBoomer/zodi-ai — moteur central et API.
- https://github.com/ZodiBoomer/zodi-ai-android — application Android.
- https://github.com/ZodiBoomer/zodi-linux — environnement Linux.
- https://github.com/ZodiBoomer/zodi-tools — utilitaires partagés.

## Sécurité
Ne jamais committer de token, fichier `.env`, données d'exécution ou journaux. Si un secret a été publié, le révoquer et en générer un nouveau.
