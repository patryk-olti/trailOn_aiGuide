import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const D1_API_BASE = 'https://api.cloudflare.com/client/v4';

type D1QueryResult<T> = {
  results: T[];
};

@Injectable()
export class D1Service {
  private readonly logger = new Logger(D1Service.name);
  private readonly accountId: string;
  private readonly databaseId: string;
  private readonly apiToken: string;
  readonly peaksTable: string;

  constructor(private readonly config: ConfigService) {
    this.accountId = this.config.getOrThrow<string>('CF_D1_ACCOUNT_ID');
    this.databaseId = this.config.getOrThrow<string>('CF_D1_DATABASE_ID');
    this.apiToken = this.config.getOrThrow<string>('CF_D1_API_TOKEN');
    this.peaksTable = this.config.getOrThrow<string>('CF_D1_PEAKS_TABLE');
  }

  async query<T extends object>(
    sql: string,
    params: Array<string | number | null> = [],
  ): Promise<T[]> {
    const url = `${D1_API_BASE}/accounts/${this.accountId}/d1/database/${this.databaseId}/query`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sql, params }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'D1 request failed';
      this.logger.error(message);
      throw new BadGatewayException('Nie udało się połączyć z Cloudflare D1.');
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new BadGatewayException('Cloudflare D1 zwrócił nieprawidłową odpowiedź JSON.');
    }

    if (!response.ok) {
      throw new BadGatewayException(
        `Cloudflare D1 zwrócił błąd HTTP ${response.status}. Sprawdź token i uprawnienia.`,
      );
    }

    const envelope = payload as {
      success?: boolean;
      errors?: Array<{ message?: string }>;
      result?: D1QueryResult<T>[];
    };
    if (envelope.errors && envelope.errors.length > 0) {
      const reason = envelope.errors[0]?.message ?? 'Zapytanie D1 nie powiodło się.';
      throw new BadGatewayException(reason);
    }
    const first = envelope.result?.[0];
    if (!first || !Array.isArray(first.results)) {
      return [];
    }
    return first.results;
  }

  assertTableName(table: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new BadGatewayException(`Nieprawidłowa nazwa tabeli D1: ${table}`);
    }
    return table;
  }
}