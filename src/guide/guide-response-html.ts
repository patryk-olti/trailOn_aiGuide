import { normalizePeakName } from '../rag/rag-blog-lookup';
import { GuidePeakElevation, GuideSource } from './guide.types';
import { industrySourceLabel, isMountainIndustryUrl, mountainIndustryUrlSource } from './mountain-sources';

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

function trimGenericHttpsUrl(url: string): { href: string; suffix: string } {
  const match = /^(https:\/\/[^\s<>"')\]]+?)([),.;:!?]+)?$/.exec(url);
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
      /[ \t]*(?:url|więcej(?:\s+na\s+blogu)?|link(?:\s+do\s+bloga)?|zobacz|szczegóły)\s*[:\-–—]\s*(?=[,.;:!?]|$)/gim,
      '',
    )
    .replace(/([.!?])\s*[.]+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface PeakBlogBinding {
  name: string;
  url?: string;
}

/**
 * W sekcji szczytu zostawia tylko jego potwierdzony adres bloga.
 * Cudzy lub niepewny URL (także z sąsiedniego materiału) jest usuwany.
 */
export function stripMismatchedPeakBlogUrls(
  text: string,
  peaks: ReadonlyArray<PeakBlogBinding>,
): string {
  const known = peaks
    .map((peak) => ({ name: peak.name.trim(), url: peak.url?.trim() || undefined }))
    .filter((peak) => peak.name.length > 0)
    .sort((left, right) => right.name.length - left.name.length);
  if (!text || known.length === 0) {
    return text;
  }

  let current: PeakBlogBinding | undefined;
  const rewritten = text.split(/\r?\n/).map((line) => {
    const mentioned = known.find((peak) => lineMentionsPeak(line, peak.name));
    if (mentioned) {
      current = mentioned;
    }
    if (!current) {
      return line;
    }
    const allowed = current.url ? blogUrlKey(current.url) : '';
    return line.replace(blogLinkPattern(), (full, label: string | undefined, mdUrl: string | undefined) => {
      const rawUrl = mdUrl ?? full;
      const { href, suffix } = mdUrl
        ? { href: rawUrl, suffix: '' }
        : trimUrlTrailingPunctuation(rawUrl);
      if (!isTrailonBlogUrl(href)) {
        return full;
      }
      if (allowed && blogUrlKey(href) === allowed) {
        return full;
      }
      if (label !== undefined && blogUrlKey(label) !== blogUrlKey(href)) {
        return label;
      }
      return suffix;
    });
  });
  return cleanupDanglingBlogLeadIn(rewritten.join('\n'));
}

function lineMentionsPeak(line: string, name: string): boolean {
  const haystack = normalizePeakName(line);
  const needle = normalizePeakName(name);
  if (!needle || !haystack) {
    return false;
  }
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) {
      return false;
    }
    const before = at === 0 ? '' : haystack.charAt(at - 1);
    const after = haystack.charAt(at + needle.length);
    const boundaryBefore = before === '' || !/[\p{L}\p{N}]/u.test(before);
    const boundaryAfter = after === '' || !/[\p{L}\p{N}]/u.test(after);
    if (boundaryBefore && boundaryAfter) {
      return true;
    }
    from = at + needle.length;
  }
  return false;
}

const PAREN_ELEVATION =
  /^\s*\(\s*\d{2,4}\s*m(?:\s*\.?\s*n\s*\.?\s*p\s*\.?\s*m\s*\.?)?(?:\s*[,;]\s*[^)\n]{0,80})?\s*\)/i;
const DASH_ELEVATION =
  /^\s*[—–-]\s*\d{2,4}\s*m(?:\s*\.?\s*n\s*\.?\s*p\s*\.?\s*m\s*\.?)?(?=\s|$|[,.;])/i;
const BARE_ELEVATION =
  /^\s*,?\s+\d{2,4}\s*m(?:\s*\.?\s*n\s*\.?\s*p\s*\.?\s*m\s*\.?)?(?=\s|$|[,.;])/i;
const INFLECTION_SUFFIXES = ['iem', 'owi', 'ach', 'ami', 'em', 'ie', 'om', 'ów', 'ą', 'ę', 'a', 'u', 'e', 'y', 'i', ''];

/**
 * Dopisuje wysokość przy nazwie szczytu: „Małołączniak (2020 m.n.p.m.)”.
 * Istniejący nawias albo zapis metrów tuż przy nazwie jest zastępowany tą formą.
 */
export function annotatePeakElevations(text: string, peaks: readonly GuidePeakElevation[]): string {
  const prepared = preparePeakElevations(peaks);
  if (!text || prepared.length === 0) {
    return text;
  }

  let out = '';
  let index = 0;
  while (index < text.length) {
    if (isInsideUrl(text, index)) {
      out += text.charAt(index);
      index += 1;
      continue;
    }
    const match = matchPeakAt(text, index, prepared);
    if (!match) {
      out += text.charAt(index);
      index += 1;
      continue;
    }

    const label = ` (${formatElevation(match.peak.elevationM)} m.n.p.m.)`;
    const word = text.slice(index, match.end);
    const boldWrapped = text.startsWith('**', match.end) && index >= 2 && text.slice(index - 2, index) === '**';
    if (boldWrapped) {
      const afterBold = match.end + 2;
      const outside = followingElevationLength(text, afterBold);
      if (outside > 0) {
        out += `${word}**${label}`;
        index = afterBold + outside;
        continue;
      }
    }

    const existing = followingElevationLength(text, match.end);
    out += word + label;
    index = match.end + existing;
  }
  return out;
}

