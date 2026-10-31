// MomentumTV (.momtv) replay header parser, ported from momentum-mod/website
// libs/formats/replay (not published to npm). The header is a packed C struct,
// 195 bytes, little endian. Format version 1 is the same struct without its
// last byte, the style, which the game reads as 0. Frame data after the header
// is not parsed.

export const REPLAY_MAGIC = 0x56544d4d; // "MMTV" little endian
export const REPLAY_HEADER_SIZE = 195;

export interface ReplayHeader {
  magic: number;
  formatVersion: number;
  /** Unix time in milliseconds written when the file is created */
  timestamp: number;
  mapName: string;
  mapHash: string;
  gamemode: number;
  compression: number;
  tickInterval: number;
  playerSteamID: string;
  playerName: string;
  trackType: number;
  trackNum: number;
  runTime: number;
  style: number;
}

export class ReplayReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayReadError';
  }
}

function cstring(buf: Buffer, offset: number, max: number): string {
  const end = buf.indexOf(0, offset);
  const stop = end === -1 || end > offset + max ? offset + max : end;
  return buf.toString('utf8', offset, stop);
}

export function readHeader(buf: Buffer): ReplayHeader {
  const formatVersion = buf.length >= 8 ? buf.readInt32LE(4) : 0;
  // version 1 has no style byte: its byte 194 already starts the splits length
  const size = formatVersion === 1 ? REPLAY_HEADER_SIZE - 1 : REPLAY_HEADER_SIZE;
  if (buf.length < size) {
    throw new ReplayReadError(`buffer too small: ${buf.length} < ${size}`);
  }
  const header: ReplayHeader = {
    magic: buf.readUInt32LE(0),
    formatVersion,
    timestamp: Number(buf.readBigInt64LE(8)),
    mapName: cstring(buf, 16, 64),
    mapHash: cstring(buf, 80, 41),
    gamemode: buf.readUInt8(121),
    compression: buf.readUInt8(122),
    tickInterval: buf.readFloatLE(123),
    playerSteamID: buf.readBigUInt64LE(127).toString(),
    playerName: cstring(buf, 135, 32),
    trackType: buf.readUInt8(167),
    trackNum: buf.readUInt8(168),
    runTime: buf.readDoubleLE(169),
    style: formatVersion === 1 ? 0 : buf.readUInt8(194),
  };
  if (header.magic !== REPLAY_MAGIC) {
    throw new ReplayReadError(`bad magic 0x${header.magic.toString(16)}`);
  }
  return header;
}

export interface HeaderExpectation {
  gamemode: number;
  trackType: number;
  trackNum: number;
  style: number;
  runTime?: number;
  steamId?: string;
  mapName?: string;
  /**
   * Names the map went by before, since maps get renamed after runs are
   * recorded on them (bhop_avantura became kz_bhop_avantura).
   */
  mapAliases?: readonly string[];
  /**
   * BSP hashes of every version of the map the archive knows. A header whose
   * map hash is one of them was recorded on this map, whatever it was called.
   */
  mapHashes?: readonly string[];
}

/** Returns a list of mismatches between a parsed header and what the API said about the run. */
export function checkHeader(h: ReplayHeader, want: HeaderExpectation): string[] {
  const issues: string[] = [];
  if (h.gamemode !== want.gamemode) issues.push(`gamemode ${h.gamemode} != ${want.gamemode}`);
  if (h.trackType !== want.trackType) issues.push(`trackType ${h.trackType} != ${want.trackType}`);
  if (h.trackNum !== want.trackNum) issues.push(`trackNum ${h.trackNum} != ${want.trackNum}`);
  if (h.style !== want.style) issues.push(`style ${h.style} != ${want.style}`);
  if (want.runTime !== undefined && Math.abs(h.runTime - want.runTime) > 0.01) {
    issues.push(`runTime ${h.runTime} != ${want.runTime}`);
  }
  if (want.steamId !== undefined && h.playerSteamID !== want.steamId) {
    issues.push(`steamID ${h.playerSteamID} != ${want.steamId}`);
  }
  if (want.mapName !== undefined) {
    const names = [want.mapName, ...(want.mapAliases ?? [])].map((n) => n.toLowerCase());
    const sameName = names.includes(h.mapName.toLowerCase());
    const sameMap = want.mapHashes?.includes(h.mapHash.toLowerCase()) ?? false;
    if (!sameName && !sameMap) issues.push(`mapName ${h.mapName} != ${want.mapName}`);
  }
  return issues;
}

/** Builds a synthetic header buffer. Used by tests; never produces playable frame data. */
export function writeHeader(h: ReplayHeader): Buffer {
  const buf = Buffer.alloc(REPLAY_HEADER_SIZE);
  buf.writeUInt32LE(h.magic, 0);
  buf.writeInt32LE(h.formatVersion, 4);
  buf.writeBigInt64LE(BigInt(h.timestamp), 8);
  buf.write(h.mapName.slice(0, 63), 16, 'utf8');
  buf.write(h.mapHash.slice(0, 40), 80, 'utf8');
  buf.writeUInt8(h.gamemode, 121);
  buf.writeUInt8(h.compression, 122);
  buf.writeFloatLE(h.tickInterval, 123);
  buf.writeBigUInt64LE(BigInt(h.playerSteamID), 127);
  buf.write(h.playerName.slice(0, 31), 135, 'utf8');
  buf.writeUInt8(h.trackType, 167);
  buf.writeUInt8(h.trackNum, 168);
  buf.writeDoubleLE(h.runTime, 169);
  buf.writeUInt8(h.style, 194);
  return buf;
}
