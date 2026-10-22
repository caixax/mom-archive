# mom-archive

A public, self-hosted archive of Momentum Mod leaderboard data for the Bhop HL1 gamemode. Think "Wayback Machine for Momentum Mod": it polls the official public API on a schedule, stores every run it observes, downloads every replay file before Momentum deletes it, and keeps a full change history of users (alias, avatar, bio, socials, roles, bans, stats), maps, leaderboards and follows. Everything the archive collects is public and read only, with no login and no API key.

Momentum itself keeps none of this history: only the current PB replay of each leaderboard survives (the previous one is deleted the moment a player improves), alias and avatar are single overwritten columns, and runs deleted by admins vanish from the public API without a trace. The archive exists to preserve what Momentum throws away.

Live instance: https://momarchive.org

The canonical hostname is `momarchive.org`. `www.momarchive.org` and the hostname the archive started on, `momarchive.caixa.cc`, are permanent redirects to it, path and query intact, so nothing that was ever linked breaks.

## Contents

- [Architecture](#architecture)
- [What is archived](#what-is-archived)
- [What cannot be rescued](#what-cannot-be-rescued)
- [Replay playback](#replay-playback)
- [The owner's panel](#the-owners-panel)
- [Momentum API quirks the archive works around](#momentum-api-quirks-the-archive-works-around)
- [Repository layout](#repository-layout)
- [Requirements](#requirements)
- [Deployment](#deployment)
- [Operations](#operations)
- [HTTP API](#http-api)
- [Database](#database)
- [Adding a gamemode](#adding-a-gamemode)
- [Development](#development)
- [Security notes](#security-notes)

## Architecture

One VPS, one Node process, nginx in front, Cloudflare Tunnel outside.

```
browser --> Cloudflare --> cloudflared --> nginx 127.0.0.1:5770 --> /var/www/momarchive (static front build)
                                                 \--> /api/ --> backend 127.0.0.1:5771 (Fastify, read-only Postgres role)

backend process (pm2 "momarchive-backend")
  http/     Fastify API, read-only pool, helmet, rate limit, cors, etag, OpenAPI
  poller/   scheduler + jobs, read-write pool
            runs-incremental, beta-runs, replay-download, refresh-worker,
            users-sweep, maps-sweep, leaderboards-full-sweep, maps-walk,
            steam-refresh, steamhistory-refresh, avatars-fetch, search-refresh, ...
  storage/  S3 (RustFS): replays/, avatars/, maps/images/, maps/bsp/, raw/
  db/       Postgres 16 via Drizzle, migrations applied on boot
```

The backend binds to `127.0.0.1` only and refuses to start if `BIND_HOST` is anything else (unless `ALLOW_PUBLIC_BIND=true`). The frontend calls same-origin `/api/...` URLs. Absolute URLs are built from `PUBLIC_BASE_URL`, never from the request host. The real client IP comes from `CF-Connecting-IP` (nginx forwards it as `X-Real-IP` / `X-Forwarded-For`, Fastify trusts loopback only).

## What is archived

- **Runs**: every `PastRun` in the archived gamemodes (`ARCHIVE_GAMEMODES`, default `3` = Bhop HL1), PB or not, on any map (including maps built for other modes). Each run carries `observed_alias`, `observed_avatar_hash` and `observed_steam_name` as they were when first seen; those are never rewritten.
- **Replays**: the `.momtv` file of every leaderboard entry observed, downloaded as soon as a new `replayHash` is seen, sha1 verified, header parsed and compared with the run (gamemode, track, style, time, SteamID, map name). Failures are recorded with the HTTP status so a 404 (already deleted upstream) is distinguishable from a network error.
- **Leaderboards**: current entries plus append-only observations. A new observation is stored only when the board content changed, so "leaderboard as of date X" is exact and cheap. Entries that were present and are now missing get `removed_at`; this is how admin deletions surface. A player improving their time replaces their entry; that is "improved", not "removed".
- **Users**: current state plus `user_snapshots` and `user_field_changes` for alias, country, avatar, roles, bans, bio, every social, and the six stats. Follows and followers are diffed into `follow_events`. Activities are stored. Users are discovered from runs, leaderboards, follows, credits, a daily sweep (100 users per API call) and the backfill id walk.
- **Maps**: current state, snapshots, field changes (status, name, description, stats, per leaderboard tier/tags/type, credits, versions, images), versions, credits, images (the `large` variant archived once per image id), and the list of leaderboards. BSP files are optional (`ARCHIVE_BSPS=false` by default).
- **Steam side** (needs `STEAM_API_KEY`): persona name, avatar, visibility, account creation, country, VAC/game/community/economy bans from `GetPlayerSummaries` and `GetPlayerBans`, diffed into `steam_field_changes`. Active users (ran in the last 7 days) every 6 hours, everyone daily.
- **SourceBans** (needs `STEAMHISTORY_API_KEY`): ban records from SteamHistory.net per SteamID, normalized into `steam_sourcebans`; the name the player had on the banning server feeds the alias history.
- **Avatars**: every avatar hash seen (Momentum or Steam) is downloaded once to `avatars/{hash}.jpg`, so the gallery works after Steam drops the image.
- **Raw responses**: every API body is gzipped to `raw/{endpoint}/{yyyy}/{mm}/{dd}/{timestamp}-{hash}.json.gz`. Retention is unlimited; `pnpm cli reprocess-raw raw/runs/2026/10` re-ingests.

The UI and `/api/about` state the date the archive started watching. Nothing before that date is known, and the archive never fabricates history.

## What cannot be rescued

- Replays deleted before the archive started, or replaced between two polls of a board nothing else touched (the incremental run poll triggers a board refresh, so this window is normally one poll interval).
- Replays of runs that were never a PB. Momentum never uploads them.
- Runs that admins moved to `deletedruns/`. That bucket is not public.
- Anything behind auth: notifications, reports, chat bans, admin activity, maps in private testing. With an optional `MOMENTUM_TOKEN` the archive also reads `/maps/submissions` for faster beta discovery; it is never required.
- Steam history from before the archive first saw a player. Name and avatar history comes only from the archive's own Momentum and Steam polling plus SourceBans `Name` fields, never from scraping steamcommunity.com.

## Replay playback

Every archived replay has a "view" link that plays it in the browser on the map it was recorded on, with [momtv.js](https://github.com/caixax/momtv.js) (`@caixax/momtv-player`, loaded as its own chunk only on `/watch/:sha1`, so it costs nothing on every other page).

The map has to come from this origin: the official API and CDN send no CORS headers, so the player cannot fetch a BSP itself. `GET /api/replays/:sha1` therefore resolves a `mapBsp` for every replay, matching the `mapHash` the replay header recorded against `map_versions.bsp_hash`, which means the archive plays back **the exact version the run was recorded on** whenever it observed that version, and says so in the UI when it has to fall back to a newer one. `GET /api/maps/bsp/:bspHash` then serves those bytes: from storage when `ARCHIVE_BSPS=true` archived them, otherwise streamed from the CDN with `Range` passed through (only ever the host in `MOMENTUM_CDN`, never an arbitrary stored URL).

No game files are served: materials a map does not pack itself are drawn as flat colours. Playback needs WebGL2; the page says so and still offers the download when it is missing.

## The owner's panel

There is no public account system: no sign up, no sign in link, no API keys, and the data API stays open to everyone. The one exception is `/admin`, which is not linked from the site and is reached by typing the path.

Sign in is Steam OpenID 2.0, which needs no API key. What the flow proves is which Steam account you are; whether that account is the owner is answered only by `ADMIN_STEAM_IDS` in the environment, and a successful Steam login by anyone else stores nothing and creates no session. Leave `APP_SECRET`, `ADMIN_STEAM_IDS` and `DATABASE_URL_APP` empty and the panel does not exist: `/api/admin/*` and the sign in routes are never registered.

The panel carries:

- **Overview**: row counts for every table, job results and failures, sync cursors, storage totals, runs first seen per day.
- **Poller**: every scheduler job live, refreshed every few seconds: running or idle, progress of the current run (done of total), last result and duration, next run, runs, failures and API calls over 24 hours, and each job's recent history. Any scheduled job can be started now or asked to stop (it finishes its batch and keeps its cursor); the backfill can be resumed or restarted at a phase. One user, map, leaderboard, follow list, activity feed or run can be put at the front of the refresh queue, and failed replay downloads can be retried. Also shown: refresh and replay queue depths, the latest replay failures, Momentum, Steam and SteamHistory call budgets, and the process's uptime and memory.
- **Traffic**: requests, unique IPs, user agents, countries, status codes and latency over 1 hour to 30 days; top IPs, routes, agents and countries; and the raw log with filters by IP, route, status and user agent.
- **Announcements**: a banner on the home page or on every page, with a level and an optional start and end time.
- **Profile notices**: a note pinned to one archived player's page.
- **Audit**: every action taken in the panel, with IP and user agent.
- **Sessions**: every session with its IP, last use and expiry, revocable one by one or all at once.

How it is kept honest:

- **The archive cannot be written from the web at all.** The HTTP process reads with `momarchive_ro` and writes only through `momarchive_app`, whose grants (issued by migration `0003`) cover exactly five tables: `admin_sessions`, `announcements`, `user_notices`, `admin_audit`, `request_log`. No hole in the API, however bad, can rewrite a run, a replay or a user. Only the poller, which takes no input from the internet, has the read write role.
- **The panel can ask the poller to look again, never tell it what to write.** The poller controls reach the scheduler in the same process through a small interface, not through a database handle: start or stop a job named in the scheduler's own registry, queue a refresh whose key must be an integer id (or a `mapId:gamemode:trackType:trackNum:style` leaderboard key), and retry failed replay downloads. Whatever happens next is the poller fetching from Momentum, exactly as it would on its own schedule; nothing in the request becomes archive data. A backfill is refused while another process (a `pnpm sync` in tmux) is moving its cursor. Every one of these actions is audited.
- Sessions are a 256 bit random token in a `__Host-` prefixed `HttpOnly`, `Secure`, `SameSite=Lax` cookie. The database stores only an HMAC of it, so a dump of the table cannot be replayed as a login. Sessions have an idle timeout and an absolute expiry, are revocable, and die the moment a SteamID leaves `ADMIN_STEAM_IDS`.
- The login round trip is verified against Steam with `check_authentication`; nothing in the callback query string is trusted before that. The `return_to` Steam signs is compared with what this server generated, and it carries a state token that has to match a short lived cookie, so a login cannot be started or replayed from somewhere else.
- Every write needs the session **and** an `Origin` equal to `PUBLIC_BASE_URL` **and** an `x-csrf-token` derived from the session, compared in constant time.
- Announcement and notice bodies are plain text with a length cap, rendered as text by the frontend like every other string the archive did not write. There is no HTML anywhere in them.
- nginx only lets `POST`, `PATCH` and `DELETE` through to `/api/auth/` and `/api/admin/`, under their own `limit_req` zone; everything else stays `GET` and `HEAD` only, and the backend enforces the same list again.
- The request log holds IPs, so it is a rolling window: `REQUEST_LOG_DAYS` (30 by default) and the daily housekeeping job delete the rest. Set `REQUEST_LOG_ENABLED=false` to record nothing.

## Momentum API quirks the archive works around

Verified against the live API and the public backend source (`momentum-mod/website`, `apps/backend/src/app`):

- `GET /runs` **ignores** `gamemode`, `trackType`, `trackNum` and `style` (`PastRunsService.getAll` never applies them). The archive walks the global feed (all gamemodes) and filters client side. Raw pages are kept for everything.
- `GET /runs` without `mapID` only returns runs on **approved** maps. Runs on beta maps are collected by a separate per map walk (`beta-runs`) for every known non-approved map that has an archived leaderboard.
- `GET /runs/{id}` only accepts `expand=user`. The embedded `leaderboardRun` in list responses has no `rank`; ranks come from the leaderboard endpoint.
- `GET /maps/{id}/leaderboard` has no `expand`; `user` is always embedded, `splits` are not.
- Anonymous `GET /maps` lists approved maps only. Beta maps are discovered from the run feed and from `maps-walk`, which probes `GET /maps/{id}` for ids `1..max+200` daily and stores any map with an archived gamemode leaderboard regardless of status (verified: map 2231 `df_biotrix-omega` is status 3 and answers).
- `GET /users?userIDs=a,b,c&expand=profile,userStats&take=100` works and is what the daily user sweep and the backfill use (100 users per call).
- In `Follow` objects `followedID` is the user being followed and `followeeID` is the user doing the following. The archive stores `follower_id` / `followed_id` in plain English.
- Rate limit: 20 requests/second and 200/minute per IP. The client uses two token buckets (`RATE_LIMIT_RPS=15`, `RATE_LIMIT_RPM=180` by default) and honours `Retry-After` on 429.

## Repository layout

```
mom-archive/
  backend/
    src/
      config.ts          env parsing with zod, fails fast on missing values
      logger.ts          winston factory (console line format + rotating JSON file), secret redaction
      bootstrap.ts       builds config, pools, storage, clients, scheduler
      main.ts            migrations, HTTP server, poller, in one process
      momentum/          enums, rate limited API client, typed responses, .momtv header parser, SteamID helpers
      db/                Drizzle schema, migrations runner, two connection pools (rw, ro)
      storage/           S3 client (RustFS), raw snapshot store
      poller/            scheduler, queues, diffing, observe (upserts + history), jobs/
      http/              Fastify app, plugins, routes, OpenAPI
      steam/             Steam Web API and SteamHistory.net clients
      cli/               backfill, reprocess-raw, verify-replays, requeue-replays, refresh-*, job
    drizzle/             SQL migrations (0000_init, 0001_search_index, 0002_wr_index, 0003_admin)
    test/                vitest: unit tests + PGlite integration tests + opt-in live tests
  front/                 Svelte 5 + Vite static SPA, plain CSS, same-origin /api calls
  deploy/
    nginx.momarchive.conf      listens 127.0.0.1:5770, serves /var/www/momarchive, proxies /api/ to 127.0.0.1:5771, redirects the old hostnames
    cloudflared.example.yml    ingress: every hostname -> http://127.0.0.1:5770
    postgres-roles.sql         creates momarchive_rw, momarchive_ro and momarchive_app
  ecosystem.config.cjs         pm2: momarchive-backend only
  .env.example
  lefthook.yml                 pre-commit: gitleaks, dash check, prettier
```

## Requirements

- Node.js 22.9 or newer (`.nvmrc` says 24; `--env-file-if-exists` is used to load `.env`), pnpm 10+ (`corepack enable`)
- Postgres 16 with the `pg_trgm` extension available
- An S3 compatible bucket (RustFS) reachable from the backend
- nginx, pm2, cloudflared on the VPS
- `gitleaks` on any machine that commits (pre-commit hook)

## Deployment

1. **Postgres roles and database** (as a superuser; edit the passwords first):

   ```sh
   psql -U postgres -f deploy/postgres-roles.sql
   ```

   This creates `momarchive_rw` (owner, used by the poller and migrations) and `momarchive_ro` (used by the HTTP API, `default_transaction_read_only = on`), the database, the `pg_trgm` extension and default privileges so future tables are readable by the RO role.

2. **Bucket**: create `mom-archive` in RustFS and an access key with read/write on that bucket only.

3. **Checkout and configure** (any location works; the backend runs from the checkout):

   ```sh
   git clone https://github.com/caixax/mom-archive
   cd mom-archive
   cp .env.example .env     # fill in DATABASE_URL_RW/RO, S3_*, USER_AGENT contact, keys
   corepack enable
   pnpm install --frozen-lockfile
   pnpm build               # backend -> backend/dist, front -> front/dist
   ```

4. **Frontend to the web root and nginx** (port 5770 on loopback, web root `/var/www/momarchive`):

   ```sh
   sudo mkdir -p /var/www/momarchive
   sudo rsync -a --delete front/dist/ /var/www/momarchive/
   sudo cp deploy/nginx.momarchive.conf /etc/nginx/sites-enabled/momarchive
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. **cloudflared**: merge `deploy/cloudflared.example.yml` into `/etc/cloudflared/config.yml` (every hostname -> `http://127.0.0.1:5770`) and restart the tunnel. Only nginx is reachable through the tunnel; the backend never is. Do not set `httpHostHeader`: nginx decides by `Host` which name is served and which is redirected.

6. **Backend under pm2** (migrations run on boot):

   ```sh
   pnpm pm2:start
   pnpm pm2:logs
   pm2 save && pm2 startup   # once, so it survives reboots
   ```

7. **Initial sync** (resumable, safe to re-run; the runs phase takes hours):

   ```sh
   pnpm sync
   ```

   `sync` walks `/runs` ascending (all gamemodes come back; archived ones are stored), users `1..N` in batches of 100, maps (sweep + id walk), queues every archived leaderboard, picks up runs submitted while it ran, and then keeps downloading replays and refreshing leaderboards and users until both queues are empty. When it exits, the archive is caught up. Progress is in `sync_state` and shown on `/status`.

   `pnpm backfill` runs only the backfill phases and leaves the queue draining to the pm2 backend (`pnpm cli backfill --phase users --only users` for a single phase). Both are safe to run while the backend is up; the queues use row locks.

Updating: run `./scripts/update.sh` from the repo root. It pulls, installs, builds, publishes `front/dist` to `/var/www/momarchive`, re-installs the nginx config only if it changed, and reloads the backend under pm2. The `.env` and the live nginx config are never touched by `git pull` itself.

## Operations

- `/status` page and `GET /api/status`: one card per component (Momentum API, database, storage, watcher jobs, replay queue, Steam API, SteamHistory, backfill). No hostnames, paths or secrets.
- Logs: console lines `HH:mm:ss LEVEL [module] message key=value` (pm2 captures them under `logs/`), plus rotating JSON files in `backend/logs/momarchive-YYYY-MM-DD.log` at debug level. Secrets, connection string passwords, `key=` query values and bearer tokens are redacted.
- One summary line per job tick (`runs-incremental done seen=.. new=.. apiCalls=.. ms=..`), `warn` for replays that were already gone (404), `error` only for real failures.
- CLI (`pnpm cli <command>`):
  - `sync`: catch up now. Backfill, then new runs, then drain the replay and refresh queues until empty.
  - `backfill [--phase p] [--only p]`
  - `reprocess-raw <raw/prefix> [--limit n]`: re-ingest stored raw pages (runs, maps, users)
  - `verify-replays [--limit n]`: re-hash every stored replay against its key
  - `requeue-replays [--include-404]`: retry failed downloads
  - `refresh-user <id>`, `refresh-map <id>`, `refresh-leaderboard <mapId:gamemode:trackType:trackNum:style>`
  - `job <name>`: run a scheduler job once (for example `job maps-walk`)
- Poller intervals: `POLL_RUNS_MINUTES` (10), `POLL_MAPS_HOURS` (6), `POLL_USERS_SWEEP_HOURS` (24), `POLL_LEADERBOARDS_SWEEP_HOURS` (24), `POLL_MAPS_WALK_HOURS` (24). `REPLAY_CONCURRENCY` (4). `POLLER_ENABLED=false` runs the API only.

## HTTP API

Read only JSON under `/api`, ETag and `Cache-Control` on everything, OpenAPI at `/api/openapi.json`. Highlights:

| Endpoint                                                                                                  | Notes                                                                                         |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/users?q=&country=&role=&ban=&banned=&sort=&page=`                                               | search current and past aliases, Steam names, SourceBans names; country, role and ban filters |
| `GET /api/users/:id`                                                                                      | current state + Steam + history + alias/avatar timelines + stats over time + SourceBans       |
| `GET /api/users/:id/runs?gamemode=&style=&mapId=&removed=&page=`                                          | all runs including removed ones                                                               |
| `GET /api/users/:id/follow-events`, `/follows`                                                            |                                                                                               |
| `GET /api/maps?q=&gamemode=&bucket=released\|beta\|other&lbType=&native=&page=`                           |                                                                                               |
| `GET /api/maps/:idOrName`                                                                                 | detail with leaderboards, versions, images, credits, history                                  |
| `GET /api/maps/:id/leaderboard?gamemode=&trackType=&trackNum=&style=&at=`                                 | current (removed entries marked) or as of a time                                              |
| `GET /api/maps/:id/leaderboard/observations`                                                              | points in time available                                                                      |
| `GET /api/maps/:id/leaderboard/diff?from=&to=`                                                            | added, removed, improved                                                                      |
| `GET /api/runs?removed=true&page=`                                                                        | deleted runs feed                                                                             |
| `GET /api/runs/:id`                                                                                       | run detail with replay header                                                                 |
| `GET /api/replays/:sha1`, `/download`                                                                     | metadata; streamed `.momtv` with Range support, `Content-Disposition: attachment`             |
| `GET /api/avatars/:hash`, `/api/maps/images/:id`                                                          | archived images                                                                               |
| `GET /api/maps/bsp/:bspHash`                                                                              | one map version's BSP, Range support; from storage or streamed from the CDN, for the player   |
| `GET /api/records?gamemode=&trackType=&style=&mapId=&page=`                                               | current world records, newest first                                                           |
| `GET /api/announcements`                                                                                  | active site banners, plain text                                                               |
| `GET /api/search?q=`                                                                                      | one box: aliases (current and past), Steam names, SteamID64/3/2, Momentum id, map names       |
| `GET /api/changes?type=alias\|avatar\|ban\|role\|removed_run\|steam_name\|steam_avatar\|vac\|new_wr\|map` | global feed                                                                                   |
| `GET /api/stats`, `/api/status`, `/api/about`, `/api/health`                                              |                                                                                               |

Every route has a JSON schema; ids are integers, `page`/`take` are bounded, `q` is capped at 100 characters, dates are parsed. Errors are generic (`{ error, statusCode, requestId }`), never database text. Rate limit: 240 requests/minute per client IP. Only `GET` and `HEAD` are accepted, the owner's `/api/auth/` and `/api/admin/` routes aside, and those are kept out of the OpenAPI document.

## Database

Postgres 16, Drizzle ORM, migrations in `backend/drizzle` applied on boot (and by `pnpm migrate`). Main tables:

`users`, `user_snapshots`, `user_field_changes`, `avatars`, `steam_profiles`, `steam_profile_snapshots`, `steam_field_changes`, `steam_name_history`, `steam_avatar_history`, `steam_sourcebans`, `follows`, `follow_events`, `maps`, `map_snapshots`, `map_field_changes`, `map_versions`, `map_images`, `map_credits`, `leaderboards`, `runs`, `leaderboard_entries`, `leaderboard_observations`, `leaderboard_snapshots`, `replays`, `replay_queue`, `replay_fetch_failures`, `activities`, `sync_state`, `poll_log`, `refresh_queue`, `fetch_failures`, `kv`, and the `search_index` materialized view (refreshed every 10 minutes).

Five more tables belong to the panel and are the only ones the HTTP process can write: `admin_sessions`, `announcements`, `user_notices`, `admin_audit`, `request_log`.

All timestamps are `timestamptz`. Momentum's own `createdAt` is stored as `momentum_created_at`, separate from the archive's `observed_at` / `first_seen_at` / `last_seen_at`.

## Adding a gamemode

1. Set `ARCHIVE_GAMEMODES=3,2` (comma separated Gamemode ids, see `backend/src/momentum/enums.ts`).
2. `pnpm pm2:reload`. From then on runs in the new mode are stored, `maps-sweep` lists its maps, `maps-walk` marks maps with that leaderboard as archived, and `leaderboards-full-sweep` refreshes them.
3. Run `pnpm cli backfill --phase runs` to pick up history for the new mode (the runs feed is global, so this re-walks everything; it is idempotent).

The schema has no single gamemode assumption; every run, leaderboard and replay row carries its gamemode.

## Development

```sh
pnpm install
cp .env.example .env     # point at a dev Postgres + RustFS, NODE_ENV=development
pnpm dev                 # backend with tsx watch on 5771 + vite on 5173 proxying /api
pnpm test                # vitest: unit tests and PGlite backed integration tests, no services needed
LIVE_TESTS=1 pnpm --filter backend test -- test/live.test.ts   # opt-in checks against the real API
pnpm lint && pnpm typecheck && pnpm format:check
pnpm --filter backend drizzle:generate   # after editing src/db/schema.ts
```

Tests never commit replay bytes: the live test keeps the downloaded replay in memory, and unit tests build synthetic headers.

## Security notes

- The repo is public. `.gitignore` excludes `.env`, logs, pm2 dumps and any `*.momtv`/`*.mtv`/`*.bsp`. `lefthook` runs `gitleaks protect --staged` on every commit. CI runs `pnpm audit` and gitleaks. Renovate keeps pinned dependencies current.
- The HTTP API reads with the read-only Postgres role; only the poller uses the read-write role. Queries are parameterized through Drizzle / tagged SQL.
- S3 credentials never reach the browser; downloads stream through `/api/replays/:sha1/download` with `X-Content-Type-Options: nosniff` and `application/octet-stream`.
- The frontend renders aliases, bios, descriptions and changelogs as text. Social links are built only for allowlisted hosts and validated handles, with `rel="noopener noreferrer nofollow"`.
- The data API has no write endpoints and no auth. The single exception is the owner's panel at `/admin`: see [The owner's panel](#the-owners-panel). It writes through a third role that can only touch its own five tables, so the archive itself stays unwritable from the web, and its poller controls only ask the poller to fetch again. It does not exist at all unless `APP_SECRET`, `ADMIN_STEAM_IDS` and `DATABASE_URL_APP` are set. Everything else in maintenance is the CLI.

## License

MIT.
