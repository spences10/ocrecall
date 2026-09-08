# Migrations

The initial schema is version 1 in `src/schema.sql`. Future changes
must add transactional, numbered SQL migrations and advance the schema
version in `src/schema.ts`, preserving existing archive data.
