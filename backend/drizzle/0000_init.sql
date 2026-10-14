CREATE TABLE "activities" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"type" integer NOT NULL,
	"data" text,
	"momentum_created_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avatars" (
	"hash" text PRIMARY KEY NOT NULL,
	"s3_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"content_type" text,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fetch_failures" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"last_status" integer,
	"last_error" text,
	"last_at" timestamp with time zone NOT NULL,
	"gave_up" boolean DEFAULT false NOT NULL,
	CONSTRAINT "fetch_failures_kind_key_pk" PRIMARY KEY("kind","key")
);
--> statement-breakpoint
CREATE TABLE "follow_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"follower_id" integer NOT NULL,
	"followed_id" integer NOT NULL,
	"event" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follows" (
	"follower_id" integer NOT NULL,
	"followed_id" integer NOT NULL,
	"notify_on" integer,
	"momentum_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "follows_follower_id_followed_id_pk" PRIMARY KEY("follower_id","followed_id")
);
--> statement-breakpoint
CREATE TABLE "kv" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_entries" (
	"map_id" integer NOT NULL,
	"gamemode" integer NOT NULL,
	"track_type" integer NOT NULL,
	"track_num" integer NOT NULL,
	"style" integer NOT NULL,
	"user_id" integer NOT NULL,
	"time" double precision NOT NULL,
	"rank" integer,
	"replay_hash" text,
	"past_run_id" bigint,
	"flags" jsonb,
	"momentum_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"observed_alias" text,
	"observed_avatar_hash" text,
	CONSTRAINT "leaderboard_entries_map_id_gamemode_track_type_track_num_style_user_id_pk" PRIMARY KEY("map_id","gamemode","track_type","track_num","style","user_id")
);
--> statement-breakpoint
CREATE TABLE "leaderboard_observations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"gamemode" integer NOT NULL,
	"track_type" integer NOT NULL,
	"track_num" integer NOT NULL,
	"style" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"entry_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leaderboard_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"observation_id" bigint NOT NULL,
	"map_id" integer NOT NULL,
	"gamemode" integer NOT NULL,
	"track_type" integer NOT NULL,
	"track_num" integer NOT NULL,
	"style" integer NOT NULL,
	"user_id" integer NOT NULL,
	"time" double precision NOT NULL,
	"rank" integer,
	"replay_hash" text,
	"past_run_id" bigint,
	"momentum_created_at" timestamp with time zone,
	"observed_at" timestamp with time zone NOT NULL,
	"observed_alias" text,
	"observed_avatar_hash" text
);
--> statement-breakpoint
CREATE TABLE "leaderboards" (
	"map_id" integer NOT NULL,
	"gamemode" integer NOT NULL,
	"track_type" integer NOT NULL,
	"track_num" integer NOT NULL,
	"style" integer NOT NULL,
	"tier" integer,
	"tags" jsonb,
	"type" integer,
	"linear" boolean,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"last_refreshed_at" timestamp with time zone,
	"entry_count" integer,
	CONSTRAINT "leaderboards_map_id_gamemode_track_type_track_num_style_pk" PRIMARY KEY("map_id","gamemode","track_type","track_num","style")
);
--> statement-breakpoint
CREATE TABLE "map_credits" (
	"id" serial PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"type" integer NOT NULL,
	"description" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "map_field_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_images" (
	"id" text PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"s3_key" text,
	"bytes" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"fetch_failed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"map_id" integer NOT NULL,
	"version_num" integer NOT NULL,
	"changelog" text,
	"bsp_hash" text,
	"zone_hash" text,
	"download_url" text,
	"submitter_id" integer,
	"momentum_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"bsp_s3_key" text,
	"bsp_bytes" bigint
);
--> statement-breakpoint
CREATE TABLE "maps" (
	"id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" integer NOT NULL,
	"submitter_id" integer,
	"current_version_id" text,
	"description" text,
	"youtube_id" text,
	"creation_date" timestamp with time zone,
	"approved_date" timestamp with time zone,
	"required_games" jsonb,
	"stats_reviews" integer,
	"stats_subscriptions" integer,
	"stats_plays" integer,
	"stats_favorites" integer,
	"stats_completions" integer,
	"stats_unique_completions" integer,
	"stats_time_played" bigint,
	"image_ids" jsonb,
	"thumbnail_id" text,
	"momentum_created_at" timestamp with time zone,
	"momentum_updated_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"detail_fetched" boolean DEFAULT false NOT NULL,
	"native_gamemodes" jsonb,
	"archived" boolean DEFAULT false NOT NULL,
	"not_found_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "poll_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"job" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"ok" boolean,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"api_calls" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "refresh_queue" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"priority" integer DEFAULT 5 NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "replay_fetch_failures" (
	"sha1" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"last_status" integer,
	"last_error" text,
	"first_failed_at" timestamp with time zone NOT NULL,
	"last_failed_at" timestamp with time zone NOT NULL,
	"gave_up" boolean DEFAULT false NOT NULL,
	"context" jsonb
);
--> statement-breakpoint
CREATE TABLE "replay_queue" (
	"sha1" text PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"past_run_id" bigint,
	"user_id" integer,
	"map_id" integer,
	"map_name" text,
	"gamemode" integer,
	"track_type" integer,
	"track_num" integer,
	"style" integer,
	"run_time" double precision,
	"steam_id" text,
	"observed_alias" text,
	"observed_avatar_hash" text,
	"observed_steam_name" text
);
--> statement-breakpoint
CREATE TABLE "replays" (
	"sha1" text PRIMARY KEY NOT NULL,
	"s3_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"downloaded_at" timestamp with time zone NOT NULL,
	"header" jsonb,
	"header_ok" boolean DEFAULT false NOT NULL,
	"header_issues" jsonb,
	"header_player_name" text,
	"past_run_id" bigint,
	"user_id" integer,
	"map_id" integer,
	"gamemode" integer,
	"track_type" integer,
	"track_num" integer,
	"style" integer,
	"run_time" double precision,
	"observed_alias" text,
	"observed_avatar_hash" text,
	"observed_steam_name" text,
	"source_url" text
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" bigint PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"map_id" integer NOT NULL,
	"gamemode" integer NOT NULL,
	"track_type" integer NOT NULL,
	"track_num" integer NOT NULL,
	"style" integer NOT NULL,
	"time" double precision NOT NULL,
	"flags" jsonb,
	"is_pb" boolean NOT NULL,
	"replay_hash" text,
	"momentum_created_at" timestamp with time zone NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	"removal_kind" text,
	"observed_alias" text,
	"observed_avatar_hash" text,
	"observed_steam_name" text,
	"raw" jsonb
);
--> statement-breakpoint
CREATE TABLE "steam_avatar_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"avatar_hash" text NOT NULL,
	"source" text NOT NULL,
	"s3_key" text,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_field_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_name_history" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_profile_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "steam_profiles" (
	"steam_id" text PRIMARY KEY NOT NULL,
	"persona_name" text,
	"avatar_hash" text,
	"avatar_full" text,
	"profile_url" text,
	"profile_state" integer,
	"community_visibility_state" integer,
	"time_created" timestamp with time zone,
	"loc_country_code" text,
	"vac_banned" boolean,
	"number_of_vac_bans" integer,
	"number_of_game_bans" integer,
	"community_banned" boolean,
	"economy_ban" text,
	"days_since_last_ban" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"last_sourcebans_refresh_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "steam_sourcebans" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"steam_id" text NOT NULL,
	"server" text NOT NULL,
	"ban_timestamp" timestamp with time zone NOT NULL,
	"unban_timestamp" timestamp with time zone,
	"current_state" text,
	"ban_reason" text,
	"unban_reason" text,
	"name_at_ban" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_state" (
	"job" text PRIMARY KEY NOT NULL,
	"cursor" jsonb NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_field_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"hash" text NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" integer PRIMARY KEY NOT NULL,
	"steam_id" text,
	"alias" text,
	"country" text,
	"avatar_hash" text,
	"avatar_url" text,
	"roles" integer DEFAULT 0 NOT NULL,
	"bans" integer DEFAULT 0 NOT NULL,
	"bio" text,
	"socials" jsonb,
	"cos_xp" bigint,
	"level" integer,
	"maps_completed" integer,
	"runs_submitted" integer,
	"total_jumps" bigint,
	"total_strafes" bigint,
	"momentum_created_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_refreshed_at" timestamp with time zone,
	"profile_fetched" boolean DEFAULT false NOT NULL,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"follows_observed_at" timestamp with time zone,
	"activities_observed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "activities_user_idx" ON "activities" USING btree ("user_id","momentum_created_at");--> statement-breakpoint
CREATE INDEX "follow_events_follower_idx" ON "follow_events" USING btree ("follower_id","observed_at");--> statement-breakpoint
CREATE INDEX "follow_events_followed_idx" ON "follow_events" USING btree ("followed_id","observed_at");--> statement-breakpoint
CREATE INDEX "follows_followed_idx" ON "follows" USING btree ("followed_id");--> statement-breakpoint
CREATE INDEX "leaderboard_entries_user_idx" ON "leaderboard_entries" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "leaderboard_entries_replay_idx" ON "leaderboard_entries" USING btree ("replay_hash");--> statement-breakpoint
CREATE INDEX "leaderboard_entries_removed_idx" ON "leaderboard_entries" USING btree ("removed_at");--> statement-breakpoint
CREATE INDEX "leaderboard_observations_key_idx" ON "leaderboard_observations" USING btree ("map_id","gamemode","track_type","track_num","style","observed_at");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_obs_idx" ON "leaderboard_snapshots" USING btree ("observation_id");--> statement-breakpoint
CREATE INDEX "leaderboard_snapshots_user_idx" ON "leaderboard_snapshots" USING btree ("user_id","observed_at");--> statement-breakpoint
CREATE INDEX "leaderboards_gamemode_idx" ON "leaderboards" USING btree ("gamemode");--> statement-breakpoint
CREATE UNIQUE INDEX "map_credits_uniq" ON "map_credits" USING btree ("map_id","user_id","type");--> statement-breakpoint
CREATE INDEX "map_credits_user_idx" ON "map_credits" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "map_field_changes_map_idx" ON "map_field_changes" USING btree ("map_id","observed_at");--> statement-breakpoint
CREATE INDEX "map_field_changes_field_idx" ON "map_field_changes" USING btree ("field","observed_at");--> statement-breakpoint
CREATE INDEX "map_images_map_idx" ON "map_images" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "map_snapshots_map_idx" ON "map_snapshots" USING btree ("map_id","observed_at");--> statement-breakpoint
CREATE INDEX "map_versions_map_idx" ON "map_versions" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "maps_name_idx" ON "maps" USING btree ("name");--> statement-breakpoint
CREATE INDEX "maps_status_idx" ON "maps" USING btree ("status");--> statement-breakpoint
CREATE INDEX "poll_log_job_idx" ON "poll_log" USING btree ("job","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_queue_uniq" ON "refresh_queue" USING btree ("kind","key");--> statement-breakpoint
CREATE INDEX "refresh_queue_order_idx" ON "refresh_queue" USING btree ("priority","enqueued_at");--> statement-breakpoint
CREATE INDEX "replay_queue_state_idx" ON "replay_queue" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "replays_user_idx" ON "replays" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "replays_map_idx" ON "replays" USING btree ("map_id");--> statement-breakpoint
CREATE INDEX "replays_run_idx" ON "replays" USING btree ("past_run_id");--> statement-breakpoint
CREATE INDEX "replays_downloaded_idx" ON "replays" USING btree ("downloaded_at");--> statement-breakpoint
CREATE INDEX "runs_user_idx" ON "runs" USING btree ("user_id","momentum_created_at");--> statement-breakpoint
CREATE INDEX "runs_map_idx" ON "runs" USING btree ("map_id","gamemode","track_type","track_num","style");--> statement-breakpoint
CREATE INDEX "runs_created_idx" ON "runs" USING btree ("momentum_created_at");--> statement-breakpoint
CREATE INDEX "runs_removed_idx" ON "runs" USING btree ("removed_at");--> statement-breakpoint
CREATE INDEX "runs_gamemode_created_idx" ON "runs" USING btree ("gamemode","momentum_created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "steam_avatar_history_uniq" ON "steam_avatar_history" USING btree ("steam_id","avatar_hash","source");--> statement-breakpoint
CREATE INDEX "steam_field_changes_steam_idx" ON "steam_field_changes" USING btree ("steam_id","observed_at");--> statement-breakpoint
CREATE INDEX "steam_field_changes_field_idx" ON "steam_field_changes" USING btree ("field","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "steam_name_history_uniq" ON "steam_name_history" USING btree ("steam_id","name","source");--> statement-breakpoint
CREATE INDEX "steam_name_history_name_idx" ON "steam_name_history" USING btree ("name");--> statement-breakpoint
CREATE INDEX "steam_profile_snapshots_idx" ON "steam_profile_snapshots" USING btree ("steam_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "steam_sourcebans_uniq" ON "steam_sourcebans" USING btree ("steam_id","server","ban_timestamp");--> statement-breakpoint
CREATE INDEX "steam_sourcebans_name_idx" ON "steam_sourcebans" USING btree ("name_at_ban");--> statement-breakpoint
CREATE INDEX "user_field_changes_user_idx" ON "user_field_changes" USING btree ("user_id","observed_at");--> statement-breakpoint
CREATE INDEX "user_field_changes_field_idx" ON "user_field_changes" USING btree ("field","observed_at");--> statement-breakpoint
CREATE INDEX "user_field_changes_observed_idx" ON "user_field_changes" USING btree ("observed_at");--> statement-breakpoint
CREATE INDEX "user_snapshots_user_idx" ON "user_snapshots" USING btree ("user_id","observed_at");--> statement-breakpoint
CREATE INDEX "users_steam_id_idx" ON "users" USING btree ("steam_id");--> statement-breakpoint
CREATE INDEX "users_alias_idx" ON "users" USING btree ("alias");--> statement-breakpoint
CREATE INDEX "users_last_run_idx" ON "users" USING btree ("last_run_at");