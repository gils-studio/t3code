import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

/**
 * On Windows the local server keeps running after the last window closes, so
 * remote clients keep working while the renderers no longer cost memory. The
 * tray icon is the way back to the window and the way to really quit.
 * Chromium keeps the GPU process and its memory with no window left, so the
 * tray ends it; Chromium starts a smaller one at once.
 */
export class DesktopTray extends Context.Service<
  DesktopTray,
  {
    /** Must run before Electron is ready. */
    readonly prepare: Effect.Effect<void>;
    readonly install: Effect.Effect<void, never, Scope.Scope>;
  }
>()("@t3tools/desktop/window/DesktopTray") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-tray");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const state = yield* DesktopState.DesktopState;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  const openWindow = () =>
    void runPromise(
      desktopWindow.activate.pipe(
        Effect.catchCause((cause) =>
          logWarning("failed to open the window from the tray", { cause }),
        ),
      ),
    );
  const quit = () => void runPromise(electronApp.quit);

  const releaseGpuProcess = Effect.gen(function* () {
    if (yield* Ref.get(state.quitting)) return;
    const gpu = (yield* electronApp.getAppMetrics).find((metric) => metric.type === "GPU");
    if (gpu === undefined) return;
    yield* Effect.try(() => process.kill(gpu.pid));
    yield* logInfo("ended the GPU process while only the tray is left", { pid: gpu.pid });
  }).pipe(
    Effect.catchCause((cause) => logWarning("failed to end the GPU process", { cause })),
    Effect.withSpan("desktop.tray.releaseGpuProcess"),
  );

  // Ending the GPU process counts as a crash; after three, Chromium would fall back to
  // software rendering for the rest of the session.
  const prepare = Effect.gen(function* () {
    if (environment.platform !== "win32") return;
    yield* electronApp.appendCommandLineSwitch("disable-gpu-process-crash-limit");
  });

  const install = Effect.gen(function* () {
    if (environment.platform !== "win32") return;
    const iconPaths = yield* assets.iconPaths;
    const iconPath = Option.orElse(iconPaths.ico, () => iconPaths.png);
    if (Option.isNone(iconPath)) {
      yield* logWarning("no tray icon found; closing the window quits the app");
      return;
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const tray = new Electron.Tray(iconPath.value);
        tray.setToolTip(environment.displayName);
        tray.setContextMenu(
          Electron.Menu.buildFromTemplate([
            { label: `Open ${environment.displayName}`, click: openWindow },
            { type: "separator" },
            { label: `Quit ${environment.displayName}`, click: quit },
          ]),
        );
        tray.on("click", openWindow);
        return tray;
      }).pipe(Effect.tap(() => Ref.set(state.keepRunningInTray, true))),
      (tray) =>
        Ref.set(state.keepRunningInTray, false).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!tray.isDestroyed()) tray.destroy();
            }),
          ),
        ),
    );
    yield* electronApp.on("window-all-closed", () => void runPromise(releaseGpuProcess));
    yield* logInfo("tray installed; closing the window keeps the server running");
  }).pipe(
    Effect.catchCause((cause) => logWarning("failed to install the tray", { cause })),
    Effect.withSpan("desktop.tray.install"),
  );

  return DesktopTray.of({ prepare, install });
});

export const layer = Layer.effect(DesktopTray, make);
