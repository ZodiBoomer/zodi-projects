# Bot Discord — projet VS Code

Ce dossier est réservé au bot Discord actuellement développé dans VS Code.

## État actuel
Le dépôt GitHub ne contient pas encore le code source du bot. Seuls les fichiers de documentation et de configuration générale du dépôt sont présents. Le code local doit être synchronisé depuis le PC avant toute refonte fonctionnelle.

## Structure cible
```text
discord-bot/
├── src/                 # commandes, événements et logique du bot
├── tests/               # tests automatisés
├── docs/                # documentation fonctionnelle
├── .env.example         # noms des variables, sans valeurs secrètes
├── .gitignore
├── README.md
└── package.json ou pyproject.toml
```

La structure réelle sera adaptée au langage et au framework déjà utilisés par le projet, sans imposer Node.js ou Python avant inspection.

## Sécurité
- Ne jamais versionner `.env`, les tokens Discord, clés ou secrets.
- Utiliser les secrets du fournisseur d'hébergement pour la production.
- Activer uniquement les intents et permissions Discord nécessaires.
- Valider et limiter les entrées des commandes.
- Journaliser les erreurs sans exposer les tokens ni les données sensibles.

## Prochaine étape
Depuis le dossier local du bot, synchroniser le code vers ce dépôt dans le dossier `discord-bot/`, après vérification des fichiers à exclure. Puis documenter les commandes, événements, permissions, intents et procédures de lancement.
