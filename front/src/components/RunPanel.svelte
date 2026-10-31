<script lang="ts">
  // What opens inside a leaderboard row: the run's own numbers on the left, every
  // attempt the archive saw from that player on this board on the right, and the
  // strafe graph underneath.
  //
  // The numbers come from the replay file itself, read in the browser, so nothing
  // had to be precomputed and a run whose leaderboard entry is long gone still
  // measures the same. The attempts come from the archive, which is the only place
  // they exist at all.
  import { api, type Paged, type RunRow } from '../lib/api';
  import { formatDate, formatInt, formatTime } from '../lib/format';
  import type { ReplayAnalysis } from '../lib/replay-analysis';
  import StrafeGraph from './StrafeGraph.svelte';

  interface Props {
    userId: number;
    mapId: number;
    gamemode: number;
    trackType: number;
    trackNum: number;
    style: number;
    time: number;
    replayHash: string | null;
    replayArchived: boolean;
    pastRunId: number | null;
    /** The run's own page already carries these, so it turns them off. */
    showActions?: boolean;
  }
  let {
    userId,
    mapId,
    gamemode,
    trackType,
    trackNum,
    style,
    time,
    replayHash,
    replayArchived,
    pastRunId,
    showActions = true,
  }: Props = $props();

  let attempts = $state<RunRow[] | null>(null);
  let attemptsTotal = $state(0);
  let attemptsError = $state<string | null>(null);

  let analysis = $state<ReplayAnalysis | null>(null);
  let analysisError = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    api<Paged<RunRow>>(`/api/users/${userId}/runs`, {
      mapId,
      gamemode,
      trackType,
      trackNum,
      style,
      take: 100,
    })
      .then((r) => {
        attempts = r.data;
        attemptsTotal = r.total;
      })
      .catch((e) => (attemptsError = String(e.message)));
  });

  // The reader is only fetched when a row is actually opened.
  $effect(() => {
    if (!replayHash || !replayArchived) return;
    let dropped = false;
    loading = true;
    analysisError = null;
    void (async () => {
      try {
        const { analyseReplay } = await import('../lib/replay-analysis');
        const a = await analyseReplay(replayHash);
        if (!dropped) analysis = a;
      } catch (e) {
        if (!dropped) analysisError = e instanceof Error ? e.message : String(e);
      } finally {
        if (!dropped) loading = false;
      }
    })();
    return () => {
      dropped = true;
    };
  });

  const best = $derived(
    attempts && attempts.length > 0 ? Math.min(...attempts.map((a) => a.time)) : time,
  );
  const units = 'u/s';
</script>

