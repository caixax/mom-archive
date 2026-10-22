<script lang="ts">
  import { api } from '../lib/api';
  import { formatDate } from '../lib/format';

  interface About {
    since: string | null;
    gamemodes: { id: number; name: string }[];
    pollIntervalMinutes: number;
    steamEnabled: boolean;
    steamHistoryEnabled: boolean;
    bspsArchived: boolean;
  }
  let about = $state<About | null>(null);
  $effect(() => {
    api<About>('/api/about')
      .then((a) => (about = a))
      .catch(() => undefined);
  });
</script>

<h1>About</h1>
<p>
  mom-archive is a public, read only archive of Momentum Mod leaderboard data. It polls the official
  public API on a schedule, stores every run it observes, downloads every replay file before
  Momentum deletes it, and keeps a full change history of users (alias, avatar, bio, socials, roles,
  bans, stats), maps, leaderboards and follows.
</p>
<p>
  Momentum itself keeps none of this history: only the current personal best replay of each
  leaderboard survives (the previous one is deleted the moment a player improves), alias and avatar
  are single overwritten columns, and runs deleted by admins vanish from the public API without a
  trace. The archive exists to preserve what Momentum throws away.
</p>

<h2>What is archived</h2>
{#if about}
  <ul>
    <li>
      Gamemodes: {about.gamemodes.map((g) => g.name).join(', ')}. Runs in these modes on any map,
      including maps built for other modes.
    </li>
    <li>
      Since: <span class="mono"
        >{about.since ? formatDate(about.since) : 'no runs recorded yet'}</span
      >. History before that date is unknown; the archive never fabricates or backfills what it did
      not observe.
    </li>
    <li>
      Runs are polled every {about.pollIntervalMinutes} minutes; leaderboards are re-read when a run touches
      them and fully once a day; users and maps are swept daily and every 6 hours respectively.
    </li>
    <li>
      Replays (.momtv) are downloaded as soon as a new replay hash is seen, sha1 verified, header
      parsed, and kept forever.
    </li>
    <li>
      Every API response body is stored raw, so the database can be rebuilt if the schema changes.
    </li>
    <li>
      Steam side: {about.steamEnabled
        ? 'persona names, avatars and VAC / game ban status are polled from the Steam Web API and diffed.'
        : 'Steam Web API polling is disabled on this instance.'}
    </li>
    <li>
      SourceBans: {about.steamHistoryEnabled
        ? 'ban records from SteamHistory.net, including the name the player had on the banning server.'
        : 'disabled on this instance.'}
    </li>
    <li>
      Map BSP files: {about.bspsArchived ? 'archived.' : 'not archived (only metadata and images).'}
    </li>
  </ul>
{/if}

<h2>What cannot be rescued</h2>
<ul>
  <li>
    Replays deleted before the archive started watching, or replaced between two polls of a
    leaderboard that nothing else touched.
  </li>
  <li>Replays of runs that were never a personal best: Momentum never uploads those.</li>
  <li>Runs that admins moved to the private deleted files bucket; the API never exposed them.</li>
  <li>
    Anything behind a login: notifications, reports, chat bans, admin activity, maps in private
    testing.
  </li>
  <li>
    Steam history from before the archive first saw a player. Name and avatar history is built from
    the archive's own polling plus SourceBans records, never by scraping steamcommunity.com.
  </li>
</ul>

<h2>Point in time identity</h2>
<p>
  Every run, leaderboard entry and replay carries the alias and avatar the player had when the
  archive observed it. When a player later renames, the rows are not rewritten: the change lands in
  the user's timeline and the leaderboard shows both the name at the time and the current one.
</p>

<h2>Watching replays</h2>
<p>
  Every archived replay has a "view" link that plays it here in the browser, on the map it was
  recorded on, with
  <a href="https://github.com/caixax/momtv.js" rel="external noopener noreferrer nofollow"
    >momtv.js</a
  >. The map comes from this site (the official CDN sends no CORS headers), and the archive serves
  the very version the run was recorded on when it has it, so the geometry matches what the runner
  played. Materials the map does not pack itself are drawn as flat colours: no game files are served
  here.
</p>
<p>
  For the real thing, download the .momtv file, drop it into the game's replay folder and open it
  from the MomentumTV menu.
</p>

<h2>API</h2>
<p>
  Everything on this site comes from the public JSON API under <span class="mono">/api</span>. See
  the <a href="/docs">API page</a> for endpoints, rate limits and examples, or
  <a href="/api/openapi.json" rel="external">/api/openapi.json</a> for the machine readable spec.
</p>

<h2>Banners and profile notes</h2>
<p>
  A banner at the top of a page, or a note on a player's page, is written by whoever runs this
  archive, never by Momentum and never by the player. They are plain text and say nothing the
  archive observed: the data itself is always the tables and timelines below them.
</p>

<h2>What this site records about visitors</h2>
<p>
  No cookies, no accounts for reading, no third party scripts and no analytics service. The server
  keeps a log of requests (address, country as Cloudflare reports it, path, browser string) for 30
  days to spot abuse, and then deletes it. Opening a page sends one small request naming that page,
  plus, on the first page of a visit, the site that linked here; browsers set to Do Not Track or
  Global Privacy Control skip it. What is kept beyond the 30 days is only daily totals: how many
  visitors and page views, which pages, countries, browsers and referring sites. No address or
  browser string survives into those.
</p>

<h2>Contact</h2>
<p>
  Questions, takedown requests or data corrections:
  <a href="mailto:westlargo@proton.me" rel="noopener noreferrer">westlargo@proton.me</a>.
</p>
