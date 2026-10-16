<script lang="ts">
  import { GAMEMODES, LB_TYPES, MAP_STATUS, STYLES, TRACK_TYPES } from '../lib/format';

  interface Endpoint {
    path: string;
    desc: string;
  }
  const searchUsers: Endpoint[] = [
    {
      path: 'GET /api/search?q=',
      desc: 'One box for everything. Matches current and past Momentum aliases, current and past Steam names, SourceBans names, SteamID64 / SteamID3 / SteamID2, Momentum user id and map names. Returns { users, maps } with matchedOn telling which field hit, 20 of each at most.',
    },
    {
      path: 'GET /api/users?q=&country=&role=&ban=&banned=&sort=&page=&take=',
      desc: 'List or search users. The search also matches past aliases and Steam names. country is a 2 letter code, role and ban are bit values (see enums below), banned=true means any ban. sort: recent (default), alias, id, country.',
    },
    {
      path: 'GET /api/users/:id',
      desc: 'Everything about a user: current state, Steam profile and bans, the full field change history (Momentum and Steam merged), alias and avatar timelines with sources, stats over time, SourceBans records, map credits and counts.',
    },
    {
      path: 'GET /api/users/:id/runs?gamemode=&style=&mapId=&removed=&page=',
      desc: 'All archived runs of the user, newest first. removed=true gives only runs deleted upstream.',
    },
    {
      path: 'GET /api/users/:id/follows',
      desc: 'Current followers and follows with aliases.',
    },
    {
      path: 'GET /api/users/:id/follow-events?page=',
      desc: 'Observed follow and unfollow events involving the user.',
    },
    {
      path: 'GET /api/avatars/:hash',
      desc: 'Archived avatar image by its 40 hex hash. Served even after Steam deleted the original.',
    },
  ];
  const mapsLb: Endpoint[] = [
    {
      path: 'GET /api/maps?q=&gamemode=&bucket=&lbType=&native=&sort=&page=',
      desc: 'List maps. bucket: released, beta (public testing and final approval) or other. lbType filters by leaderboard type, native by a gamemode the map was built for.',
    },
    {
      path: 'GET /api/maps/:idOrName',
      desc: 'Map detail by id or exact name: info, stats, every leaderboard with entry counts, versions with changelogs, image gallery, credits and the field change history.',
    },
    {
      path: 'GET /api/maps/:id/leaderboard?gamemode=&trackType=&trackNum=&style=&at=&page=',
      desc: 'The leaderboard now, or as it was at any past moment using at= (ISO date). Removed entries are included and flagged with removedAt. Each entry carries the alias and avatar observed at the time of the run plus the current ones.',
    },
    {
      path: 'GET /api/maps/:id/leaderboard/observations?gamemode=&trackType=&trackNum=&style=',
      desc: 'The distinct points in time available for the at= parameter, with how long each observation stayed valid.',
    },
    {
      path: 'GET /api/maps/:id/leaderboard/diff?from=&to=&gamemode=&trackType=&trackNum=&style=',
      desc: 'What changed between two times: entries added, removed and improved.',
    },
    {
      path: 'GET /api/maps/images/:id',
      desc: 'Archived map image (large variant) by image id.',
    },
    {
      path: 'GET /api/maps/bsp/:bspHash',
      desc: 'The BSP of one map version, keyed by its bspHash, with Range support. Served from the archive when it has the file, streamed from the official CDN otherwise. This is what makes in browser playback possible: the official CDN sends no CORS headers.',
    },
  ];
  const runsReplays: Endpoint[] = [
    {
      path: 'GET /api/runs?gamemode=&style=&mapId=&userId=&removed=&pbOnly=&page=',
      desc: 'Run feed, newest first. removed=true is the deleted runs feed: runs whose leaderboard entry or whole run vanished upstream.',
    },
    {
      path: 'GET /api/runs/:id',
      desc: 'Run detail: all fields, splits when known, replay header and download link, or the download failure record when the replay was gone before the archive reached it.',
    },
    {
      path: 'GET /api/replays/:sha1',
      desc: 'Replay metadata by sha1: size, parsed header, header checks against the run, observed identity, and mapBsp: the map version to play it back on, resolved from the hash the replay recorded.',
    },
    {
      path: 'GET /api/replays/:sha1/download',
      desc: 'The .momtv file, streamed with Range support. The filename carries the map, the alias observed at the time and the run time.',
    },
  ];
  const meta: Endpoint[] = [
    {
      path: 'GET /api/records?gamemode=&trackType=&style=&mapId=&page=',
      desc: 'Current world records: the first place of every leaderboard, newest first, with the time, the track, the holder and the replay hash.',
    },
    {
      path: 'GET /api/changes?type=&page=',
      desc: 'Global recent changes feed. type: alias, avatar, ban, role, removed_run, steam_name, steam_avatar, vac, new_wr, deleted_user, map.',
    },
    {
      path: 'GET /api/stats',
      desc: 'Archive totals, per gamemode counts, last tick per job, storage usage.',
    },
    {
      path: 'GET /api/status',
      desc: 'Component health, the same data as the status page. Cached 15 seconds.',
    },
    { path: 'GET /api/about', desc: 'What this instance archives and since when.' },
    { path: 'GET /api/health', desc: 'Liveness: { ok, schema }.' },
    {
      path: 'GET /api/openapi.json',
      desc: 'The machine readable OpenAPI 3.1 spec of everything above.',
    },
  ];

  const enumTable = (m: Record<number, string>) => Object.entries(m).map(([k, v]) => [k, v]);
</script>

<h1>API</h1>
<p>
  Everything on this site comes from a public, read only JSON API under
  <span class="mono">https://momarchive.caixa.cc/api</span>. No key, no login, no write endpoints.
  Only <span class="mono">GET</span> and <span class="mono">HEAD</span> are accepted. The machine
  readable spec lives at
  <a href="/api/openapi.json" rel="external">/api/openapi.json</a>; this page is the human version.
