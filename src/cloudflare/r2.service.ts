import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { R2ObjectBody, R2ObjectRef } from './r2.types';

@Injectable()
export class R2Service {
  private readonly logger = new Logger(R2Service.name);
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.getOrThrow<string>('R2_BUCKET');
    this.client = new S3Client({
      region: this.config.getOrThrow<string>('R2_REGION'),
      endpoint: this.config.getOrThrow<string>('R2_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.getOrThrow<string>('R2_ACCESS_KEY_ID'),
        secretAccessKey: this.config.getOrThrow<string>('R2_SECRET_ACCESS_KEY'),
      },
      forcePathStyle: true,
    });
  }

  async listObjects(prefix: string): Promise<R2ObjectRef[]> {
    const items: R2ObjectRef[] = [];
    let continuationToken: string | undefined;
    try {
      do {
        const output = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        );
        for (const object of output.Contents ?? []) {
          if (!object.Key) {
            continue;
          }
          items.push({
            key: object.Key,
            etag: object.ETag?.replace(/^"|"$/g, ''),
            size: object.Size,
          });
        }
        continuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
      } while (continuationToken);
      return items;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2 list failed';
      this.logger.error(message);
      throw new BadGatewayException('Nie udało się odczytać listy plików z R2.');
    }
  }

  async headObject(key: string): Promise<string | undefined> {
    try {
      const output = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      return output.ETag?.replace(/^"|"$/g, '');
    } catch {
      return undefined;
    }
  }

  async getText(key: string): Promise<R2ObjectBody> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
      const text = await this.streamToText(output.Body);
      return {
        key,
        etag: output.ETag?.replace(/^"|"$/g, ''),
        text,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2 get failed';
      this.logger.error(`${message} (${key})`);
      throw new BadGatewayException(`Nie udało się odczytać pliku R2: ${key}`);
    }
  }

  async putText(key: string, body: string, contentType = 'application/json; charset=utf-8'): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: Buffer.from(body, 'utf8'),
          ContentType: contentType,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'R2 put failed';
      this.logger.error(`${message} (${key})`);
      throw new BadGatewayException(`Nie udało się zapisać pliku R2: ${key}`);
    }
  }

  private async streamToText(body: unknown): Promise<string> {
    if (!body) {
      return '';
    }
    if (typeof body === 'string') {
      return body;
    }
    if (body instanceof Uint8Array) {
      return Buffer.from(body).toString('utf8');
    }
    if (typeof body === 'object' && body !== null && 'transformToByteArray' in body) {
      const bytes = await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray();
      return Buffer.from(bytes).toString('utf8');
    }
  return '';
  }
}