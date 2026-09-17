import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';
import { ActivityMetadataStorage } from '../metadata/activity-metadata-storage';

export function LogsActivity(options?: ActivityOptionsConfig): ClassDecorator {
  return (target: Function) => {
    ActivityMetadataStorage.set(target, options ?? {});
  };
}
