# Zodi Projects

Espace de travail pour les projets indépendants liés à l'écosystème Zodi qui ne nécessitent pas encore leur propre dépôt.

## Utilisation
- Un dossier par projet, avec un README local.
- Décrire l'objectif, le périmètre, les dépendances et l'état de chaque projet.
- Déplacer un projet vers un dépôt dédié uniquement lorsqu'un besoin clair le justifie.
- Garder ici les prototypes et expérimentations qui ne relèvent pas du moteur, de l'application Android, de Linux ou des outils partagés.

## Organisation de l'écosystème
- https://github.com/ZodiBoomer/zodi-ai — moteur central et API.
- https://github.com/ZodiBoomer/zodi-ai-android — application Android.
- https://github.com/ZodiBoomer/zodi-linux — environnement Linux.
- https://github.com/ZodiBoomer/zodi-tools — utilitaires partagés.

## Projet actif : bot Discord

Le bot Discord développé dans VS Code est suivi dans le dossier [discord-bot](./discord-bot/README.md). Son code source local n'est pas encore présent dans GitHub ; le dépôt ne contient pour l'instant que son cadrage documentaire. Ne pas inventer de fonctionnalités ni remplacer le projet local avant synchronisation et inspection.

## État initial
Dépôt documentaire initialisé. Aucun projet n'a été déplacé ou supprimé.


## Zodi AI Desktop launchers

Le dossier `apps/zodi-ai-desktop` contient les lanceurs Windows et Linux. Ils ouvrent l'application web partagée dans le navigateur système afin de conserver une seule authentification Google, un seul historique et une seule mémoire. Les builds Windows (.exe) et Linux (.AppImage) sont générés par GitHub Actions.
