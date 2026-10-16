-- Per user world record counts drive the default order of the users list.
CREATE INDEX IF NOT EXISTS leaderboard_entries_user_rank1_idx ON leaderboard_entries (user_id) WHERE rank = 1 AND removed_at IS NULL;