</p>

<h2>Basics</h2>
<ul>
  <li>
    <strong>Rate limit:</strong> 240 requests per minute per IP. Going over returns
    <span class="mono">429</span> with <span class="mono">retry-after</span> and
    <span class="mono">x-ratelimit-*</span> headers. Please keep automated access reasonable; this is
    a free archive on one small server.
  </li>
  <li>
    <strong>Caching:</strong> every response carries an <span class="mono">ETag</span> and
    <span class="mono">Cache-Control</span>. Send <span class="mono">If-None-Match</span> and a
    <span class="mono">304</span> costs you almost nothing.
  </li>
  <li>
    <strong>Pagination:</strong> list endpoints take <span class="mono">page</span> (from 1) and
    <span class="mono">take</span> (default 50, max 100) and answer with an envelope:
  </li>
</ul>
<pre>{`{ "total": 1234, "page": 1, "take": 50, "data": [ ... ] }`}</pre>
<ul>
  <li>
    <strong>Errors</strong> are generic on purpose:
    <span class="mono">&#123; "error", "statusCode", "requestId" &#125;</span>. Invalid parameters
    give <span class="mono">400</span>; ids are integers, dates are ISO 8601, replay hashes are 40
    hex characters.
  </li>
  <li>
    <strong>Timestamps:</strong> fields named <span class="mono">momentumCreatedAt</span> are
    Momentum's own clock; <span class="mono">firstSeenAt</span>,
    <span class="mono">lastSeenAt</span>, <span class="mono">observedAt</span> and
    <span class="mono">removedAt</span> are when this archive saw it. History before the archive started
    watching does not exist anywhere.
  </li>
</ul>

<h2>Search and users</h2>
<div class="table-wrap">
  <table>
    <thead><tr><th>Endpoint</th><th>What it gives you</th></tr></thead>
    <tbody>
      {#each searchUsers as e (e.path)}
        <tr><td class="mono">{e.path}</td><td>{e.desc}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h2>Maps and leaderboards</h2>
<div class="table-wrap">
  <table>
    <thead><tr><th>Endpoint</th><th>What it gives you</th></tr></thead>
    <tbody>
      {#each mapsLb as e (e.path)}
        <tr><td class="mono">{e.path}</td><td>{e.desc}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h2>Runs and replays</h2>
<div class="table-wrap">
  <table>
    <thead><tr><th>Endpoint</th><th>What it gives you</th></tr></thead>
    <tbody>
      {#each runsReplays as e (e.path)}
        <tr><td class="mono">{e.path}</td><td>{e.desc}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h2>Archive meta</h2>
<div class="table-wrap">
  <table>
    <thead><tr><th>Endpoint</th><th>What it gives you</th></tr></thead>
    <tbody>
      {#each meta as e (e.path)}
        <tr><td class="mono">{e.path}</td><td>{e.desc}</td></tr>
      {/each}
    </tbody>
  </table>
</div>

<h2>Examples</h2>
<pre>{`# who is this player, under any name they ever had
curl 'https://momarchive.caixa.cc/api/search?q=STEAM_0:1:462683303'

# the Bhop HL1 leaderboard of a map as it was on new year
curl 'https://momarchive.caixa.cc/api/maps/730/leaderboard?gamemode=3&at=2026-01-01T00:00:00Z'

# every run an admin deleted, newest first
curl 'https://momarchive.caixa.cc/api/runs?removed=true'

# download a replay Momentum no longer has
curl -OJ 'https://momarchive.caixa.cc/api/replays/cb2633f17166c7a69c51929a0afd1a172bf1407f/download'`}</pre>

<h2>Enum values</h2>
<p>Numeric fields in responses use Momentum's own enums. The ones you will actually need:</p>
<div class="cols">
  <div>
    <h3>gamemode</h3>
    <table>
      <tbody>
        {#each enumTable(GAMEMODES) as [k, v] (k)}
          <tr><td class="num">{k}</td><td>{v}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div>
    <h3>style</h3>
    <table>
      <tbody>
        {#each enumTable(STYLES) as [k, v] (k)}
          <tr><td class="num">{k}</td><td>{v}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
  <div>
    <h3>trackType</h3>
    <table>
      <tbody>
        {#each enumTable(TRACK_TYPES) as [k, v] (k)}
          <tr><td class="num">{k}</td><td>{v}</td></tr>
        {/each}
      </tbody>
    </table>
    <h3>map status</h3>
    <table>
      <tbody>
        {#each enumTable(MAP_STATUS) as [k, v] (k)}
          <tr><td class="num">{k}</td><td>{v}</td></tr>
        {/each}
      </tbody>
    </table>
    <h3>leaderboard type</h3>
    <table>
      <tbody>
        {#each enumTable(LB_TYPES) as [k, v] (k)}
          <tr><td class="num">{k}</td><td>{v}</td></tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<h2>Fair use</h2>
<p>
  The archive exists so this data survives; using the API is the point. Cache what you fetch,
  identify your tool with a User-Agent if you build something on top, and if you want a bulk export
  instead of crawling, write to
  <a href="mailto:westlargo@proton.me" rel="noopener noreferrer">westlargo@proton.me</a> and we will find
  something cheaper for both sides.
</p>

<style>
  .cols {
    display: flex;
    flex-wrap: wrap;
    gap: 0 2rem;
  }
  .cols > div {
    flex: 1 1 14rem;
  }
  .cols table {
    width: auto;
    min-width: 12rem;
  }
  h3 {
    margin: 0.8rem 0 0.2rem;
    font-size: 0.95rem;
  }
</style>
