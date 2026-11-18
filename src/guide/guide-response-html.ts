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

export function plainTextToGuideHtml(
  text: string,
  urlTitles: Map<string, string>,
  resolveTitle?: (url: string) => string | undefined,
): string {
  const trimmed = (text ?? '').trim();
  if (!trimmed) {
    return '<p></p>';
  }
  const paragraphs = trimmed.split(/\r?\n\s*\r?\n/g);
  return paragraphs
    .map((paragraph) => {
      const lines = paragraph.split(/\r?\n/);
      const inner = lines
        .map((line) => formatInlineParagraphToHtml(line, urlTitles, resolveTitle))
        .join('<br/>');
      return `<p>${inner}</p>`;
    })
    .join('');
}