import { inject, injectable } from '@theia/core/shared/inversify';
import * as remote from '@theia/core/electron-shared/@electron/remote';
import { MaybePromise } from '@theia/core/lib/common/types';
import { Widget, ContextMenuRenderer } from '@theia/core/lib/browser';
import {
  Disposable,
  DisposableCollection,
} from '@theia/core/lib/common/disposable';
import { ArduinoMenus } from '../menu/arduino-menus';
import { ArduinoToolbar } from '../toolbar/arduino-toolbar';
import {
  SketchContribution,
  Sketch,
  URI,
  Command,
  CommandRegistry,
  MenuModelRegistry,
  KeybindingRegistry,
} from './contribution';
import { ExamplesService } from '../../common/protocol/examples-service';
import { BuiltInExamples } from './examples';
import { Sketchbook } from './sketchbook';
import { SketchContainer } from '../../common/protocol';
import { nls } from '@theia/core/lib/common';

@injectable()
export class OpenSketch extends SketchContribution {
  @inject(MenuModelRegistry)
  private readonly menuRegistry: MenuModelRegistry;

  @inject(ContextMenuRenderer)
  private readonly contextMenuRenderer: ContextMenuRenderer;

  @inject(BuiltInExamples)
  private readonly builtInExamples: BuiltInExamples;

  @inject(ExamplesService)
  private readonly examplesService: ExamplesService;

  @inject(Sketchbook)
  private readonly sketchbook: Sketchbook;

  private readonly toDispose = new DisposableCollection();

  override registerCommands(registry: CommandRegistry): void {
    registry.registerCommand(OpenSketch.Commands.OPEN_SKETCH, {
      execute: (arg) =>
        Sketch.is(arg) ? this.openSketch(arg) : this.openSketch(),
    });
    registry.registerCommand(OpenSketch.Commands.OPEN_SKETCH__TOOLBAR, {
      isVisible: (widget) =>
        ArduinoToolbar.is(widget) && widget.side === 'left',
      execute: async (_: Widget, target: EventTarget) => {
        const container = await this.sketchService.getSketches({
          exclude: ['**/hardware/**'],
        });
        if (SketchContainer.isEmpty(container)) {
          this.openSketch();
        } else {
          this.toDispose.dispose();
          if (!(target instanceof HTMLElement)) {
            return;
          }
          const { parentElement } = target;
          if (!parentElement) {
            return;
          }

          this.menuRegistry.registerMenuAction(
            ArduinoMenus.OPEN_SKETCH__CONTEXT__OPEN_GROUP,
            {
              commandId: OpenSketch.Commands.OPEN_SKETCH.id,
              label: nls.localize(
                'vscode/workspaceActions/openFileFolder',
                'Open...'
              ),
            }
          );
          this.toDispose.push(
            Disposable.create(() =>
              this.menuRegistry.unregisterMenuAction(
                OpenSketch.Commands.OPEN_SKETCH
              )
            )
          );
          this.sketchbook.registerRecursively(
            [...container.children, ...container.sketches],
            ArduinoMenus.OPEN_SKETCH__CONTEXT__RECENT_GROUP,
            this.toDispose
          );
          try {
            const containers = await this.examplesService.builtIns();
            for (const container of containers) {
              this.builtInExamples.registerRecursively(
                container,
                ArduinoMenus.OPEN_SKETCH__CONTEXT__EXAMPLES_GROUP,
                this.toDispose
              );
            }
          } catch (e) {
            console.error('Error when collecting built-in examples.', e);
          }
          const options = {
            menuPath: ArduinoMenus.OPEN_SKETCH__CONTEXT,
            anchor: {
              x: parentElement.getBoundingClientRect().left,
              y:
                parentElement.getBoundingClientRect().top +
                parentElement.offsetHeight,
            },
          };
          this.contextMenuRenderer.render(options);
        }
      },
    });
  }

  override registerMenus(registry: MenuModelRegistry): void {
    registry.registerMenuAction(ArduinoMenus.FILE__SKETCH_GROUP, {
      commandId: OpenSketch.Commands.OPEN_SKETCH.id,
      label: nls.localize('vscode/workspaceActions/openFileFolder', 'Open...'),
      order: '1',
    });
  }

  override registerKeybindings(registry: KeybindingRegistry): void {
    registry.registerKeybinding({
      command: OpenSketch.Commands.OPEN_SKETCH.id,
      keybinding: 'CtrlCmd+O',
    });
  }

  private async openSketch(
    toOpen: MaybePromise<Sketch | undefined> = this.selectSketch()
  ): Promise<void> {
    const sketch = await toOpen;
    if (sketch) {
      this.workspaceService.open(new URI(sketch.uri));
    }
  }

  private async selectSketch(): Promise<Sketch | undefined> {
    const config = await this.configService.getConfiguration();
    const defaultPath = await this.fileService.fsPath(
      new URI(config.sketchDirUri)
    );
    const { filePaths } = await remote.dialog.showOpenDialog(
      remote.getCurrentWindow(),
      {
        defaultPath,
        properties: ['createDirectory', 'openFile'],
        filters: [
          {
            name: nls.localize('arduino/sketch/sketch', 'Sketch'),
            extensions: ['ino', 'pde'],
          },
        ],
      }
    );
    if (!filePaths.length) {
      return undefined;
    }
    if (filePaths.length > 1) {
      this.logger.warn(
        `Multiple sketches were selected: ${filePaths}. Using the first one.`
      );
    }
    const sketchFilePath = filePaths[0];
    const sketchFileUri = await this.fileSystemExt.getUri(sketchFilePath);
    const sketch = await this.sketchService.getSketchFolder(sketchFileUri);
    if (sketch) {
      return sketch;
    }
    if (Sketch.isSketchFile(sketchFileUri)) {
      const name = new URI(sketchFileUri).path.name;
      const nameWithExt = this.labelProvider.getName(new URI(sketchFileUri));
      const { response } = await remote.dialog.showMessageBox({
        title: nls.localize('arduino/sketch/moving', 'Moving'),
        type: 'question',
        buttons: [
          nls.localize('vscode/issueMainService/cancel', 'Cancel'),
          nls.localize('vscode/issueMainService/ok', 'OK'),
        ],
        message: nls.localize(
          'arduino/sketch/movingMsg',
          'The file "{0}" needs to be inside a sketch folder named "{1}".\nCreate this folder, move the file, and continue?',
          nameWithExt,
          name
        ),
      });
      if (response === 1) {
        // OK
        const newSketchUri = new URI(sketchFileUri).parent.resolve(name);
        const exists = await this.fileService.exists(newSketchUri);
        if (exists) {
          await remote.dialog.showMessageBox({
            type: 'error',
            title: nls.localize('vscode/dialog/dialogErrorMessage', 'Error'),
            message: nls.localize(
              'arduino/sketch/cantOpen',
              'A folder named "{0}" already exists. Can\'t open sketch.',
              name
            ),
          });
          return undefined;
        }
        await this.fileService.createFolder(newSketchUri);
        await this.fileService.move(
          new URI(sketchFileUri),
          new URI(newSketchUri.resolve(nameWithExt).toString())
        );
        return this.sketchService.getSketchFolder(newSketchUri.toString());
      }
    }
  }
}

export namespace OpenSketch {
  export namespace Commands {
    export const OPEN_SKETCH: Command = {
      id: 'arduino-open-sketch',
    };
    export const OPEN_SKETCH__TOOLBAR: Command = {
      id: 'arduino-open-sketch--toolbar',
    };
  }
}