<div class="panel">
  <div class="cols">
    <section class="stats">
      <h4>Run</h4>
      {#if analysis}
        {@const s = analysis.stats}
        <dl>
          <dt>Run time</dt>
          <dd class="mono">{formatTime(s.runTime)}</dd>
          <dt>Avg speed</dt>
          <dd class="mono">{formatInt(Math.round(s.avgSpeed))} {units}</dd>
          <dt>Max speed</dt>
          <dd class="mono">
            {formatInt(Math.round(s.maxSpeed))}
            {units}
            <span class="muted small"
              >({formatInt(Math.round(s.maxOverallSpeed))} with vertical)</span
            >
          </dd>
          <dt>End speed</dt>
          <dd class="mono">{formatInt(Math.round(s.endSpeed))} {units}</dd>
          <dt>Prestrafe</dt>
          <dd class="mono">{formatInt(Math.round(s.prestrafeSpeed))} {units}</dd>
          <dt>Sync</dt>
          <dd class="mono">
            {(s.sync * 100).toFixed(1)}%
            <span class="muted small">of turning air ticks</span>
          </dd>
          <dt>Speed gain</dt>
          <dd class="mono">
            {formatInt(Math.round(s.speedGain))}
            {units}
            <span class="muted small">({formatInt(Math.round(s.airSpeedGain))} in the air)</span>
          </dd>
          <dt>Slowdowns</dt>
          <dd class="mono">
            {formatInt(s.slowdowns)}
            <span class="muted small">({formatInt(Math.round(s.speedLost))} {units} lost)</span>
          </dd>
          <dt>On ground</dt>
          <dd class="mono">
            {s.groundTime.toFixed(2)} s
            <span class="muted small">({(s.groundShare * 100).toFixed(1)}% of the run)</span>
          </dd>
          <dt>Strafes</dt>
          <dd class="mono">
            {formatInt(s.strafes)}
            <span class="muted small">({s.strafesPerSecond.toFixed(1)} per second)</span>
          </dd>
          <dt>Jumps</dt>
          <dd class="mono">{formatInt(s.jumps)}</dd>
          <dt>Duck taps</dt>
          <dd class="mono">{formatInt(s.duckTaps)}</dd>
          <dt>Distance</dt>
          <dd class="mono">{formatInt(Math.round(s.horizontalDistance))} u</dd>
          <dt>Distance 3D</dt>
          <dd class="mono">{formatInt(Math.round(s.overallDistance))} u</dd>
          <dt>Ticks</dt>
          <dd class="mono">
            {formatInt(s.ticks)} at {Math.round(1 / s.tickInterval)} per second
            {#if s.lostFrames > 0}<span class="badge warn">{s.lostFrames} lost</span>{/if}
          </dd>
          <dt>Recorded</dt>
          <dd class="mono small">
            {formatDate(new Date(s.recordedAt).toISOString())}, format v{s.formatVersion}
          </dd>
        </dl>
        <details class="how small">
          <summary>Where these come from</summary>
          <p>
            Max speed, prestrafe, both distances, jumps and strafes are the numbers the game itself
            wrote into the file. Avg speed is the horizontal distance over the run time.
          </p>
          <p>
            The rest is counted here from the recorded ticks, because the file does not carry it,
            and timers do not all count it the same way. <b>Sync</b> is the share of airborne ticks
            that were both turning and holding one strafe key where the key matched the turn.
            <b>Speed gain</b> adds up every tick that gained horizontal speed.
            <b>Slowdowns</b> counts the times airborne speed dropped by more than 5 {units} in a tick,
            merging the ticks of one hit, and adds up what was lost. <b>On ground</b> is the ticks
            with the ground flag set. <b>Duck taps</b> are duck presses in the air, counted once per
            press. <b>End speed</b> is the last recorded tick.
          </p>
        </details>
      {:else if loading}
        <p class="muted">Reading the replay.</p>
      {:else if analysisError}
        <p class="error small">{analysisError}</p>
      {:else if replayHash && !replayArchived}
        <p class="muted small">
          The replay was gone from Momentum before the archive could fetch it, so there is nothing
          to measure. The run itself is still recorded.
        </p>
      {:else}
        <p class="muted small">
          This run never had a replay: Momentum only uploads personal bests.
        </p>
      {/if}
    </section>

    <section class="attempts">
      <h4>
        Attempts
        {#if attempts}<span class="muted small">{formatInt(attemptsTotal)} seen</span>{/if}
      </h4>
      {#if attemptsError}
        <p class="error small">{attemptsError}</p>
      {:else if !attempts}
        <p class="muted">Loading.</p>
      {:else if attempts.length === 0}
        <p class="muted small">No runs of this track from this player are in the archive.</p>
      {:else}
        <div class="table-wrap">
          <table>
            <thead
              ><tr><th>Day</th><th class="num">Time</th><th class="num">vs best</th><th></th></tr
              ></thead
            >
            <tbody>
              {#each attempts as a (a.id)}
                <tr>
                  <td class="mono small" title={formatDate(a.momentumCreatedAt)}
                    >{formatDate(a.momentumCreatedAt, false)}</td
                  >
                  <td class="num mono">{formatTime(a.time)}</td>
                  <td class="num mono small muted"
                    >{a.time === best ? 'best' : `+${(a.time - best).toFixed(3)}`}</td
                  >
                  <td class="small">
                    {#if a.isPb}<span class="badge accent">PB</span>{/if}
                    {#if a.removedAt}<span class="badge removed">removed</span>{/if}
                    <a href={`/runs/${a.id}`} class="mono">#{a.id}</a>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <p class="muted small">
          Only what the archive observed. Attempts from before it started watching are not known to
          anyone, Momentum included.
        </p>
      {/if}
    </section>
  </div>

  {#if analysis}
    <StrafeGraph
      buckets={analysis.buckets}
      yawPeak={analysis.yawPeak}
      speedPeak={analysis.speedPeak}
    />
    {@const g = analysis.signals}
    <div class="signals small">
      <span><b>{formatInt(g.reversals)}</b> strafe changes</span>
      <span><b>{(g.sharpShare * 100).toFixed(0)}%</b> with no sample near zero</span>
      <span><b>{formatInt(g.medianWidth)}</b> median ticks near zero</span>
      <span><b>{formatInt(Math.round(g.medianDeceleration))}</b> median peak change</span>
      <span><b>{g.flatness.toFixed(3)}</b> rate variation</span>
    </div>
    <p class="muted small">
      These five are measurements of the angles in the file, nothing more: how often the turn
      changed direction, how abruptly, and how even the turn rate stayed between changes. They are
      not a judgement about a player.
    </p>
  {/if}

  {#if showActions}
    <p class="actions">
      {#if pastRunId}<a href={`/runs/${pastRunId}`}
          ><button class="primary">Open this run</button></a
        >{/if}
      {#if replayHash && replayArchived}
        <a href={`/api/replays/${replayHash}/download`} rel="external" download
          ><button>Download .momtv</button></a
        >
      {/if}
      <a href={`/users/${userId}`}><button>Player</button></a>
    </p>
  {/if}
</div>

<style>
  .panel {
    padding: 0.75rem 0.5rem 1rem;
    background: var(--bg-2);
    border-left: 3px solid var(--accent);
  }
  .cols {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 1.5rem;
  }
  @media (max-width: 900px) {
    .cols {
      grid-template-columns: 1fr;
    }
  }
  h4 {
    margin: 0 0 0.4rem;
    font-size: 0.95rem;
    display: flex;
    gap: 0.5rem;
    align-items: baseline;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.15rem 0.75rem;
    margin: 0 0 0.5rem;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
  .how {
    color: var(--muted);
    margin: 0 0 0.5rem;
  }
  .how summary {
    cursor: pointer;
  }
  .how p {
    margin: 0.4rem 0;
  }
  .how b {
    color: var(--text);
  }
  .attempts .table-wrap {
    max-height: 16rem;
    overflow: auto;
  }
  .signals {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    color: var(--muted);
  }
  .signals b {
    color: var(--text);
    font-family: var(--mono);
  }
  .actions {
    margin: 0.75rem 0 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
