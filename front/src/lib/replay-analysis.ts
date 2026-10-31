// Reads an archived .momtv in the browser and turns it into what a leaderboard row
// wants to show: the run's own numbers, a yaw delta series for the strafe graph, and
// a few measurements of how the angles were turned.
//
// Nothing here is invented. The speeds, distances, jumps and strafes are the ones
// the game wrote into the file's splits block; the series come from the recorded
// per tick track. Anything this module derives (an average, a signal) is labelled
// as derived where it is shown.
//
// This module is loaded on demand: it pulls in the replay reader, which has no
// business in the main bundle.
import { Button, FL_ONGROUND, parseReplay } from '@caixax/momtv';

/**
 * What a run adds up to.
 *
 * The fields marked `game` are the numbers the game itself wrote into the
 * file's splits block. The rest is worked out here from the recorded per tick
 * track, either because the file never carries it or because that file left it
 * at zero, which happens. Each one says in a comment exactly what it counts,
 * and the panel tells the reader which is which.
 */
export interface ReplayStats {
  /** Final time from the header, in seconds. */
  runTime: number;
  tickInterval: number;
  ticks: number;
  /** Horizontal distance over run time. */
  avgSpeed: number;
  /** game. Fastest horizontal speed. */
  maxSpeed: number;
  /** game. Fastest speed counting the vertical axis. */
  maxOverallSpeed: number;
  /** Horizontal speed when the timer started: the prestrafe into the run. */
  prestrafeSpeed: number;
  /** Horizontal speed on the last recorded tick. */
  endSpeed: number;
  /** Distance travelled on the horizontal plane. */
  horizontalDistance: number;
  /** Distance travelled in three dimensions. */
  overallDistance: number;
  /**
   * Whether the distances and the prestrafe came from the file or had to be
   * measured here: some replays carry a splits block with those fields at zero.
   */
  distanceFromPath: boolean;
  prestrafeFromPath: boolean;
  /** game. */
  jumps: number;
  /** game. */
  strafes: number;
  /** Strafes per second. */
  strafesPerSecond: number;
  /** Seconds with the ground flag set, and that over the run time. */
  groundTime: number;
  groundShare: number;
  /**
   * Of the airborne ticks that were both turning and holding a strafe key, the
   * share where the key matched the turn: left key while turning left, right key
   * while turning right. The usual meaning of sync in a bhop timer.
   */
  sync: number;
  /** Horizontal speed gained, adding up every tick that gained some. */
  speedGain: number;
  /** The same, counting only airborne ticks. */
  airSpeedGain: number;
  /** Duck pressed while airborne, counted once per press. */
  duckTaps: number;
  /** Times airborne speed dropped by more than 5 u/s in a tick, and the total lost. */
  slowdowns: number;
  speedLost: number;
  formatVersion: number;
  playerName: string;
  recordedAt: number;
  /** Ticks the decoder could not recover. 0 means the file read end to end. */
  lostFrames: number;
}

/** Measurements of the recorded view angles. Numbers, not a verdict. */
export interface YawSignals {
  /** Times the turn changed direction (a strafe change). */
  reversals: number;
  /** Share of those that flipped sign with no sample near zero in between. */
  sharpShare: number;
  /** Median number of near zero samples around a reversal. */
  medianWidth: number;
  /** Median largest change between two samples at a reversal, deg/s. */
  medianDeceleration: number;
  /** Median variation of the turn rate between reversals; lower is more uniform. */
  flatness: number;
}

/** One column of the graph: a time bucket with the extremes inside it. */
export interface Bucket {
  t: number;
  yawMin: number;
  yawMax: number;
  yawMean: number;
  speed: number;
}

export interface ReplayAnalysis {
  stats: ReplayStats;
  signals: YawSignals;
  buckets: Bucket[];
  /** Largest absolute turn rate, for the graph's scale. */
  yawPeak: number;
  speedPeak: number;
  samples: number;
}

