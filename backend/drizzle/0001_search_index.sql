-- Custom migration: extensions, search index, read-only grants.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE MATERIALIZED VIEW IF NOT EXISTS search_index AS
SELECT DISTINCT ON (kind, entity_id, source, text) kind, entity_id, source, text, first_seen, last_seen
FROM (
  SELECT 'user'::text AS kind, u.id AS entity_id, 'alias'::text AS source, u.alias AS text, u.first_seen_at AS first_seen, u.last_seen_at AS last_seen
  FROM users u WHERE u.alias IS NOT NULL AND u.alias <> ''
  UNION ALL
  SELECT 'user', c.user_id, 'past_alias', c.old_value, min(c.observed_at), max(c.observed_at)
  FROM user_field_changes c WHERE c.field = 'alias' AND c.old_value IS NOT NULL AND c.old_value <> ''
  GROUP BY c.user_id, c.old_value
  UNION ALL
  SELECT 'user', u.id,
         CASE n.source WHEN 'steam' THEN 'steam_name' WHEN 'steamhistory' THEN 'name_at_ban' ELSE 'past_alias' END,
         n.name, n.first_seen, n.last_seen
  FROM steam_name_history n JOIN users u ON u.steam_id = n.steam_id
  WHERE n.name <> '' AND (n.source <> 'momentum' OR n.name IS DISTINCT FROM u.alias)
  UNION ALL
  SELECT 'user', u.id, 'name_at_ban', b.name_at_ban, min(b.ban_timestamp), max(b.ban_timestamp)
  FROM steam_sourcebans b JOIN users u ON u.steam_id = b.steam_id
  WHERE b.name_at_ban IS NOT NULL AND b.name_at_ban <> ''
  GROUP BY u.id, b.name_at_ban
  UNION ALL
  SELECT 'map', m.id, 'map_name', m.name, m.first_seen_at, m.last_seen_at FROM maps m
) s
ORDER BY kind, entity_id, source, text, first_seen;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS search_index_uniq ON search_index (kind, entity_id, source, text);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_index_trgm ON search_index USING gin (text gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_index_kind ON search_index (kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS users_alias_trgm ON users USING gin (alias gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS maps_name_trgm ON maps USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_snapshots_profile_idx ON user_snapshots (user_id, observed_at) WHERE (data->>'profileFetched') = 'true';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS leaderboard_entries_rank1_idx ON leaderboard_entries (momentum_created_at) WHERE rank = 1 AND removed_at IS NULL;
--> statement-breakpoint
-- Grants for the read-only role used by the HTTP API. The role itself is created by deploy/postgres-roles.sql.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'momarchive_ro') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO momarchive_ro';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO momarchive_ro';
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE current_user IN SCHEMA public GRANT SELECT ON TABLES TO momarchive_ro';
  END IF;
END $$;
