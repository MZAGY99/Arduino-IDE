import { injectable } from '@theia/core/shared/inversify';
import {
  app,
  BrowserWindow,
  contentTracing,
  ipcMain,
  Event as ElectronEvent,
} from '@theia/core/electron-shared/electron';
import { fork } from 'child_process';
import { AddressInfo } from 'net';
import { join, dirname } from 'path';
import * as fs from 'fs-extra';
import { MaybePromise } from '@theia/core/lib/common/types';
import { ElectronSecurityToken } from '@theia/core/lib/electron-common/electron-token';
import { FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import {
  ElectronMainApplication as TheiaElectronMainApplication,
  ElectronMainExecutionParams,
} from '@theia/core/lib/electron-main/electron-main-application';
import { URI } from '@theia/core/shared/vscode-uri';
import { Deferred } from '@theia/core/lib/common/promise-util';
import * as os from '@theia/core/lib/common/os';
import { Restart } from '@theia/core/lib/electron-common/messaging/electron-messages';
import { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';

app.commandLine.appendSwitch('disable-http-cache');

interface WorkspaceOptions {
  file: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
  isFullScreen: boolean;
  time: number;
}

const WORKSPACES = 'workspaces';

/**
 * If the app is started with `--open-devtools` argument, the `Dev Tools` will be opened.
 */
const APP_STARTED_WITH_DEV_TOOLS =
  typeof process !== 'undefined' &&
  process.argv.indexOf('--open-devtools') !== -1;

/**
 * If the app is started with `--content-trace` argument, the `Dev Tools` will be opened and content tracing will start.
 */
const APP_STARTED_WITH_CONTENT_TRACE =
  typeof process !== 'undefined' &&
  process.argv.indexOf('--content-trace') !== -1;

@injectable()
export class ElectronMainApplication extends TheiaElectronMainApplication {
  private startup = false;
  private _firstWindowId: number | undefined;
  private openFilePromise = new Deferred();

  override async start(config: FrontendApplicationConfig): Promise<void> {
    // Explicitly set the app name to have better menu items on macOS. ("About", "Hide", and "Quit")
    // See: https://github.com/electron-userland/electron-builder/issues/2468
    // Regression in Theia: https://github.com/eclipse-theia/theia/issues/8701
    app.on('ready', () => app.setName(config.applicationName));
    this.attachFileAssociations();
    this.useNativeWindowFrame = this.getTitleBarStyle(config) === 'native';
    this._config = config;
    this.hookApplicationEvents();
    const [port] = await Promise.all([this.startBackend(), app.whenReady()]);
    this.startContentTracing();
    this._backendPort.resolve(port);
    await Promise.all([
      this.attachElectronSecurityToken(port),
      this.startContributions(),
    ]);
    return this.launch({
      secondInstance: false,
      argv: this.processArgv.getProcessArgvWithoutBin(process.argv),
      cwd: process.cwd(),
    });
  }

  private startContentTracing(): void {
    if (!APP_STARTED_WITH_CONTENT_TRACE) {
      return;
    }
    if (!app.isReady()) {
      throw new Error(
        'Cannot start content tracing when the electron app is not ready.'
      );
    }
    const defaultTraceCategories: Readonly<Array<string>> = [
      '-*',
      'devtools.timeline',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.frame',
      'toplevel',
      'blink.console',
      'disabled-by-default-devtools.timeline.stack',
      'disabled-by-default-v8.cpu_profile',
      'disabled-by-default-v8.cpu_profiler',
      'disabled-by-default-v8.cpu_profiler.hires',
    ];
    const traceOptions = {
      categoryFilter: defaultTraceCategories.join(','),
      traceOptions: 'record-until-full',
      options: 'sampling-frequency=10000',
    };
    (async () => {
      const appPath = app.getAppPath();
      let traceFile: string | undefined;
      if (appPath) {
        const tracesPath = join(appPath, 'traces');
        await fs.promises.mkdir(tracesPath, { recursive: true });
        traceFile = join(tracesPath, `trace-${new Date().toISOString()}.trace`);
      }
      console.log('>>> Content tracing has started...');
      await contentTracing.startRecording(traceOptions);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      contentTracing
        .stopRecording(traceFile)
        .then((out) =>
          console.log(
            `<<< Content tracing has finished. The trace data was written to: ${out}.`
          )
        );
    })();
  }

  private attachFileAssociations(): void {
    // OSX: register open-file event
    if (os.isOSX) {
      app.on('open-file', async (event, uri) => {
        event.preventDefault();
        if (uri.endsWith('.ino') && (await fs.pathExists(uri))) {
          this.openFilePromise.reject();
          await this.openSketch(dirname(uri));
        }
      });
      setTimeout(() => this.openFilePromise.resolve(), 500);
    } else {
      this.openFilePromise.resolve();
    }
  }

  private async isValidSketchPath(uri: string): Promise<boolean | undefined> {
    return typeof uri === 'string' && (await fs.pathExists(uri));
  }

  protected override async launch(
    params: ElectronMainExecutionParams
  ): Promise<void> {
    try {
      // When running on MacOS, we either have to wait until
      // 1. The `open-file` command has been received by the app, rejecting the promise
      // 2. A short timeout resolves the promise automatically, falling back to the usual app launch
      await this.openFilePromise.promise;
    } catch {
      // Application has received the `open-file` event and will skip the default application launch
      return;
    }

    if (!os.isOSX && (await this.launchFromArgs(params))) {
      // Application has received a file in its arguments and will skip the default application launch
      return;
    }

    this.startup = true;
    const workspaces: WorkspaceOptions[] | undefined =
      this.electronStore.get(WORKSPACES);
    let useDefault = true;
    if (workspaces && workspaces.length > 0) {
      console.log(
        `Restoring workspace roots: ${workspaces.map(({ file }) => file)}`
      );
      for (const workspace of workspaces) {
        if (await this.isValidSketchPath(workspace.file)) {
          useDefault = false;
          await this.openSketch(workspace);
        }
      }
    }
    this.startup = false;
    if (useDefault) {
      super.launch(params);
    }
  }

  private async launchFromArgs(
    params: ElectronMainExecutionParams
  ): Promise<boolean> {
    // Copy to prevent manipulation of original array
    const argCopy = [...params.argv];
    let uri: string | undefined;
    for (const possibleUri of argCopy) {
      if (
        possibleUri.endsWith('.ino') &&
        (await this.isValidSketchPath(possibleUri))
      ) {
        uri = possibleUri;
        break;
      }
    }
    if (uri) {
      await this.openSketch(dirname(uri));
      return true;
    }
    return false;
  }

  private async openSketch(
    workspace: WorkspaceOptions | string
  ): Promise<BrowserWindow> {
    const options = await this.getLastWindowOptions();
    let file: string;
    if (typeof workspace === 'object') {
      options.x = workspace.x;
      options.y = workspace.y;
      options.width = workspace.width;
      options.height = workspace.height;
      options.isMaximized = workspace.isMaximized;
      options.isFullScreen = workspace.isFullScreen;
      file = workspace.file;
    } else {
      file = workspace;
    }
    const [uri, electronWindow] = await Promise.all([
      this.createWindowUri(),
      this.createWindow(options),
    ]);
    electronWindow.loadURL(uri.withFragment(encodeURI(file)).toString(true));
    return electronWindow;
  }

  protected override avoidOverlap(
    options: TheiaBrowserWindowOptions
  ): TheiaBrowserWindowOptions {
    if (this.startup) {
      return options;
    }
    return super.avoidOverlap(options);
  }

  protected override getTitleBarStyle(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _config: FrontendApplicationConfig
  ): 'native' | 'custom' {
    return 'native';
  }

  protected override hookApplicationEvents(): void {
    app.on('will-quit', this.onWillQuit.bind(this));
    app.on('second-instance', this.onSecondInstance.bind(this));
    app.on('window-all-closed', this.onWindowAllClosed.bind(this));

    ipcMain.on(Restart, ({ sender }) => {
      this.restart(sender.id);
    });
  }

  protected override async onSecondInstance(
    event: ElectronEvent,
    argv: string[],
    cwd: string
  ): Promise<void> {
    if (
      !os.isOSX &&
      (await this.launchFromArgs({ cwd, argv, secondInstance: true }))
    ) {
      // Application has received a file in its arguments
      return;
    }
    super.onSecondInstance(event, argv, cwd);
  }

  override async createWindow(
    asyncOptions: MaybePromise<TheiaBrowserWindowOptions> = this.getDefaultTheiaWindowOptions()
  ): Promise<BrowserWindow> {
    const electronWindow = await super.createWindow(asyncOptions);
    if (APP_STARTED_WITH_DEV_TOOLS) {
      electronWindow.webContents.openDevTools();
    }
    this.attachListenersToWindow(electronWindow);
    if (this._firstWindowId === undefined) {
      this._firstWindowId = electronWindow.id;
    }
    return electronWindow;
  }

  protected override getDefaultOptions(): TheiaBrowserWindowOptions {
    const options = super.getDefaultOptions();
    if (!options.webPreferences) {
      options.webPreferences = {};
    }
    options.webPreferences.v8CacheOptions = 'bypassHeatCheck'; // TODO: verify this. VS Code use this V8 option.
    options.minWidth = 680;
    options.minHeight = 593;
    return options;
  }

  private attachListenersToWindow(electronWindow: BrowserWindow) {
    electronWindow.webContents.on(
      'new-window',
      (event, url, frameName, disposition, options) => {
        if (frameName === 'serialPlotter') {
          event.preventDefault();
          Object.assign(options, {
            width: 800,
            minWidth: 620,
            height: 500,
            minHeight: 320,
            x: 100,
            y: 100,
            webPreferences: {
              devTools: true,
              nativeWindowOpen: true,
              openerId: electronWindow?.webContents.id,
            },
          });
          event.newGuest = new BrowserWindow(options);
          event.newGuest.setMenu(null);
          event.newGuest?.on('closed', () => {
            electronWindow?.webContents.send('CLOSE_CHILD_WINDOW');
          });
          event.newGuest?.loadURL(url);
        }
      }
    );
    this.attachClosedWorkspace(electronWindow);
  }

  protected override async startBackend(): Promise<number> {
    // Check if we should run everything as one process.
    const noBackendFork = process.argv.indexOf('--no-cluster') !== -1;
    // We cannot use the `process.cwd()` as the application project path (the location of the `package.json` in other words)
    // in a bundled electron application because it depends on the way we start it. For instance, on OS X, these are a differences:
    // https://github.com/eclipse-theia/theia/issues/3297#issuecomment-439172274
    process.env.THEIA_APP_PROJECT_PATH = this.globals.THEIA_APP_PROJECT_PATH;
    // Set the electron version for both the dev and the production mode. (https://github.com/eclipse-theia/theia/issues/3254)
    // Otherwise, the forked backend processes will not know that they're serving the electron frontend.
    process.env.THEIA_ELECTRON_VERSION = process.versions.electron;
    if (noBackendFork) {
      process.env[ElectronSecurityToken] = JSON.stringify(
        this.electronSecurityToken
      );
      // The backend server main file is supposed to export a promise resolving with the port used by the http(s) server.
      const address: AddressInfo = await require(this.globals
        .THEIA_BACKEND_MAIN_PATH);
      return address.port;
    } else {
      let args = this.processArgv.getProcessArgvWithoutBin();
      // https://github.com/eclipse-theia/theia/issues/8227
      if (process.platform === 'darwin') {
        // https://github.com/electron/electron/issues/3657
        // https://stackoverflow.com/questions/10242115/os-x-strange-psn-command-line-parameter-when-launched-from-finder#comment102377986_10242200
        // macOS appends an extra `-psn_0_someNumber` arg if a file is opened from Finder after downloading from the Internet.
        // "AppName" is an app downloaded from the Internet. Are you sure you want to open it?
        args = args.filter((arg) => !arg.startsWith('-psn'));
      }
      const backendProcess = fork(
        this.globals.THEIA_BACKEND_MAIN_PATH,
        args,
        await this.getForkOptions()
      );
      console.log(`Starting backend process. PID: ${backendProcess.pid}`);
      return new Promise((resolve, reject) => {
        // The backend server main file is also supposed to send the resolved http(s) server port via IPC.
        backendProcess.on('message', (address: AddressInfo) => {
          resolve(address.port);
        });
        backendProcess.on('error', (error) => {
          reject(error);
        });
        app.on('quit', () => {
          try {
            // If we forked the process for the clusters, we need to manually terminate it.
            // See: https://github.com/eclipse-theia/theia/issues/835
            if (backendProcess.pid) {
              process.kill(backendProcess.pid);
            }
          } catch (e) {
            if (e.code === 'ESRCH') {
              console.log(
                'Could not terminate the backend process. It was not running.'
              );
              return;
            }
            throw e;
          }
        });
      });
    }
  }

  private closedWorkspaces: WorkspaceOptions[] = [];

  private attachClosedWorkspace(window: BrowserWindow): void {
    // Since the `before-quit` event is only fired when closing the *last* window
    // We need to keep track of recently closed windows/workspaces manually
    window.on('close', () => {
      const url = window.webContents.getURL();
      const workspace = URI.parse(url).fragment;
      if (workspace) {
        const workspaceUri = URI.file(workspace);
        const bounds = window.getNormalBounds();
        const now = Date.now();
        console.log(
          `Marking workspace as a closed sketch. Workspace URI: ${workspaceUri.toString()}. Date: ${now}.`
        );
        this.closedWorkspaces.push({
          ...bounds,
          isMaximized: window.isMaximized(),
          isFullScreen: window.isFullScreen(),
          file: workspaceUri.fsPath,
          time: now,
        });
      }
    });
  }

  protected override onWillQuit(event: Electron.Event): void {
    // Only add workspaces which were closed within the last second (1000 milliseconds)
    const threshold = Date.now() - 1000;
    const visited = new Set<string>();
    const workspaces = this.closedWorkspaces
      .filter((e) => {
        if (e.time < threshold) {
          console.log(
            `Skipped storing sketch as workspace root. Expected minimum threshold: <${threshold}>. Was: <${e.time}>.`
          );
          return false;
        }
        if (visited.has(e.file)) {
          console.log(
            `Skipped storing sketch as workspace root. Already visited: <${e.file}>.`
          );
          return false;
        }
        visited.add(e.file);
        console.log(`Storing the sketch as a workspace root: <${e.file}>.`);
        return true;
      })
      .sort((a, b) => a.file.localeCompare(b.file));
    this.electronStore.set(WORKSPACES, workspaces);
    console.log(
      `Stored workspaces roots: ${workspaces.map(({ file }) => file)}`
    );

    super.onWillQuit(event);
  }

  get browserWindows(): BrowserWindow[] {
    return Array.from(this.windows.values()).map(({ window }) => window);
  }

  get firstWindowId(): number | undefined {
    return this._firstWindowId;
  }
}
