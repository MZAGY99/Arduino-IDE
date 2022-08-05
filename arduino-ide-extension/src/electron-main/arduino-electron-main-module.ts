import { JsonRpcConnectionHandler } from '@theia/core/lib/common/messaging/proxy-factory';
import { ElectronMainWindowService } from '@theia/core/lib/electron-common/electron-main-window-service';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-common/messaging/electron-connection-handler';
import {
  ElectronMainApplication as TheiaElectronMainApplication,
  ElectronMainApplicationContribution,
} from '@theia/core/lib/electron-main/electron-main-application';
import { TheiaElectronWindow as DefaultTheiaElectronWindow } from '@theia/core/lib/electron-main/theia-electron-window';
import { ContainerModule } from '@theia/core/shared/inversify';
import {
  IDEUpdater,
  IDEUpdaterClient,
  IDEUpdaterPath,
} from '../common/protocol/ide-updater';
import {
  ElectronMainWindowServiceExt,
  electronMainWindowServiceExtPath,
} from '../electron-common/electron-main-window-service-ext';
import { ElectronMainWindowServiceExtImpl } from './electron-main-window-service-ext-impl';
import { IDEUpdaterImpl } from './ide-updater/ide-updater-impl';
import { ElectronMainApplication } from './theia/electron-main-application';
import { ElectronMainWindowServiceImpl } from './theia/electron-main-window-service';
import { TheiaElectronWindow } from './theia/theia-electron-window';

export default new ContainerModule((bind, unbind, isBound, rebind) => {
  bind(ElectronMainApplication).toSelf().inSingletonScope();
  rebind(TheiaElectronMainApplication).toService(ElectronMainApplication);

  bind(ElectronMainWindowServiceImpl).toSelf().inSingletonScope();
  rebind(ElectronMainWindowService).toService(ElectronMainWindowServiceImpl);

  // IDE updater bindings
  bind(IDEUpdaterImpl).toSelf().inSingletonScope();
  bind(IDEUpdater).toService(IDEUpdaterImpl);
  bind(ElectronMainApplicationContribution).toService(IDEUpdater);
  bind(ElectronConnectionHandler)
    .toDynamicValue(
      (context) =>
        new JsonRpcConnectionHandler<IDEUpdaterClient>(
          IDEUpdaterPath,
          (client) => {
            const server = context.container.get<IDEUpdater>(IDEUpdater);
            server.setClient(client);
            client.onDidCloseConnection(() => server.disconnectClient(client));
            return server;
          }
        )
    )
    .inSingletonScope();

  bind(TheiaElectronWindow).toSelf();
  rebind(DefaultTheiaElectronWindow).toService(TheiaElectronWindow);

  bind(ElectronMainWindowServiceExt)
    .to(ElectronMainWindowServiceExtImpl)
    .inSingletonScope();
  bind(ElectronConnectionHandler)
    .toDynamicValue(
      (context) =>
        new JsonRpcConnectionHandler(electronMainWindowServiceExtPath, () =>
          context.container.get(ElectronMainWindowServiceExt)
        )
    )
    .inSingletonScope();
});
