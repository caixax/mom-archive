// Raw API snapshots: every response body gzipped into
// raw/{endpoint}/{yyyy}/{mm}/{dd}/{timestamp}-{hash}.json.gz
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { RawSink } from '../momentum/client.js';
import type { Storage } from './s3.js';

export class RawStore implements RawSink {
  constructor(private readonly storage: Storage) {}

  static keyFor(endpoint: string, body: Buffer, at: Date = new Date()): string {
    const y = at.getUTCFullYear();
    const m = String(at.getUTCMonth() + 1).padStart(2, '0');
    const d = String(at.getUTCDate()).padStart(2, '0');
    const hash = createHash('sha1').update(body).digest('hex').slice(0, 12);
    const stamp = at.toISOString().replace(/[:.]/g, '').replace('T', '-').replace('Z', '');
    return `raw/${endpoint}/${y}/${m}/${d}/${stamp}-${hash}.json.gz`;
  }

  async put(endpoint: string, body: Buffer, meta: { url: string; status: number }): Promise<void> {
    const key = RawStore.keyFor(endpoint, body);
    await this.storage.put(key, gzipSync(body), 'application/gzip', {
      'source-url': meta.url.slice(0, 1000),
      'source-status': String(meta.status),
    });
  }
}
