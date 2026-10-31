import { describe, expect, it } from 'vitest';
import {
  checkHeader,
  readHeader,
  REPLAY_HEADER_SIZE,
  REPLAY_MAGIC,
  ReplayReadError,
  writeHeader,
} from '../src/momentum/replay-header.js';

const sample = {
  magic: REPLAY_MAGIC,
  formatVersion: 2,
  timestamp: 1760000000000,
  mapName: 'bhop_cooksassistant',
  mapHash: '3fcc9e923a1732b6a0a8a6e7fe124659bb76250c',
  gamemode: 3,
  compression: 1,
  tickInterval: 0.01,
  playerSteamID: '76561198449328102',
  playerName: 'Gman',
  trackType: 0,
  trackNum: 1,
  runTime: 26.714999402873218,
  style: 0,
};

describe('replay header', () => {
  it('round trips through write and read', () => {
    const buf = writeHeader(sample);
    expect(buf.length).toBe(REPLAY_HEADER_SIZE);
    expect(buf.subarray(0, 4).toString('ascii')).toBe('MMTV');
    const h = readHeader(Buffer.concat([buf, Buffer.alloc(100)]));
    expect(h.magic).toBe(REPLAY_MAGIC);
    expect(h.mapName).toBe(sample.mapName);
    expect(h.mapHash).toBe(sample.mapHash);
    expect(h.gamemode).toBe(3);
    expect(h.playerSteamID).toBe(sample.playerSteamID);
    expect(h.playerName).toBe('Gman');
    expect(h.trackType).toBe(0);
    expect(h.trackNum).toBe(1);
    expect(h.runTime).toBeCloseTo(sample.runTime, 9);
    expect(h.style).toBe(0);
    expect(h.tickInterval).toBeCloseTo(0.01, 6);
    expect(h.timestamp).toBe(sample.timestamp);
  });

  it('reads a format version 1 header, which has no style byte', () => {
    // a version 1 file is a version 2 one without byte 194, so what follows
    // the header (here the splits length, 0x20) starts one byte earlier
    const v2 = writeHeader({ ...sample, formatVersion: 1 });
    const v1 = Buffer.concat([
      v2.subarray(0, REPLAY_HEADER_SIZE - 1),
      Buffer.from([0x20, 0, 0, 0]),
    ]);
    const h = readHeader(v1);
    expect(h.formatVersion).toBe(1);
    expect(h.style).toBe(0);
    expect(h.runTime).toBeCloseTo(sample.runTime, 9);
    expect(readHeader(v1.subarray(0, REPLAY_HEADER_SIZE - 1)).style).toBe(0);
  });

  it('rejects short buffers and bad magic', () => {
    expect(() => readHeader(Buffer.alloc(10))).toThrow(ReplayReadError);
    const bad = writeHeader({ ...sample, magic: 0x11223344 });
    expect(() => readHeader(bad)).toThrow(/bad magic/);
  });

  it('checkHeader reports mismatches against the run', () => {
    const h = readHeader(writeHeader(sample));
    expect(
      checkHeader(h, {
        gamemode: 3,
        trackType: 0,
        trackNum: 1,
        style: 0,
        runTime: 26.715,
        steamId: sample.playerSteamID,
        mapName: 'BHOP_COOKSASSISTANT',
      }),
    ).toEqual([]);
    const issues = checkHeader(h, {
      gamemode: 2,
      trackType: 0,
      trackNum: 2,
      style: 0,
      runTime: 30,
      steamId: '1',
      mapName: 'other',
    });
    expect(issues.length).toBe(5);
    expect(issues.join(';')).toContain('gamemode 3 != 2');
  });
});