/** Degrees, continuous: undoes the wrap at +-180 so a delta means what it says. */
function unwrap(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length);
  if (values.length === 0) return out;
  out[0] = values[0]!;
  for (let i = 1; i < values.length; i++) {
    let d = values[i]! - values[i - 1]!;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out[i] = out[i - 1]! + d;
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * Finds the ticks where the turn changed direction and measures each one.
 *
 * A reversal is a sign change in the turn rate with a real turn around it (the
 * 50 deg/s floor keeps still moments out), and two of them closer than three
 * ticks count as one.
 */
function yawSignals(rate: Float64Array): YawSignals {
  const at: number[] = [];
  for (let i = 2; i < rate.length - 2; i++) {
    const flipped = (rate[i - 1]! > 0 && rate[i]! < 0) || (rate[i - 1]! < 0 && rate[i]! > 0);
    if (!flipped) continue;
    let peak = 0;
    for (let k = i - 2; k <= i + 2; k++) peak = Math.max(peak, Math.abs(rate[k]!));
    if (peak > 50 && (at.length === 0 || i - at[at.length - 1]! > 3)) at.push(i);
  }

  const widths: number[] = [];
  const decelerations: number[] = [];
  for (const i of at) {
    // How long the turn sits near zero: a human carries some inertia through the
    // change, so there are usually a few samples under the local threshold.
    const window = rate.slice(Math.max(0, i - 10), i + 11);
    let localPeak = 0;
    for (const v of window) localPeak = Math.max(localPeak, Math.abs(v));
    const threshold = 0.15 * localPeak;
    let lo = i;
    let hi = i;
    while (lo > 0 && Math.abs(rate[lo]!) < threshold) lo--;
    while (hi < rate.length - 1 && Math.abs(rate[hi]!) < threshold) hi++;
    widths.push(hi - lo);

    let maxStep = 0;
    for (let k = Math.max(1, i - 5); k < Math.min(rate.length, i + 6); k++) {
      maxStep = Math.max(maxStep, Math.abs(rate[k]! - rate[k - 1]!));
    }
    decelerations.push(maxStep);
  }

  // How even the turn rate is between one reversal and the next.
  const flatness: number[] = [];
  for (let k = 1; k < at.length; k++) {
    const seg: number[] = [];
    for (let i = at[k - 1]! + 1; i < at[k]!; i++) seg.push(Math.abs(rate[i]!));
    if (seg.length < 8 || Math.max(...seg) < 80) continue;
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const variance = seg.reduce((a, b) => a + (b - mean) ** 2, 0) / seg.length;
    flatness.push(Math.sqrt(variance) / (Math.abs(mean) + 1e-9));
  }

  return {
    reversals: at.length,
    sharpShare: widths.length > 0 ? widths.filter((w) => w === 0).length / widths.length : 0,
    medianWidth: median(widths),
    medianDeceleration: median(decelerations),
    flatness: median(flatness),
  };
}

const STRIDE = 9;
const YAW = 4;
const VX = 5;
const VY = 6;

/** Target number of graph columns. Enough detail on screen, cheap to draw. */
const COLUMNS = 900;

/** Parses the bytes of a .momtv and measures the run. */
export function analyse(bytes: ArrayBuffer): ReplayAnalysis {
  const replay = parseReplay(bytes);
  const track = replay.toTrack();
  const { header, splits } = replay;
  const dt = track.tickInterval || header.tickInterval || 0.01;

  // The run proper: the timer starts when the player leaves the start zone, and
  // everything before that tick is approach, not run.
  const from = Math.min(track.startTick, Math.max(0, track.frameCount - 1));
  const count = Math.max(0, track.frameCount - from);

  const yaw = new Float64Array(count);
  const speed = new Float64Array(count);
  // Measured off the recorded path, for the files whose splits block leaves the
  // distances at zero.
  let pathFlat = 0;
  let path3d = 0;
  for (let i = 0; i < count; i++) {
    const base = (from + i) * STRIDE;
    yaw[i] = track.data[base + YAW]!;
    const vx = track.data[base + VX]!;
    const vy = track.data[base + VY]!;
    speed[i] = Math.hypot(vx, vy);
    if (i > 0) {
      const prev = base - STRIDE;
      const dx = track.data[base]! - track.data[prev]!;
      const dy = track.data[base + 1]! - track.data[prev + 1]!;
      const dz = track.data[base + 2]! - track.data[prev + 2]!;
      pathFlat += Math.hypot(dx, dy);
      path3d += Math.hypot(dx, dy, dz);
    }
  }
  const continuous = unwrap(yaw);
  const rate = new Float64Array(count);
  for (let i = 1; i < count; i++) rate[i] = (continuous[i]! - continuous[i - 1]!) / dt;
  if (count > 1) rate[0] = rate[1]!;

  const perBucket = Math.max(1, Math.ceil(count / COLUMNS));
  const buckets: Bucket[] = [];
  let yawPeak = 0;
  let speedPeak = 0;
  for (let start = 0; start < count; start += perBucket) {
    const end = Math.min(count, start + perBucket);
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let fastest = 0;
    for (let i = start; i < end; i++) {
      const r = rate[i]!;
      if (r < min) min = r;
      if (r > max) max = r;
      sum += r;
      if (speed[i]! > fastest) fastest = speed[i]!;
    }
    yawPeak = Math.max(yawPeak, Math.abs(min), Math.abs(max));
    speedPeak = Math.max(speedPeak, fastest);
    buckets.push({
      t: start * dt,
      yawMin: min,
      yawMax: max,
      yawMean: sum / (end - start),
      speed: fastest,
    });
  }

  // What the file does not carry: walked once over the recorded ticks.
  let groundTicks = 0;
  let syncGood = 0;
  let syncTotal = 0;
  let speedGain = 0;
  let airSpeedGain = 0;
  let duckTaps = 0;
  let slowdowns = 0;
  let speedLost = 0;
  let wasSlowing = false;
  for (let i = 0; i < count; i++) {
    const tick = from + i;
    const air = (track.flags[tick]! & FL_ONGROUND) === 0;
    if (!air) groundTicks += 1;

    const buttons = track.buttons[tick]!;
    const left = (buttons & Button.MoveLeft) !== 0;
    const right = (buttons & Button.MoveRight) !== 0;
    // A duck tap is the press, not the hold, and only in the air.
    if (air && (buttons & Button.Duck) !== 0) {
      const before = i > 0 ? track.buttons[tick - 1]! : 0;
      if ((before & Button.Duck) === 0) duckTaps += 1;
    }

    if (i === 0) continue;
    // Yaw grows counter clockwise in Source, so a positive turn is a left turn.
    const turn = rate[i]!;
    if (air && Math.abs(turn) > 10 && left !== right) {
      syncTotal += 1;
      if ((turn > 0 && left) || (turn < 0 && right)) syncGood += 1;
    }

    const delta = speed[i]! - speed[i - 1]!;
    if (delta > 0) {
      speedGain += delta;
      if (air) airSpeedGain += delta;
      wasSlowing = false;
    } else if (air && delta < -5) {
      speedLost += -delta;
      // One collision costs several ticks; count the event, not each tick.
      if (!wasSlowing) slowdowns += 1;
      wasSlowing = true;
    } else {
      wasSlowing = false;
    }
  }

  const s = splits.trackStats;
  const runTime = header.runTime > 0 ? header.runTime : count * dt;

  // A replay can carry a splits block whose distances are zero, and one with no
  // segment for the start. Take the file's number when it says something, fall
  // back to the sum of its segments, and measure the recorded path otherwise.
  const fromSegments = (pick: (st: typeof s) => number): number =>
    splits.segments.reduce((sum, seg) => sum + (pick(seg.segmentStats) || 0), 0);
  const positive = (...candidates: number[]): number => {
    for (const c of candidates) if (Number.isFinite(c) && c > 0) return c;
    return 0;
  };
  const flat = positive(
    s.horizontalDistanceTravelled,
    fromSegments((st) => st.horizontalDistanceTravelled),
    pathFlat,
  );
  const total = positive(
    s.overallDistanceTravelled,
    fromSegments((st) => st.overallDistanceTravelled),
    path3d,
  );
  const fileFlat = positive(
    s.horizontalDistanceTravelled,
    fromSegments((st) => st.horizontalDistanceTravelled),
  );
  const startVelocity = splits.segments[0]?.effectiveStartVelocity;
  const fileStart = startVelocity
    ? Math.hypot(startVelocity.x ?? NaN, startVelocity.y ?? NaN)
    : NaN;
  const prestrafe = Number.isFinite(fileStart) ? fileStart : (speed[0] ?? 0);
  return {
    stats: {
      runTime,
      tickInterval: dt,
      ticks: count,
      avgSpeed: runTime > 0 ? flat / runTime : 0,
      maxSpeed: s.maxHorizontalSpeed,
      maxOverallSpeed: s.maxOverallSpeed,
      prestrafeSpeed: prestrafe,
      endSpeed: count > 0 ? speed[count - 1]! : 0,
      horizontalDistance: flat,
      overallDistance: total,
      distanceFromPath: fileFlat === 0,
      prestrafeFromPath: !Number.isFinite(fileStart),
      jumps: s.jumps,
      strafes: s.strafes,
      strafesPerSecond: runTime > 0 ? s.strafes / runTime : 0,
      groundTime: groundTicks * dt,
      groundShare: count > 0 ? groundTicks / count : 0,
      sync: syncTotal > 0 ? syncGood / syncTotal : 0,
      speedGain,
      airSpeedGain,
      duckTaps,
      slowdowns,
      speedLost,
      formatVersion: header.formatVersion,
      playerName: header.playerName,
      recordedAt: header.timestamp,
      lostFrames: track.stats.lostFrames,
    },
    signals: yawSignals(rate),
    buckets,
    yawPeak,
    speedPeak,
    samples: count,
  };
}

/** Downloads an archived replay and measures it. */
export async function analyseReplay(sha1: string): Promise<ReplayAnalysis> {
  const res = await fetch(`/api/replays/${sha1}/download`, { headers: { accept: '*/*' } });
  if (!res.ok) throw new Error(`the replay could not be read (HTTP ${res.status})`);
  return analyse(await res.arrayBuffer());
}
