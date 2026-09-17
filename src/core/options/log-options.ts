import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';

export class LogOptions {
  private readonly config: ActivityOptionsConfig = {};
  private readonly explicitFields = new Set<keyof ActivityOptionsConfig>();

  static defaults(): LogOptions {
    const options = new LogOptions();
    options.useLogName('default');
    options.logEvents(['created', 'updated', 'deleted']);
    options.logOnlyDirty(true);
    options.dontSubmitEmptyLogs(true);
    options.useSoftDeleteField('deletedAt');
    return options;
  }

  static partial(): LogOptions {
    return new LogOptions();
  }

  useLogName(logName: string): this {
    this.config.logName = logName;
    this.explicitFields.add('logName');
    return this;
  }

  logOnly(attributes: string[]): this {
    this.config.logOnly = attributes;
    this.explicitFields.add('logOnly');
    return this;
  }

  logExcept(attributes: string[]): this {
    this.config.logExcept = attributes;
    this.explicitFields.add('logExcept');
    return this;
  }

  logAll(): this {
    delete this.config.logOnly;
    delete this.config.logExcept;
    this.explicitFields.add('logOnly');
    this.explicitFields.add('logExcept');
    return this;
  }

  logOnlyDirty(onlyDirty = true): this {
    this.config.logOnlyDirty = onlyDirty;
    this.explicitFields.add('logOnlyDirty');
    return this;
  }

  dontSubmitEmptyLogs(dontSubmit = true): this {
    this.config.dontSubmitEmptyLogs = dontSubmit;
    this.explicitFields.add('dontSubmitEmptyLogs');
    return this;
  }

  useSoftDeleteField(field: string | false): this {
    this.config.softDeleteField = field;
    this.explicitFields.add('softDeleteField');
    return this;
  }

  logEvents(events: Array<'created' | 'updated' | 'deleted' | (string & {})>): this {
    this.config.events = events;
    this.explicitFields.add('events');
    return this;
  }

  setDescriptionForEvent(formatter: (event: string, entity: any) => string): this {
    this.config.description = formatter;
    this.explicitFields.add('description');
    return this;
  }

  toPartial(): Partial<ActivityOptionsConfig> {
    const partial: Partial<ActivityOptionsConfig> = {};
    for (const key of this.explicitFields) {
      if (key in this.config) {
        (partial as any)[key] = this.config[key];
      }
    }
    return partial;
  }
}
