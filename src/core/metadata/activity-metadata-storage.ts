import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';

/**
 * Keyed by constructor reference, or by name for schema-first ORMs that have no
 * class to point at (see registerActivity). Never by `constructor.name`: that
 * collides across modules and does not survive minification.
 */
export type ActivityTarget = Function | string;

export class ActivityMetadataStorage {
  private static readonly storage = new Map<ActivityTarget, ActivityOptionsConfig>();

  static set(target: ActivityTarget, options: ActivityOptionsConfig): void {
    this.storage.set(target, options);
  }

  static get(target: ActivityTarget): ActivityOptionsConfig | undefined {
    if (typeof target === 'string') {
      return this.storage.get(target);
    }

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

  static has(target: ActivityTarget): boolean {
    return this.get(target) !== undefined;
  }

  static clear(): void {
    this.storage.clear();
  }
}
