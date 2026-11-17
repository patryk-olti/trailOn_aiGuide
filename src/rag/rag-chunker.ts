import { RAG_MAX_CHUNK_CHARS } from './rag.constants';
import { RagChunkDraft } from './rag.types';

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function splitMarkdownSections(markdown: string): Array<{ section?: string; body: string }> {
  const lines = markdown.split('\n');
  const sections: Array<{ section?: string; body: string }> = [];
  let currentTitle: string | undefined;
  let currentLines: string[] = [];

  const flush = (): void => {
    const body = currentLines.join('\n').trim();
    if (body.length > 0) {
      sections.push({ section: currentTitle, body });
    }
    currentLines = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (headingMatch) {
      flush();
      currentTitle = headingMatch[2].trim();
      continue;
    }
    currentLines.push(line);
  }
  flush();

  if (sections.length === 0 && markdown.trim().length > 0) {
    return [{ body: markdown.trim() }];
  }
  return sections;
}

function splitBySize(text: string): string[] {
  if (text.length <= RAG_MAX_CHUNK_CHARS) {
    return [text];
  }
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + RAG_MAX_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      if (paragraphBreak > start + 400) {
        end = paragraphBreak;
      } else {
        const spaceBreak = text.lastIndexOf(' ', end);
        if (spaceBreak > start + 400) {
          end = spaceBreak;
        }
      }
    }
    parts.push(text.slice(start, end).trim());
    start = end;
  }
  return parts.filter((part) => part.length > 0);
}

export function expandChunkDrafts(base: Omit<RagChunkDraft, 'chunkId' | 'text'> & { text: string }): RagChunkDraft[] {
  const markdownSections = base.text.includes('#') ? splitMarkdownSections(base.text) : [];
  const sectionBodies: Array<{ section?: string; body: string }> =
    markdownSections.length > 0
      ? markdownSections
      : splitParagraphs(base.text).map((body) => ({ body }));

  const drafts: RagChunkDraft[] = [];
  let index = 0;
  for (const section of sectionBodies) {
    const pieces = splitBySize(section.body);
    for (const piece of pieces) {
      index += 1;
      drafts.push({
        ...base,
        chunkId: `${base.key}#${index}`,
        section: section.section ?? base.section,
        text: piece,
      });
    }
  }
  return drafts;
}