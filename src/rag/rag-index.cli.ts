import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { RagIndexerService } from './rag-indexer.service';

async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const indexer = app.get(RagIndexerService);
    const result = await indexer.buildIndex();
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          entries: result.entries,
          filesProcessed: result.filesProcessed,
          filesReused: result.filesReused,
          indexKey: result.indexKey,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(message);
  process.exitCode = 1;
});