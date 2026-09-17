import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';

export class ActivityMetadataStorage {
  private static readonly storage = new Map<Function, ActivityOptionsConfig>();

  static set(target: Function, options: ActivityOptionsConfig): void {
    this.storage.set(target, options);
  }

  static get(target: Function): ActivityOptionsConfig | undefined {
    let current: Function | null = target;
    while (current && current !== Function.prototype && current !== (Object as unknown as Function)) {
      const options = this.storage.get(current);
      if (options) {
        return options;
      }
      current = Object.getPrototypeOf(current);
    }
    return undefined;
  }

  static has(target: Function): boolean {
    return this.get(target) !== undefined;
  }

  static clear(): void {
    this.storage.clear();
  }
}
