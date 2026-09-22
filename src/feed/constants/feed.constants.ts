export const FEED_MODULE_OPTIONS = 'FEED_MODULE_OPTIONS';

/**
 * The resolved `ActivityAdapter`, and the ports read off it.
 *
 * Resolved once by FeedModule rather than by each service: before this, every
 * service took an `EntityManager` and built its own MikroORM port on the side,
 * which is what kept `feed/` bound to one ORM while the ports claimed otherwise.
 */
export const ACTIVITY_ADAPTER = 'ACTIVITY_ADAPTER';
export const ACTIVITY_READER = 'ACTIVITY_READER';
export const ACTIVITY_STORE = 'ACTIVITY_STORE';
