-- Reports from signed in players, and privacy hides. Written by momarchive_app.
--
-- A reporter is a pseudonym: member_key is an HMAC of the SteamID under APP_SECRET,
-- so the owner sees a stable code, can block it, and never sees who it is. The
-- SteamID only appears in clear on a report the reporter chose to sign (a request
-- about their own data or a right of reply), and in member sessions only encrypted.

CREATE TABLE IF NOT EXISTS "members" (
	"member_key" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"blocked_at" timestamp with time zone,
	"blocked_note" text,
	"reports_total" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "member_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"member_key" text NOT NULL,
	"steam_id_enc" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"member_key" text NOT NULL,
	"category" text NOT NULL,
	"subject_kind" text,
	"subject_id" text,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"identified" boolean DEFAULT false NOT NULL,
	"reporter_steam_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	"last_member_message_at" timestamp with time zone,
	"last_admin_message_at" timestamp with time zone,
	"member_seen_at" timestamp with time zone,
	"admin_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_messages" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"report_id" integer NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "privacy_hides" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"hide_bio" boolean DEFAULT false NOT NULL,
	"hide_socials" boolean DEFAULT false NOT NULL,
	"hide_avatars" boolean DEFAULT false NOT NULL,
	"note" text,
	"report_id" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "member_sessions_token_idx" ON "member_sessions" ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "member_sessions_member_idx" ON "member_sessions" ("member_key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reports_public_idx" ON "reports" ("public_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_member_idx" ON "reports" ("member_key","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_status_idx" ON "reports" ("status","last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "report_messages_report_idx" ON "report_messages" ("report_id","created_at");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_ro') THEN
    -- The public read path needs privacy_hides to mask profiles. Reports and
    -- member tables are read by the HTTP process through the app role only.
    EXECUTE 'GRANT SELECT ON privacy_hides TO momarchive_ro';
    EXECUTE 'REVOKE ALL ON members, member_sessions, reports, report_messages FROM momarchive_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON members, member_sessions, reports, report_messages, privacy_hides TO momarchive_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE reports_id_seq, report_messages_id_seq TO momarchive_app';
  END IF;
END $$;
