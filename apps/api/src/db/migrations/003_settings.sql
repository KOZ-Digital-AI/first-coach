-- 003_settings: the admin settings, one row per top-level setting.
--
-- Applied by ../migrate.ts inside its own transaction: no transaction control, no PRAGMA here.
-- Once applied anywhere this file is frozen (the runner verifies its checksum); change the
-- schema with 004 and later. It touches nothing from 001 or 002.
--
-- A key/value table: `key` is the setting's name, `value` its JSON text. This SQL knows no setting
-- names, no defaults and no value shapes: the field list, the defaults and every rule live in
-- Zod (admin/settings.ts), which is the write boundary. A new setting therefore needs no migration,
-- and neither does a changed default: a key with no row reads as its default.
--
-- Conventions (as 001 and 002)
--   * STRICT table. `updated_at` is TEXT, canonical ISO 8601 UTC with milliseconds
--     ("2026-01-01T00:00:00.000Z"): a CHECK refuses any other spelling (offsets, no
--     milliseconds, invalid dates, and hour 24: strftime would round-trip "T24:00:00.000Z", which
--     Zod refuses and which spells the next day's midnight twice). Writers must pass
--     new Date().toISOString().
--   * `value` is CHECKed json_valid (RFC 8259 JSON text: no JSON5, no NaN) and nothing more: any JSON
--     type may be stored, because the type belongs to the setting, and Zod checks it.
--   * `key` is never blank: nothing but whitespace is refused, whitespace being space, tab, newline
--     and carriage return. There is NO CHECK on the list of keys and none on their length, on
--     purpose: a CHECK list cannot be altered in SQLite and would need a table rebuild for every
--     new setting.
--
-- Rules for writers and later migration authors
--   * A stored row can be stale or wrong for the running build (an older or newer build wrote it,
--     or a validation rule tightened). Readers validate every value with Zod and fall back to that
--     key's default; they never trust the row.
--   * Upsert with INSERT ... ON CONFLICT (key) DO UPDATE. INSERT OR REPLACE (and REPLACE INTO) deletes
--     and re-inserts the row, losing anything a later migration hangs on it (a trigger, a column, a
--     row that references it).
--   * Write all the keys of one update in ONE transaction, so a reader never sees half a patch.
--   * Not for secrets or personal data: settings are shown on the admin screen and shipped to
--     clients as JSON. Keys and tokens belong in the environment.
--   * SQLite cannot ALTER a CHECK: changing the key, value or timestamp rules needs a table-rebuild
--     migration that recreates the table. ALTER TABLE settings ADD COLUMN is fine for a new nullable
--     column (settings.test.ts pins the contract with positive assertions, so it keeps passing).

CREATE TABLE settings (
  key        TEXT NOT NULL PRIMARY KEY CHECK (trim(key, ' ' || char(9) || char(10) || char(13)) <> ''),
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
             CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', updated_at) IS updated_at AND substr(updated_at, 12, 2) < '24')
) STRICT;
