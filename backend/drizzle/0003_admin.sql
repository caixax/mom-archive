-- Admin side: sessions, announcements, user notices, audit and the request log.
-- These are the only tables the HTTP process may write, and it writes them as
-- momarchive_app, which has no rights at all on the archive tables.

CREATE TABLE IF NOT EXISTS "admin_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"steam_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "announcements" (
	"id" serial PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"scope" text DEFAULT 'home' NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"body" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"steam_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text,
	"details" jsonb,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "request_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"ip" text,
	"country" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"route" text NOT NULL,
	"query" text,
	"status" integer NOT NULL,
	"ms" integer NOT NULL,
	"bytes" integer,
	"user_agent" text,
	"referer" text,
	"admin" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_sessions_token_idx" ON "admin_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_steam_idx" ON "admin_sessions" ("steam_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "announcements_active_idx" ON "announcements" ("active","scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_notices_user_idx" ON "user_notices" ("user_id","active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_at_idx" ON "admin_audit" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_log_at_idx" ON "request_log" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_log_ip_idx" ON "request_log" ("ip","at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "request_log_route_idx" ON "request_log" ("route","at");
--> statement-breakpoint
-- The read only role reads everything, as before.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_ro') THEN
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO momarchive_ro';
  END IF;
END $$;
--> statement-breakpoint
-- The app role writes these five tables and nothing else. No archive table is listed
-- here on purpose: a hole in the HTTP layer still cannot rewrite history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO momarchive_app';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO momarchive_app';
    EXECUTE 'GRANT INSERT, UPDATE, DELETE ON admin_sessions, announcements, user_notices, admin_audit, request_log TO momarchive_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE announcements_id_seq, user_notices_id_seq, admin_audit_id_seq, request_log_id_seq TO momarchive_app';
  END IF;
END $$;
