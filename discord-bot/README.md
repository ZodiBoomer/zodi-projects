# ZodiBot

Bot Discord en Node.js basé sur `discord.js` v14. Le bot est conçu pour tourner en continu sur **Replit Reserved VM**. Electron et le démarrage via fichier `.env` ont été retirés.

## Démarrage sur Replit

1. Importer/synchroniser ce dossier dans Replit.
2. Ouvrir **Secrets** dans Replit.
3. Ajouter `DISCORD_TOKEN` avec le nouveau token du bot Discord.
4. Dans **Publish**, choisir **Reserved VM** et le type **Web server**.
5. Vérifier que la commande de démarrage est `npm start` et que le port local est `3000`.
6. Publier, puis contrôler les journaux : le bot doit se connecter à Discord.

Le code lit directement `process.env.DISCORD_TOKEN`. Replit injecte les valeurs de **Secrets** dans l'environnement du processus. Aucun fichier `.env` n'est lu ou requis. N'ajoute jamais de token dans le code ou dans GitHub.

## Hébergement

Utiliser **Reserved VM** pour conserver la connexion Discord Gateway en continu. Ne pas utiliser Autoscale ou Scheduled Deployment pour le processus permanent du bot.

## GitHub et données

GitHub conserve uniquement le code et la configuration non secrète. Les fichiers d'état JSON, journaux, fichiers `.env` et secrets sont exclus du dépôt. Les données d'exécution doivent être sauvegardées séparément avant toute migration ou réinstallation.

## Configuration

- `DISCORD_TOKEN` : obligatoire, à définir dans Replit Secrets.
- `PORT` : facultatif, valeur par défaut `3000`.
- Les autres paramètres facultatifs du bot peuvent être ajoutés dans Replit Secrets.
