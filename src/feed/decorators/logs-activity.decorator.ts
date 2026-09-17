import { ActivityOptionsConfig } from '../interfaces/activity-options.interface';
import { registerActivity } from '../../core/metadata/register-activity';

/**
 * Sugar over `registerActivity(TargetClass, options)`.
 *
 * The function is the primitive, not this decorator — see register-activity.ts
 * for why that ordering matters for portability.
 */
export function LogsActivity(options?: ActivityOptionsConfig): ClassDecorator {
  return (target: Function) => {
    registerActivity(target, options ?? {});
  };
}
