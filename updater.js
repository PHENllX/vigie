/**
 * Mises à jour automatiques de Vigie.
 *
 * L'application interroge les Releases GitHub, propose la mise à jour, la
 * télécharge en arrière-plan et l'installe à la fermeture. Rien n'est
 * téléchargé sans que la personne ait dit oui.
 */

const { app, dialog } = require("electron");
const { autoUpdater } = require("electron-updater");

// Toutes les 6 heures : assez pour qu'une correction arrive dans la journée,
// assez rare pour ne jamais déranger.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

function setupUpdater({ prepareQuit } = {}) {
  // En développement (npm start), il n'y a pas d'installateur à mettre à jour.
  if (!app.isPackaged) {
    return { check() {}, dispose() {} };
  }

  autoUpdater.autoDownload = false; // on demande avant de consommer la bande passante
  autoUpdater.autoInstallOnAppQuit = true;

  let manualCheck = false;
  let busy = false;
  let timer = null;

  autoUpdater.on("update-available", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Mise à jour disponible",
      message: `Vigie ${info.version} est disponible.`,
      detail:
        `Tu utilises la version ${app.getVersion()}.\n\n` +
        `Le téléchargement se fait en arrière-plan — tu peux continuer à ` +
        `surveiller tes caméras pendant ce temps.`,
      buttons: ["Télécharger", "Plus tard"],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      autoUpdater.downloadUpdate().catch(() => {});
    } else {
      busy = false;
    }
  });

  autoUpdater.on("update-not-available", () => {
    if (manualCheck) {
      dialog.showMessageBox({
        type: "info",
        title: "Aucune mise à jour",
        message: "Vigie est à jour.",
        detail: `Version ${app.getVersion()}.`,
      });
    }
    manualCheck = false;
    busy = false;
  });

  autoUpdater.on("update-downloaded", async (info) => {
    const { response } = await dialog.showMessageBox({
      type: "info",
      title: "Mise à jour prête",
      message: `Vigie ${info.version} est prête à être installée.`,
      detail:
        "Sur le PC hôte, l'installation interrompt brièvement les caméras et " +
        "l'enregistrement, le temps du redémarrage.",
      buttons: ["Redémarrer maintenant", "À la prochaine fermeture"],
      defaultId: 1,
      cancelId: 1,
    });
    busy = false;
    if (response === 0) {
      if (typeof prepareQuit === "function") prepareQuit();
      // Laisse la boîte de dialogue se fermer avant de quitter.
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  autoUpdater.on("error", (err) => {
    busy = false;
    // Une vérification automatique qui échoue (réseau coupé, GitHub
    // injoignable) ne doit jamais interrompre la surveillance.
    if (manualCheck) {
      dialog.showMessageBox({
        type: "error",
        title: "Vérification impossible",
        message: "Impossible de vérifier les mises à jour.",
        detail: String(err && err.message ? err.message : err).slice(0, 400),
      });
    }
    manualCheck = false;
  });

  function check(manual = false) {
    if (busy) return;
    busy = true;
    manualCheck = manual;
    autoUpdater.checkForUpdates().catch(() => {
      busy = false;
      manualCheck = false;
    });
  }

  // Première vérification après le démarrage, une fois les caméras lancées.
  setTimeout(() => check(false), 30000);
  timer = setInterval(() => check(false), CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();

  return {
    check,
    dispose() {
      if (timer) clearInterval(timer);
    },
  };
}

module.exports = { setupUpdater };
