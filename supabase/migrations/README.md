# Migrations

Production schema changes go through this directory and nowhere else.

## Rules

1. **One entrypoint.** `npm run db:migrate` (`scripts/apply-migrations.ts`) is the only way SQL reaches
   production. It reads this directory, applies what production has not recorded, and records each
   version in `supabase_migrations.schema_migrations`.
2. **Migrations are immutable.** Once a file has been applied, edit it never. A correction is a new
   file with a later timestamp. Editing an applied file changes nothing in production — the script
   only applies versions that are not yet recorded — so the edit is invisible until someone replays
   the chain from scratch, and then the two histories disagree.
3. **Never hand-apply SQL to production.** Pasting a function body into a SQL console is how a
   `begin_run` replacement dropped `config`, `pairs`, `catalog` and `open_positions` on 2026-11-20:
   it applied cleanly, the version row was recorded with no repository file, and the cron then
   crashed before inserting a run row — a silent outage with nothing in `execution_logs` to show for
   it. If SQL must run in production, it goes in a migration file first.
4. **Every migration has a rollback.** Put it in `rollback/<version>_<name>.rollback.sql`.
5. **Expand before contract.** New schema must be compatible with the code that is already deployed;
   code that uses it ships afterwards.

## Checks

| Command | What it proves |
| --- | --- |
| `npm test` | Filenames parse, no duplicate versions, and the `begin_run` body in the newest migration keeps every key the Worker reads. |
| `npm run db:drift` | The repository and `schema_migrations` describe the same history, in both directions. |
| `npm run db:verify-begin-run` | The **live** `begin_run` still returns what the Worker destructures. |
| CI replay | The whole chain applies to a clean PostgreSQL 17 and `tests/sql/migrations-clean-assert.sql` passes. |

`db:drift` and `db:verify-begin-run` need `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`.
