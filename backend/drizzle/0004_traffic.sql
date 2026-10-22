-- Daily traffic rollups, computed by the poller from request_log. They hold no IPs
-- and no user agents, so they are kept for good while the raw log rolls over.
-- Written by momarchive_rw (the poller); readable by the RO and app roles through
-- the default privileges set up in deploy/postgres-roles.sql.

CREATE TABLE IF NOT EXISTS "traffic_days" (
	"day" date PRIMARY KEY NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"human_requests" integer DEFAULT 0 NOT NULL,
	"bot_requests" integer DEFAULT 0 NOT NULL,
	"api_clients" integer DEFAULT 0 NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	"pageviews" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"rate_limited" integer DEFAULT 0 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"avg_ms" integer DEFAULT 0 NOT NULL,
	"p95_ms" integer DEFAULT 0 NOT NULL,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "traffic_day_keys" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"n" integer NOT NULL,
	"uniq" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "traffic_day_keys_day_kind_key_pk" PRIMARY KEY("day","kind","key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "traffic_day_keys_kind_idx" ON "traffic_day_keys" ("kind","day");
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_ro') THEN
    EXECUTE 'GRANT SELECT ON traffic_days, traffic_day_keys TO momarchive_ro';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_app') THEN
    EXECUTE 'GRANT SELECT ON traffic_days, traffic_day_keys TO momarchive_app';
  END IF;
END $$;
