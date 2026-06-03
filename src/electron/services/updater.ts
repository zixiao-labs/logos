import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * Wires electron-updater to the GitHub Releases feed declared in package.json
 * (`build.publish`). The renderer needs no involvement: `checkForUpdatesAndNotify`
 * downloads in the background and shows a native notification, and
 * `autoInstallOnAppQuit` applies it on the next quit.
 *
 * Defensive by design:
 * - No-op in dev (`!app.isPackaged`) — there is no update metadata to read.
 * - macOS auto-update REQUIRES a signed app; on an unsigned mac build the check
 *   emits an 'error' ("Could not get code signature…"). We listen for it and log
 *   rather than letting it become an unhandled exception. Windows (NSIS) and
 *   Linux (AppImage) self-update unsigned. Once mac signing creds are wired into
 *   the release workflow, macOS updates start working with no code change.
 */
export function setupAutoUpdater(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("error", (err) => {
    console.warn(
      "[updater] update check failed:",
      err instanceof Error ? err.message : err,
    );
  });

  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    console.warn(
      "[updater] could not check for updates:",
      err instanceof Error ? err.message : err,
    );
  });
}
