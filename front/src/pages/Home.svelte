<script lang="ts">
  // The archive stopped pulling data on 7 November 2026. The front page is only the
  // closing note now; everything archived until then can still be browsed.
  import { api } from '../lib/api';
  import { formatInt } from '../lib/format';

  interface Stats {
    totals: Record<string, number>;
  }

  let stats = $state<Stats | null>(null);

  $effect(() => {
    api<Stats>('/api/stats')
      .then((s) => (stats = s))
      .catch(() => undefined);
  });
</script>

<article class="closing">
  <h1>momarchive is closing</h1>

  <p>
    momarchive started on 14 October 2026 with a simple idea: keep every Bhop HL1 run in one place,
    so you could watch any replay without opening the game, and so nothing quietly disappeared when
    runs got removed or someone got caught cheating.
  </p>

  {#if stats}
    <p>
      In under a month it archived {formatInt(stats.totals.runs)} runs, {formatInt(
        stats.totals.replays,
      )} replays and {formatInt(stats.totals.maps)} maps, plus the history behind them: leaderboards as
      they looked on any given day, removed runs, name changes and bans for {formatInt(
        stats.totals.users,
      )} accounts.
    </p>
  {/if}

  <p>
    Everything was public from day one. No login, no ads, no donations, nothing behind a paywall.
    The API was open to anyone and the code is on
    <a href="https://github.com/caixax/mom-archive" rel="external noopener noreferrer">GitHub</a>. I
    never cared about money with this. It was made for the community, by someone who plays the game.
  </p>

  <p>
    When the archive's requests started getting blocked, I asked the Momentum team directly whether
    they were fine with it. Their answer was that it was putting too much load on their backend,
    that the archive should stop pulling replays, and that any other endpoint should be hit once
    every 24 hours at most. It's their backend, so that's their call. But an archive that updates
    once a day and can't keep replays isn't worth running, so momarchive stopped pulling data on 7
    November 2026.
  </p>

  <p>
    Everything archived until then stays here and can still be browsed:
    <a href="/maps">maps</a>, <a href="/users">players</a>, runs, replays and the
    <a href="/ledger">Ledger</a>. It just won't update anymore. The code stays on GitHub and
    <a href="https://github.com/caixax/momtv.js" rel="external noopener noreferrer">momtv.js</a>
    stays on npm, so if anyone wants to pick this up, it's all there.
  </p>

  <p>Thanks to everyone who used it, sent reports or just watched a few replays.</p>

  <p class="sign">caixa</p>
</article>

<style>
  .closing {
    max-width: 44rem;
  }
  .closing p {
    line-height: 1.6;
  }
  .sign {
    margin-top: 1.5rem;
  }
</style>