function preparePeakElevations(
  peaks: readonly GuidePeakElevation[],
): Array<{ name: string; elevationM: number }> {
  const byName = new Map<string, { name: string; elevationM: number }>();
  for (const peak of peaks) {
    const name = peak.name.trim();
    const key = normalizePeakName(name);
    if (key.length < 3 || byName.has(key)) {
      continue;
    }
    if (!Number.isFinite(peak.elevationM) || peak.elevationM <= 0) {
      continue;
    }
    byName.set(key, { name, elevationM: peak.elevationM });
  }
  return [...byName.values()].sort((left, right) => right.name.length - left.name.length);
}

function formatElevation(elevationM: number): string {
  return String(Math.round(elevationM));
}

function matchPeakAt(
  text: string,
  index: number,
  peaks: ReadonlyArray<{ name: string; elevationM: number }>,
): { end: number; peak: { name: string; elevationM: number } } | undefined {
  if (index > 0 && isWordChar(text.charAt(index - 1))) {
    return undefined;
  }
  for (const peak of peaks) {
    if (index + peak.name.length > text.length) {
      continue;
    }
    const slice = text.slice(index, index + peak.name.length);
    if (slice.localeCompare(peak.name, 'pl', { sensitivity: 'accent' }) !== 0) {
      continue;
    }
    const suffixLength = inflectionSuffixLength(text.slice(index + peak.name.length));
    if (suffixLength < 0) {
      continue;
    }
    return { end: index + peak.name.length + suffixLength, peak };
  }
  return undefined;
}

function inflectionSuffixLength(rest: string): number {
  for (const suffix of INFLECTION_SUFFIXES) {
    if (suffix.length > 0 && !startsWithFold(rest, suffix)) {
      continue;
    }
    if (!isWordChar(rest.charAt(suffix.length))) {
      return suffix.length;
    }
  }
  return -1;
}

function startsWithFold(text: string, prefix: string): boolean {
  return text.slice(0, prefix.length).localeCompare(prefix, 'pl', { sensitivity: 'accent' }) === 0;
}

function isWordChar(char: string): boolean {
  return char !== '' && /[\p{L}\p{N}]/u.test(char);
}

function followingElevationLength(text: string, from: number): number {
  const slice = text.slice(from);
  return (
    PAREN_ELEVATION.exec(slice)?.[0].length ??
    DASH_ELEVATION.exec(slice)?.[0].length ??
    BARE_ELEVATION.exec(slice)?.[0].length ??
    0
  );
}

function isInsideUrl(text: string, index: number): boolean {
  const from = text.lastIndexOf('https://', index);
  if (from < 0 || from >= index) {
    return false;
  }
  return !/\s/.test(text.slice(from, index));
}

export function buildUrlTitleMap(sources: GuideSource[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const source of sources) {
    const url = (source.url ?? '').trim();
    if (!url.startsWith('https://trailon.pl/') && !isMountainIndustryUrl(url)) {
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
    `${BOLD_PATTERN.source}|${TRAILON_URL_PATTERN.source}|${mountainIndustryUrlSource()}`,
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
      const { href, suffix } = full.startsWith('https://trailon.pl/')
        ? trimUrlTrailingPunctuation(full)
        : trimGenericHttpsUrl(full);
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
        urlTitles.get(normalized) ??
        resolveTitle?.(token.url) ??
        industrySourceLabel(token.url) ??
        (token.url.startsWith('https://trailon.pl/') ? titleFromTrailonUrl(token.url) : 'Źródło');
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

const BLOG_LINK_LEAD_IN = /^(?:url|link|adres(?:\s+bloga)?)\s*[:\-–—]\s*/i;

/** Linia z samym adresem wpisu dostaje ludzki wstęp „Link do bloga:”. */
export function presentBlogLinkLine(line: string): string {
  if (/link\s+do\s+bloga/i.test(line)) {
    return line;
  }
  const stripped = line.replace(BLOG_LINK_LEAD_IN, '').trim();
  const asUrl = stripped.replace(/\[([^\]]+)\]\((https:\/\/trailon\.pl\/[^)]+)\)/gi, '$2').trim();
  const match = /https:\/\/trailon\.pl\/[^\s<>"')\]]+/i.exec(asUrl);
  if (!match) {
    return line;
  }
  const { href } = trimUrlTrailingPunctuation(match[0]);
  if (!isTrailonBlogUrl(href)) {
    return line;
  }
  const withoutUrl = asUrl.replace(match[0], '').trim();
  if (withoutUrl.length > 0) {
    return line;
  }
  return `Link do bloga: ${href}`;
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
        .map((line) => formatInlineParagraphToHtml(presentBlogLinkLine(line), urlTitles, resolveTitle))
        .join('<br/>');
      const gapBefore = index > 0 && isNumberedItemStart(lines[0] ?? '');
      const style = gapBefore ? ` style="margin-top:${NUMBERED_ITEM_GAP}"` : '';
      return `<p${style}>${inner}</p>`;
    })
    .join('');
}