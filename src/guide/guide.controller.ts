import { Body, Controller, HttpException, Post, Res } from '@nestjs/common';
import { CreateGuideDto } from './dto/create-guide.dto';

interface SseResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
  flushHeaders(): void;
  write(chunk: string): void;
  end(): void;
  readonly writableEnded: boolean;
  on(event: 'close', listener: () => void): void;
  off(event: 'close', listener: () => void): void;
}
import { encodeSseEvent } from './guide-sse';
import { GuideService } from './guide.service';

@Controller('guide')
export class GuideController {
  constructor(private readonly guideService: GuideService) {}

  @Post()
  async create(
    @Body() dto: CreateGuideDto,
    @Res() res: SseResponse,
  ): Promise<void> {
    const abort = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) {
        abort.abort();
      }
    };
    res.on('close', onClose);

    let started = false;
    const write = (event: string, data: unknown): void => {
      if (res.writableEnded) {
        return;
      }
      if (!started) {
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        started = true;
      }
      res.write(encodeSseEvent(event, data));
    };

    try {
      for await (const event of this.guideService.replyStream(dto, abort.signal)) {
        if (abort.signal.aborted || res.writableEnded) {
          break;
        }
        write(event.event, event.data);
      }
    } catch (error) {
      if (isAbortError(error) || abort.signal.aborted) {
        return;
      }
      if (!started) {
        throw error;
      }
      write('error', { message: publicErrorMessage(error) });
    } finally {
      res.off('close', onClose);
      if (started && !res.writableEnded) {
        res.end();
      }
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(error.name);
}

function publicErrorMessage(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'string' && body.trim()) {
      return body;
    }
    if (body && typeof body === 'object' && 'message' in body) {
      const message = (body as { message: unknown }).message;
      if (typeof message === 'string' && message.trim()) {
        return message;
      }
    }
  }
  return 'Nie udało się przygotować odpowiedzi.';
}
