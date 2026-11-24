const { app, shell, dialog } = require("electron");

const APP_URL = process.env.ZODI_AI_URL || "https://zodi-ai-core.vercel.app";

app.whenReady().then(async () => {
  try {
    await shell.openExternal(APP_URL);
    app.quit();
  } catch (error) {
    dialog.showErrorBox(
      "Impossible d'ouvrir Zodi AI",
      "Le navigateur par défaut n'a pas pu être lancé. Vérifie ta connexion Internet puis réessaie.\n\n" +
        (error instanceof Error ? error.message : "Erreur inconnue")
    );
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
