// S3 compatible object store (RustFS). Path style addressing, configurable endpoint.
import { Readable } from 'node:stream';
import {
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';

export interface StorageOptions {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

export interface ObjectStream {
  body: Readable;
  contentLength: number | undefined;
  contentRange: string | undefined;
  contentType: string | undefined;
  status: number;
}

export class Storage {
  readonly client: S3Client;
  readonly bucket: string;

  constructor(opts: StorageOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      endpoint: opts.endpoint,
      region: opts.region,
      forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey },
    });
  }

  async put(
    key: string,
    body: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        Metadata: metadata,
      }),
    );
  }

  async head(key: string): Promise<{ bytes: number; contentType: string | undefined } | null> {
    try {
      const r = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: r.ContentLength ?? 0, contentType: r.ContentType };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async headBucket(): Promise<number> {
    const t = Date.now();
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    return Date.now() - t;
  }

  /** Streams an object, forwarding an optional HTTP Range header. */
  async getStream(key: string, range?: string): Promise<ObjectStream | null> {
    let r: GetObjectCommandOutput;
    try {
      r = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: range }),
      );
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
    const body = r.Body;
    if (!body) return null;
    const stream =
      body instanceof Readable ? body : Readable.fromWeb(body.transformToWebStream() as never);
    return {
      body: stream,
      contentLength: r.ContentLength,
      contentRange: r.ContentRange,
      contentType: r.ContentType,
      status: r.$metadata.httpStatusCode ?? 200,
    };
  }

  async getBytes(key: string): Promise<Buffer | null> {
    const s = await this.getStream(key);
    if (!s) return null;
    const chunks: Buffer[] = [];
    for await (const c of s.body) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  }

  /** Walks a prefix and sums object counts and bytes. Can take a while on big buckets. */
  async summarize(prefix: string): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const o of r.Contents ?? []) {
        count += 1;
        bytes += o.Size ?? 0;
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return { count, bytes };
  }

  async *listKeys(prefix: string): AsyncGenerator<{ key: string; size: number }> {
    let token: string | undefined;
    do {
      const r = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        }),
      );
      for (const o of r.Contents ?? []) if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }
}

function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    err?.name === 'NotFound' || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404
  );
}

export const keys = {
  replay: (sha1: string) => `replays/${sha1}.momtv`,
  avatar: (hash: string) => `avatars/${hash}.jpg`,
  mapImage: (id: string) => `maps/images/${id}-large.jpg`,
  bsp: (versionId: string) => `maps/bsp/${versionId}.bsp`,
};
