import { GuideSource } from './guide.types';
import { industrySourceLabel, isMountainIndustryUrl } from './mountain-sources';

export interface MountainWebHit {
  title: string;
  url: string;
}

const NO_CONFIRMED_DATA =
  'Brak potwierdzonych informacji w źródłach branżowych (TOPR, GOPR, parki narodowe, PTTK, PZA, IMGW oraz służby po słowackiej i czeskiej stronie Tatr i Karkonoszy). ' +
  'Powiedz użytkownikowi wprost, że nie masz pewnej informacji. Nie uzupełniaj jej z pamięci.';

export function formatMountainWebBrief(
  rawText: string,
  hits: readonly MountainWebHit[],
): { text: string; sources: GuideSource[] } {
  const sources: GuideSource[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const url = hit.url.trim();
    if (!isMountainIndustryUrl(url)) {
      continue;
    }
    const key = url.replace(/\/+$/, '').toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const title = hit.title.trim() || industrySourceLabel(url) || 'Źródło branżowe';
    sources.push({
      id: `web:${key}`,
      title,
      source: 'źródło branżowe',
      url,
    });
  }

  const cleaned = stripNonIndustryUrls(rawText).replace(/\bBRAK_DANYCH\b/gi, '').trim();
  if (sources.length === 0 || !cleaned) {
    return { text: NO_CONFIRMED_DATA, sources: [] };
  }

  const lines = sources.map((source) => `- ${source.title} | ${source.url}`).join('\n');
  return {
    text: truncate(
      `Fakty ze źródeł branżowych. Użyj tylko tego tekstu i tych adresów, kopiuj URL 1:1:\n${cleaned}\n\nAdresy:\n${lines}`,
      4000,
    ),
    sources,
  };
}

function stripNonIndustryUrls(text: string): string {
  return text.replace(/https:\/\/[^\s<>"')\]]+/gi, (url) =>
    isMountainIndustryUrl(trimUrl(url)) ? trimUrl(url) : '',
  );
}

function trimUrl(url: string): string {
  return url.replace(/[),.;:!?]+$/, '');
}

function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}
