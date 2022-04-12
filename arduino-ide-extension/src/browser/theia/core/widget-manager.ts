import { Widget, WidgetManager as TheiaWidgetManager } from "@theia/core/lib/browser";
import { injectable } from "@theia/core/shared/inversify";

@injectable()
export class WidgetManager extends TheiaWidgetManager {

  tryGetWidget<T extends Widget>(factoryId: string, options?: any): T | undefined {
    let optionCopy = { ...options };
    if ('uri' in optionCopy) {
      optionCopy = {
        uri: optionCopy.uri
      };
    }
    return super.tryGetWidget(factoryId, optionCopy);
  }

}
