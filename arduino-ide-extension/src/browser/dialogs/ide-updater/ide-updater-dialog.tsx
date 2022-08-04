import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { AbstractDialog } from '../../theia/dialogs/dialogs';
import { Widget } from '@theia/core/shared/@phosphor/widgets';
import { Message } from '@theia/core/shared/@phosphor/messaging';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { nls } from '@theia/core';
import { IDEUpdaterComponent } from './ide-updater-component';

import {
  IDEUpdater,
  IDEUpdaterClient,
  ProgressInfo,
  SKIP_IDE_VERSION,
  UpdateInfo,
} from '../../../common/protocol/ide-updater';
import { LocalStorageService } from '@theia/core/lib/browser';
import { WindowService } from '@theia/core/lib/browser/window/window-service';

@injectable()
export class IDEUpdaterDialogWidget extends ReactWidget {
  protected isOpen = new Object();
  updateInfo: UpdateInfo;
  progressInfo: ProgressInfo | undefined;
  error: Error | undefined;
  downloadFinished: boolean;
  downloadStarted: boolean;
  onClose: () => void;

  @inject(IDEUpdater)
  protected readonly updater: IDEUpdater;

  @inject(IDEUpdaterClient)
  protected readonly updaterClient: IDEUpdaterClient;

  @inject(LocalStorageService)
  protected readonly localStorageService: LocalStorageService;

  @inject(WindowService)
  protected windowService: WindowService;

  init(updateInfo: UpdateInfo, onClose: () => void): void {
    this.updateInfo = updateInfo;
    this.progressInfo = undefined;
    this.error = undefined;
    this.downloadStarted = false;
    this.downloadFinished = false;
    this.onClose = onClose;

    this.updaterClient.onError((e) => {
      this.error = e;
      this.update();
    });
    this.updaterClient.onDownloadProgressChanged((e) => {
      this.progressInfo = e;
      this.update();
    });
    this.updaterClient.onDownloadFinished((e) => {
      this.downloadFinished = true;
      this.update();
    });
  }

  async onSkipVersion(): Promise<void> {
    this.localStorageService.setData<string>(
      SKIP_IDE_VERSION,
      this.updateInfo.version
    );
    this.close();
  }

  override close(): void {
    super.close();
    this.onClose();
  }

  onDispose(): void {
    if (this.downloadStarted && !this.downloadFinished)
      this.updater.stopDownload();
  }

  async onDownload(): Promise<void> {
    this.progressInfo = undefined;
    this.downloadStarted = true;
    this.error = undefined;
    this.updater.downloadUpdate();
    this.update();
  }

  onCloseAndInstall(): void {
    this.updater.quitAndInstall();
  }

  protected render(): React.ReactNode {
    return !!this.updateInfo ? (
      <form>
        <IDEUpdaterComponent
          updateInfo={this.updateInfo}
          windowService={this.windowService}
          downloadStarted={this.downloadStarted}
          downloadFinished={this.downloadFinished}
          progress={this.progressInfo}
          error={this.error}
          onClose={this.close.bind(this)}
          onSkipVersion={this.onSkipVersion.bind(this)}
          onDownload={this.onDownload.bind(this)}
          onCloseAndInstall={this.onCloseAndInstall.bind(this)}
        />
      </form>
    ) : null;
  }
}

@injectable()
export class IDEUpdaterDialogProps extends DialogProps {}

@injectable()
export class IDEUpdaterDialog extends AbstractDialog<UpdateInfo> {
  @inject(IDEUpdaterDialogWidget)
  protected readonly widget: IDEUpdaterDialogWidget;

  constructor(
    @inject(IDEUpdaterDialogProps)
    protected override readonly props: IDEUpdaterDialogProps
  ) {
    super({
      title: nls.localize(
        'arduino/ide-updater/ideUpdaterDialog',
        'Software Update'
      ),
    });
    this.node.id = 'ide-updater-dialog-container';
    this.contentNode.classList.add('ide-updater-dialog');
    this.acceptButton = undefined;
  }

  get value(): UpdateInfo {
    return this.widget.updateInfo;
  }

  protected override onAfterAttach(msg: Message): void {
    if (this.widget.isAttached) {
      Widget.detach(this.widget);
    }
    Widget.attach(this.widget, this.contentNode);
    super.onAfterAttach(msg);
    this.update();
  }

  override async open(
    data: UpdateInfo | undefined = undefined
  ): Promise<UpdateInfo | undefined> {
    if (data && data.version) {
      this.widget.init(data, this.close.bind(this));
      return super.open();
    }
  }

  protected override onUpdateRequest(msg: Message): void {
    super.onUpdateRequest(msg);
    this.widget.update();
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.widget.activate();
  }

  override close(): void {
    this.widget.dispose();
    super.close();
  }
}
