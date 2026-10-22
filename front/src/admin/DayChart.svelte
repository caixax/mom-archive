<script lang="ts">
  // Per day bars with an optional line on top, drawn as plain SVG. Hovering a day
  // shows its numbers. Days with no data are drawn as gaps, not as zeroes.
  import { formatInt } from '../lib/format';

  interface Props {
    days: string[];
    bars: (number | null)[];
    line?: (number | null)[];
    barLabel: string;
    lineLabel?: string;
    height?: number;
  }
  let { days, bars, line, barLabel, lineLabel, height = 140 }: Props = $props();

  const W = 1000;
  const peak = $derived(
    Math.max(1, ...bars.map((b) => b ?? 0), ...(line ?? []).map((l) => l ?? 0)),
  );
  const step = $derived(W / Math.max(1, days.length));
  const y = (v: number) => height - (v / peak) * (height - 6);
  const path = $derived.by(() => {
    if (!line) return '';
    let d = '';
    line.forEach((v, i) => {
      if (v === null) return;
      d += `${d ? 'L' : 'M'}${(i + 0.5) * step},${y(v)}`;
    });
    return d;
  });
  let hover = $state<number | null>(null);
</script>

<div class="chart">
  <svg
    viewBox={`0 0 ${W} ${height}`}
    preserveAspectRatio="none"
    role="img"
    aria-label={barLabel}
    onmouseleave={() => (hover = null)}
  >
    {#each bars as b, i (days[i])}
      <rect
        x={i * step + step * 0.12}
        width={Math.max(1, step * 0.76)}
        y={b === null ? height : y(b)}
        height={b === null ? 0 : height - y(b)}
        class:hot={hover === i}
        role="presentation"
        onmouseenter={() => (hover = i)}
      />
    {/each}
    {#if path}<path d={path} vector-effect="non-scaling-stroke" />{/if}
  </svg>
  <div class="legend small">
    {#if hover !== null}
      <span class="mono">{days[hover]}</span>
      <span><i class="sw bar"></i>{barLabel} {formatInt(bars[hover] ?? 0)}</span>
      {#if line && lineLabel}<span
          ><i class="sw line"></i>{lineLabel} {formatInt(line[hover] ?? 0)}</span
        >{/if}
    {:else}
      <span class="muted">{days[0] ?? ''} to {days[days.length - 1] ?? ''}</span>
      <span><i class="sw bar"></i>{barLabel}</span>
      {#if lineLabel}<span><i class="sw line"></i>{lineLabel}</span>{/if}
      <span class="muted">peak {formatInt(peak)}</span>
    {/if}
  </div>
</div>

<style>
  .chart {
    margin: 0.4rem 0 1rem;
  }
  svg {
    width: 100%;
    height: 9rem;
    display: block;
    background: var(--bg-2);
    border: 1px solid var(--border);
    border-radius: 4px;
  }
  rect {
    fill: var(--accent);
    opacity: 0.45;
  }
  rect.hot {
    opacity: 0.9;
  }
  path {
    fill: none;
    stroke: var(--ok);
    stroke-width: 2;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 1rem;
    margin-top: 0.3rem;
    min-height: 1.2rem;
  }
  .sw {
    display: inline-block;
    width: 0.8rem;
    height: 0.5rem;
    margin-right: 0.3rem;
    vertical-align: middle;
  }
  .sw.bar {
    background: var(--accent);
    opacity: 0.6;
  }
  .sw.line {
    height: 2px;
    background: var(--ok);
  }
</style>
