/**
 * The application's single source of business time. Every business timestamp (created_at,
 * updated_at, processed_at) comes from one injected clock, read once per operation, so tests can
 * control time and the database never supplies a competing clock.
 */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
