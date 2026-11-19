import { GuideSource } from './guide.types';

/** Kolor jak przycisk „Współpracuj z nami” / filtry na trailon.pl (rgb(254, 95, 0)). */
export const TRAILON_GUIDE_LINK_COLOR = '#FE5F00';

const TRAILON_URL_PATTERN = /https:\/\/trailon\.pl\/[^\s<>"')\]]+/gi;

function trimUrlTrailingPunctuation(url: string): { href: string; suffix: string } {
  const match = /^(https:\/\/trailon\.pl\/[^\s<>"')\]]+?)([),.;:!?]+)?$/.exec(url);
  if (!match) {
    return { href: url, suffix: '' };
  }
  return { href: match[1] ?? url, suffix: match[2] ?? '' };
}
const BOLD_PATTERN = /\*\*([^*]+)\*\*/g;
const MARKDOWN_LINK_PATTERN = /\[([^\]]+)\]\((https:\/\/trailon\.pl\/[^)]+)\)/gi;

export function normalizeTrailonUrl(url: string): string {
  const trimmed = (url ?? '').trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

/** Klucz porównania wpisu blogowego (bez query, hasha i końcowego slasha). */
export function blogUrlKey(url: string): string {
  const withoutQuery = normalizeTrailonUrl((url ?? '').split(/[?#]/)[0] ?? '');
  if (!withoutQuery) {
    return '';
  }
  try {
    const parsed = new URL(withoutQuery);
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${path}`.toLocaleLowerCase('en-US');
  } catch {
    return withoutQuery.toLocaleLowerCase('en-US');
  }
}

/** Wpisy przewodnika trailON: https://trailon.pl/przewodnik/... */
export function isTrailonBlogUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'trailon.pl') {
      return false;
    }
    const path = parsed.pathname.replace(/\/+$/, '') || '/';
    return path === '/przewodnik' || path.startsWith('/przewodnik/');
  } catch {
    return false;
  }
}

const BLOG_LINK_TOKEN_SOURCE =
  '\\[([^\\]]+)\\]\\((https:\\/\\/trailon\\.pl\\/[^)\\s]+)\\)|https:\\/\\/trailon\\.pl\\/[^\\s<>"\')\\]]+';

function blogLinkPattern(): RegExp {
  return new RegExp(BLOG_LINK_TOKEN_SOURCE, 'gi');
}

export function collectCitedBlogUrls(texts: readonly string[]): Set<string> {
  const cited = new Set<string>();
  for (const text of texts) {
    if (!text) {
      continue;
    }
    for (const match of text.matchAll(blogLinkPattern())) {
      const raw = match[2] ?? match[0];
      const { href } = trimUrlTrailingPunctuation(raw);
      if (!isTrailonBlogUrl(href)) {
        continue;
      }
      const key = blogUrlKey(href);
      if (key) {
        cited.add(key);
      }
    }
  }
  return cited;
}

/**
 * Zostawia pierwsze odwołanie do danego wpisu blogowego.
 * Adresy z `alreadyCited` (wcześniejsze tury) wypadają w całości.
 */
export function suppressRepeatedBlogLinks(text: string, alreadyCited: ReadonlySet<string>): string {
  if (!text) {
    return text;
  }
  const seen = new Set(alreadyCited);
  const replaced = text.replace(blogLinkPattern(), (full, label: string | undefined, mdUrl: string | undefined) => {
    const rawUrl = mdUrl ?? full;
    const { href, suffix } = mdUrl
      ? { href: rawUrl, suffix: '' }
      : trimUrlTrailingPunctuation(rawUrl);
    if (!isTrailonBlogUrl(href)) {
      return full;
    }
    const key = blogUrlKey(href);
    if (!key) {
      return full;
    }
    if (seen.has(key)) {
      if (label !== undefined && blogUrlKey(label) !== key) {
        return label;
      }
      return suffix;
    }
    seen.add(key);
    return full;
  });
  return cleanupDanglingBlogLeadIn(replaced);
}

function cleanupDanglingBlogLeadIn(text: string): string {
  return text
    .replace(/\(\s*\)/g, '')
    .replace(
      /[ \t]*(?:więcej(?:\s+na\s+blogu)?|link(?:\s+do\s+bloga)?|zobacz|szczegóły)\s*[:\-–—]\s*(?=[,.;:!?]|$)/gim,
      '',
    )
    .replace(/([.!?])\s*[.]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildUrlTitleMap(sources: GuideSource[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of sources) {
    const url = (source.url ?? '').trim();
    if (!url.startsWith('https://trailon.pl/')) {
      continue;
    }
    const title = (source.title ?? '').trim();
    if (!title) {
      continue;
    }
    map.set(normalizeTrailonUrl(url), title);
  }
  return map;
}

export function titleFromTrailonUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = decodeURIComponent(segments[segments.length - 1] ?? '').trim();
    if (!last) {
      return 'Materiał TrailOn';
    }
    const words = last.replace(/[-_]+/g, ' ').split(/\s+/).filter(Boolean);
    return words
      .map((word) => word.charAt(0).toLocaleUpperCase('pl-PL') + word.slice(1).toLocaleLowerCase('pl-PL'))
      .join(' ');
  } catch {
    return 'Materiał TrailOn';
  }
}

export function escapeHtml(value: string): string {
  return (value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function trailonGuideAnchor(href: string, label: string): string {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeHref}" class="trailon-guide-link" style="color:${TRAILON_GUIDE_LINK_COLOR}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`;
}

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'bold'; value: string }
  | { kind: 'link'; url: string };

function tokenizeInlineParagraph(paragraph: string): InlineToken[] {
  let normalized = paragraph.replace(MARKDOWN_LINK_PATTERN, (_match, _label: string, url: string) => url);
  const pattern = new RegExp(
    `${BOLD_PATTERN.source}|${TRAILON_URL_PATTERN.source}`,
    'gi',
  );
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((match = pattern.exec(normalized))) {
    if (match.index > lastIndex) {
      tokens.push({ kind: 'text', value: normalized.slice(lastIndex, match.index) });
    }
    const full = match[0];
    if (full.startsWith('**') && full.endsWith('**')) {
      tokens.push({ kind: 'bold', value: full.slice(2, -2) });
    } else {
      const { href, suffix } = trimUrlTrailingPunctuation(full);
      tokens.push({ kind: 'link', url: href });
      if (suffix) {
        tokens.push({ kind: 'text', value: suffix });
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < normalized.length) {
    tokens.push({ kind: 'text', value: normalized.slice(lastIndex) });
  }
  return tokens;
}

export function formatInlineParagraphToHtml(
  paragraph: string,
  urlTitles: Map<string, string>,
  resolveTitle?: (url: string) => string | undefined,
): string {
  const tokens = tokenizeInlineParagraph(paragraph);
  return tokens
    .map((token) => {
      if (token.kind === 'text') {
        return escapeHtml(token.value);
      }
      if (token.kind === 'bold') {
        return `<strong>${escapeHtml(token.value)}</strong>`;
      }
      const normalized = normalizeTrailonUrl(token.url);
      const title =
        urlTitles.get(normalized) ?? resolveTitle?.(token.url) ?? titleFromTrailonUrl(token.url);
      return trailonGuideAnchor(token.url, title);
    })
    .join('');
}

/** Odstęp przed kolejnym punktem „1. / 2. / 3.” — większy niż między podpunktami. */
const NUMBERED_ITEM_GAP = '1.6em';
const NUMBERED_ITEM_LINE = /^(?:\*\*)?\d{1,2}\.\s+\S/;

function isNumberedItemStart(line: string): boolean {
  return NUMBERED_ITEM_LINE.test(line.trim());
}

function splitGuideBlocks(text: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      continue;
    }
    if (current.length > 0 && isNumberedItemStart(line)) {
      flush();
    }
    current.push(line);
  }
  flush();
  return blocks;
}

export function plainTextToGuideHtml(
  text: string,
  urlTitles: Map<string, string>,
  resolveTitle?: (url: string) => string | undefined,
): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return '<p></p>';
  }
  return splitGuideBlocks(trimmed)
    .map((lines, index) => {
      const inner = lines
        .map((line) => formatInlineParagraphToHtml(line, urlTitles, resolveTitle))
        .join('<br/>');
      const gapBefore = index > 0 && isNumberedItemStart(lines[0] ?? '');
      const style = gapBefore ? ` style="margin-top:${NUMBERED_ITEM_GAP}"` : '';
      return `<p${style}>${inner}</p>`;
    })
    .join('');
}