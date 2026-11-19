import { Injectable, Logger } from '@nestjs/common';
import { R2Service } from '../cloudflare/r2.service';
import { RAG_INDEX_REFRESH_MS } from '../rag/rag.constants';
import {
  formatLibraryRouteProposals,
  LibraryRoute,
  parseLibraryPlan,
  rankLibraryRoutes,
  routeQueryTokens,
} from './library-routes';

export interface LibraryRouteSearch {
  text: string;
  routes: LibraryRoute[];
}

@Injectable()
export class LibraryRoutesService {
  private readonly logger = new Logger(LibraryRoutesService.name);
  private cache: { at: number; routes: LibraryRoute[] } | undefined;

  constructor(private readonly r2: R2Service) {}

  async search(query: string, limit: number): Promise<LibraryRouteSearch> {
    if (routeQueryTokens(query).length === 0) {
      return {
        text: 'Podaj nazwę szczytu, pasma albo fragment nazwy trasy.',
        routes: [],
      };
    }
    const routes = rankLibraryRoutes(await this.load(), query, limit);
    return {
      text: formatLibraryRouteProposals(routes),
      routes,
    };
  }

  private async load(): Promise<LibraryRoute[]> {
    if (this.cache && Date.now() - this.cache.at < RAG_INDEX_REFRESH_MS) {
      return this.cache.routes;
    }
    const objects = await this.r2.listObjects('biblioteka-tras/');
    const jsonKeys = objects
      .map((object) => object.key)
      .filter((key) => key.endsWith('.json'))
      .filter((key) => {
        const last = key.split('/').filter(Boolean).pop() ?? '';
        return !last.startsWith('_');
      });
    const parsed = await Promise.all(jsonKeys.map((key) => this.readPlan(key)));
    const routes = parsed.filter((route): route is LibraryRoute => Boolean(route));
    this.cache = { at: Date.now(), routes };
    this.logger.log(`Wczytano ${routes.length} planów z biblioteki tras.`);
    return routes;
  }

  private async readPlan(key: string): Promise<LibraryRoute | undefined> {
    try {
      const body = await this.r2.getText(key);
      return parseLibraryPlan(key, body.text);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'nieznany błąd';
      this.logger.warn(`Pominięto plan ${key}: ${message}`);
      return undefined;
    }
  }
}
