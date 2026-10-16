-- Run once as a Postgres superuser: psql -U postgres -f deploy/postgres-roles.sql
-- Replace the passwords before running. The RW role owns the schema; the RO role only reads.

CREATE ROLE momarchive_rw LOGIN PASSWORD 'CHANGE_ME_RW';
CREATE ROLE momarchive_ro LOGIN PASSWORD 'CHANGE_ME_RO';
-- Used by the HTTP side for the admin panel only. The migrations grant it write
-- access to the five admin tables and nothing else, so a hole in the web layer
-- cannot touch runs, replays, users or any other archived row.
CREATE ROLE momarchive_app LOGIN PASSWORD 'CHANGE_ME_APP';

CREATE DATABASE momarchive OWNER momarchive_rw;

\connect momarchive

-- pg_trgm needs a superuser (or a role with CREATE on the database) the first time.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER SCHEMA public OWNER TO momarchive_rw;
GRANT ALL ON SCHEMA public TO momarchive_rw;

GRANT CONNECT ON DATABASE momarchive TO momarchive_ro;
GRANT USAGE ON SCHEMA public TO momarchive_ro;
-- Tables are created later by the migrations (run as momarchive_rw); grant on everything that exists now
-- and make future tables created by momarchive_rw readable too.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO momarchive_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE momarchive_rw IN SCHEMA public GRANT SELECT ON TABLES TO momarchive_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE momarchive_rw IN SCHEMA public GRANT SELECT ON SEQUENCES TO momarchive_ro;

-- Hard safety: even if a bug tried to write through the RO pool, the session is read only.
ALTER ROLE momarchive_ro SET default_transaction_read_only = on;

GRANT CONNECT ON DATABASE momarchive TO momarchive_app;
GRANT USAGE ON SCHEMA public TO momarchive_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO momarchive_app;
ALTER DEFAULT PRIVILEGES FOR ROLE momarchive_rw IN SCHEMA public GRANT SELECT ON TABLES TO momarchive_app;
-- Write grants for the admin tables are issued by migration 0003, which runs as
-- momarchive_rw and knows the table names. Nothing else is ever granted here.
