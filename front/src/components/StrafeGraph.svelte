<script lang="ts">
  // The strafe graph: how fast the view was turning, tick by tick, with the
  // recorded speed on top. Plain SVG, no chart library, so it costs nothing and
  // the page's own rules still hold.
  //
  // Each column is a time bucket: the band is the fastest turn each way inside
  // it and the line is the average, so a spike between two columns still shows.
  import type { Bucket } from '../lib/replay-analysis';
  import { formatInt } from '../lib/format';

  interface Props {
    buckets: Bucket[];
    yawPeak: number;
    speedPeak: number;
    height?: number;
  }
  let { buckets, yawPeak, speedPeak, height = 220 }: Props = $props();

  const W = 1000;
  const PAD = 4;
  let showSpeed = $state(true);
  let hover = $state<number | null>(null);

  const duration = $derived(buckets.length > 0 ? buckets[buckets.length - 1]!.t : 0);
  // A round scale, so the gridlines read as numbers a player recognises.
  const scale = $derived(Math.max(100, Math.ceil(Math.max(1, yawPeak) / 100) * 100));
  const speedScale = $derived(Math.max(100, Math.ceil(Math.max(1, speedPeak) / 100) * 100));
  const mid = $derived(height / 2);
  const step = $derived(W / Math.max(1, buckets.length));

  const yawY = (v: number) => mid - (v / scale) * (mid - PAD);
  const speedY = (v: number) => height - PAD - (v / speedScale) * (height - 2 * PAD);

  const band = $derived.by(() => {
    if (buckets.length === 0) return '';
    let top = '';
    let bottom = '';
    buckets.forEach((b, i) => {
      const x = (i + 0.5) * step;
      top += `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${yawY(b.yawMax).toFixed(2)}`;
      bottom = `L${x.toFixed(2)},${yawY(b.yawMin).toFixed(2)}${bottom}`;
    });
    return `${top}${bottom}Z`;
  });

  const meanLine = $derived.by(() =>
    buckets
      .map(
        (b, i) =>
          `${i === 0 ? 'M' : 'L'}${((i + 0.5) * step).toFixed(2)},${yawY(b.yawMean).toFixed(2)}`,
      )
      .join(''),
  );

  const speedLine = $derived.by(() =>
    buckets
      .map(
        (b, i) =>
          `${i === 0 ? 'M' : 'L'}${((i + 0.5) * step).toFixed(2)},${speedY(b.speed).toFixed(2)}`,
      )
      .join(''),
  );

  function onMove(e: MouseEvent) {
    const box = (e.currentTarget as SVGElement).getBoundingClientRect();
    if (box.width === 0 || buckets.length === 0) return;
    const i = Math.floor(((e.clientX - box.left) / box.width) * buckets.length);
    hover = Math.min(buckets.length - 1, Math.max(0, i));
  }

  const at = $derived(hover === null ? null : (buckets[hover] ?? null));
</script>

<div class="graph">
  <div class="head small">
    <span class="muted">Turn rate, degrees per second, over the run</span>
    <label class="toggle"><input type="checkbox" bind:checked={showSpeed} /> speed</label>
  </div>
  <svg
    viewBox={`0 0 ${W} ${height}`}
    preserveAspectRatio="none"
    role="img"
    aria-label="Turn rate over the run"
    onmousemove={onMove}
    onmouseleave={() => (hover = null)}
  >
    <line class="zero" x1="0" y1={mid} x2={W} y2={mid} />
    <line class="grid" x1="0" y1={yawY(scale / 2)} x2={W} y2={yawY(scale / 2)} />
    <line class="grid" x1="0" y1={yawY(-scale / 2)} x2={W} y2={yawY(-scale / 2)} />
    {#if band}<path class="band" d={band} />{/if}
    {#if meanLine}<path class="mean" d={meanLine} vector-effect="non-scaling-stroke" />{/if}
    {#if showSpeed && speedLine}
      <path class="speed" d={speedLine} vector-effect="non-scaling-stroke" />
    {/if}
    {#if hover !== null}
      <line class="cursor" x1={(hover + 0.5) * step} y1="0" x2={(hover + 0.5) * step} y2={height} />
    {/if}
  </svg>
  <div class="axis small mono">
    <span>0 s</span>
    <span class="muted"
      >+-{formatInt(scale)} deg/s{#if showSpeed}, speed to {formatInt(speedScale)}{/if}</span
    >
    <span>{duration.toFixed(1)} s</span>
  </div>
  <div class="readout small mono">
    {#if at}
      t={at.t.toFixed(2)}s
      <span class="sw turn"></span>turn {formatInt(Math.round(at.yawMean))} (peak {formatInt(
        Math.round(at.yawMin),
      )} to {formatInt(Math.round(at.yawMax))})
      {#if showSpeed}<span class="sw sp"></span>speed {formatInt(Math.round(at.speed))}{/if}
    {:else}
      <span class="muted">Hover the graph to read a moment of the run.</span>
    {/if}
  </div>
</div>

<style>
  .graph {
    margin: 0.5rem 0;
  }
  .head,
  .axis,
  .readout {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: center;
  }
  .readout {
    justify-content: flex-start;
    gap: 0.6rem;
    min-height: 1.4em;
    flex-wrap: wrap;
  }
  .toggle {
    color: var(--muted);
    display: inline-flex;
    gap: 0.3rem;
    align-items: center;
  }
  svg {
    width: 100%;
    height: auto;
    display: block;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .zero {
    stroke: var(--border);
    stroke-width: 2;
  }
  .grid {
    stroke: var(--border);
    stroke-width: 1;
    stroke-dasharray: 4 6;
    opacity: 0.6;
  }
  .band {
    fill: var(--accent);
    opacity: 0.22;
  }
  .mean {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.2;
  }
  .speed {
    fill: none;
    stroke: var(--ok);
    stroke-width: 1.2;
    opacity: 0.85;
  }
  .cursor {
    stroke: var(--muted);
    stroke-width: 1;
    stroke-dasharray: 3 3;
  }
  .sw {
    display: inline-block;
    width: 0.7rem;
    height: 0.2rem;
    vertical-align: middle;
    margin-right: 0.2rem;
  }
  .sw.turn {
    background: var(--accent);
  }
  .sw.sp {
    background: var(--ok);
  }
</style>
