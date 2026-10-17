/**
 * The ONE definition of "a UUID" in this package: every id identity creates is one (`uuidv7()`), every id a product hands in
 * (a user, a context) must be one, and a malformed value must be refused here, as a plain error or a 4xx/401, and never reach
 * PostgreSQL, whose `invalid input syntax for type uuid` quotes the value. Any hex form with the 8-4-4-4-12 shape counts:
 * `z.uuid()` and friends reject the all-`f` and nil forms that a product may legitimately use as a sentinel, so no path uses them.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID_RE.test(value);
