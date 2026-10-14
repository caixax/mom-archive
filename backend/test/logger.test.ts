import { describe, expect, it } from 'vitest';
import { redactString, redactValue } from '../src/logger.js';

describe('logger redaction', () => {
  it('hides credentials in connection strings and query keys', () => {
    expect(redactString('postgres://momarchive_rw:s3cret@127.0.0.1:5432/momarchive')).toBe(
      'postgres://momarchive_rw:***@127.0.0.1:5432/momarchive',
    );
    expect(redactString('https://api.steampowered.com/x?key=ABCDEF123&steamids=1')).toBe(
      'https://api.steampowered.com/x?key=***&steamids=1',
    );
    expect(
      redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop'),
    ).toContain('Bearer ***');
  });
  it('masks secret keys in objects', () => {
    const out = redactValue('ctx', {
      authorization: 'x',
      nested: { S3_SECRET_KEY: 'y', ok: 'fine' },
      list: ['postgres://a:b@c/d'],
    }) as Record<string, unknown>;
    expect(out.authorization).toBe('***');
    expect((out.nested as Record<string, unknown>).S3_SECRET_KEY).toBe('***');
    expect((out.nested as Record<string, unknown>).ok).toBe('fine');
    expect((out.list as string[])[0]).toBe('postgres://a:***@c/d');
  });
});
