-- The Ledger: posts the owner writes (cases, news, concerns, site changelog), in
-- Markdown, with every earlier version of a published post kept. Written by
-- momarchive_app from the owner's panel; the archive tables stay out of its reach.

CREATE TABLE IF NOT EXISTS "ledger_posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"subject_user_id" integer,
	"published_at" timestamp with time zone,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"created_by" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ledger_revisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"post_id" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ledger_posts_slug_idx" ON "ledger_posts" ("slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_posts_published_idx" ON "ledger_posts" ("status","published_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_posts_subject_idx" ON "ledger_posts" ("subject_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ledger_revisions_post_idx" ON "ledger_revisions" ("post_id","valid_to");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_ro') THEN
    EXECUTE 'GRANT SELECT ON ledger_posts, ledger_revisions TO momarchive_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ledger_posts, ledger_revisions TO momarchive_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE ledger_posts_id_seq, ledger_revisions_id_seq TO momarchive_app';
  END IF;
END $$;
