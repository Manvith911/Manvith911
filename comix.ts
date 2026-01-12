/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseScraper } from './base';
import { ScrapedChapter, ScrapedPage, ScanlatorInfo } from '@/types/manhwa';

export class ComixScraper extends BaseScraper {
  private readonly baseUrl = 'https://comix.to';
  private readonly apiBase = 'https://comix.to/api/v2';

  getName(): string {
    return 'Comix';
  }

  canHandle(url: string): boolean {
    return url.includes('comix.to');
  }

  async extractMangaInfo(url: string): Promise<{ title: string; id: string }> {
    const urlMatch = url.match(/\/(?:comic|title)\/([^/]+)/);
    if (!urlMatch) {
      throw new Error('Invalid Comix URL format');
    }

    const hashId = urlMatch[1].split('-')[0];

    try {
      const response = await fetch(`${this.apiBase}/manga/${hashId}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      return {
        title: data.result?.title || hashId,
        id: hashId
      };
    } catch (error) {
      console.error('[Comix] Error extracting manga info:', error);
      return {
        title: hashId,
        id: hashId
      };
    }
  }

  async getChapterList(mangaUrl: string): Promise<ScrapedChapter[]> {
    const chapters: ScrapedChapter[] = [];

    const urlMatch = mangaUrl.match(/\/(?:comic|title)\/([^/]+)/);
    if (!urlMatch) {
      throw new Error('Invalid Comix URL format');
    }

    const hashId = urlMatch[1].split('-')[0];

    try {
      const mangaResponse = await fetch(`${this.apiBase}/manga/${hashId}`);
      if (!mangaResponse.ok) {
        throw new Error(`HTTP ${mangaResponse.status}: ${mangaResponse.statusText}`);
      }

      const mangaData = await mangaResponse.json();
      const slug = mangaData.result?.slug || '';

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const response = await fetch(
          `${this.apiBase}/manga/${hashId}/chapters?order[number]=desc&limit=100&page=${currentPage}`
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.result?.items && Array.isArray(data.result.items)) {
          for (const chapter of data.result.items) {
            const chapterUrl = `${this.baseUrl}/title/${hashId}-${slug}/${chapter.chapter_id}-chapter-${chapter.number}`;

            // Extract scanlator info if available
            let scanlator: ScanlatorInfo | undefined;
            if (chapter.scanlation_group) {
              scanlator = {
                id: chapter.scanlation_group.scanlation_group_id,
                name: chapter.scanlation_group.name,
                slug: chapter.scanlation_group.slug
              };
            }

            chapters.push({
              id: `${chapter.chapter_id}`,
              number: chapter.number,
              title: chapter.name || `Chapter ${chapter.number}`,
              url: chapterUrl,
              pages: [],
              isDownloaded: false,
              scanlator
            });
          }

          const pagination = data.result.pagination;
          if (pagination && currentPage < pagination.last_page) {
            currentPage++;
            await this.delay(500);
          } else {
            hasMorePages = false;
          }
        } else {
          hasMorePages = false;
        }
      }

      console.log(`[Comix] Found ${chapters.length} chapters for ${hashId}`);
    } catch (error) {
      console.error('[Comix] Error fetching chapters:', error);
      throw error;
    }

    return chapters.sort((a, b) => a.number - b.number);
  }

  async getChapterPages(chapterUrl: string): Promise<ScrapedPage[]> {
    const html = await this.fetchWithRetry(chapterUrl);
    const pages: ScrapedPage[] = [];

    // The script contains escaped JSON like: \"images\":[{\"width\":800,\"url\":\"...\"}]
    // We need to match the escaped form and then unescape it

    // Try to find the images array in the escaped JSON format
    // Pattern: \"images\":[...],\"prev\" (with escaped quotes)
    const escapedMatch = html.match(/\\"images\\":\[([\s\S]*?)\],\\"prev\\"/);

    if (escapedMatch && escapedMatch[1]) {
      try {
        // The content has escaped quotes: {\"width\":800,\"url\":\"...\"}
        let imagesStr = escapedMatch[1];
        // Unescape: \" -> " and \\ -> \
        imagesStr = imagesStr.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const images = JSON.parse(`[${imagesStr}]`);

        images.forEach((img: { url: string; width: number; height: number }, index: number) => {
          if (img.url) {
            pages.push({
              pageNumber: index + 1,
              imageUrl: img.url,
              isDownloaded: false
            });
          }
        });
      } catch (e) {
        console.error('[Comix] Failed to parse escaped images JSON:', e);
      }
    }

    // Fallback: try non-escaped format (in case the page renders differently)
    if (pages.length === 0) {
      const directMatch = html.match(/"images":\[([\s\S]*?)\],"prev"/);

      if (directMatch && directMatch[1]) {
        try {
          const images = JSON.parse(`[${directMatch[1]}]`);

          images.forEach((img: { url: string; width: number; height: number }, index: number) => {
            if (img.url) {
              pages.push({
                pageNumber: index + 1,
                imageUrl: img.url,
                isDownloaded: false
              });
            }
          });
        } catch (e) {
          console.error('[Comix] Failed to parse direct images JSON:', e);
        }
      }
    }

    console.log(`[Comix] Found ${pages.length} pages for chapter`);
    return pages;
  }

  protected extractChapterNumber(chapterUrl: string): number {
    const match = chapterUrl.match(/chapter-(\d+(?:\.\d+)?)/i);
    if (match) {
      return parseFloat(match[1]);
    }
    return 0;
  }

  async search(query: string): Promise<SearchResult[]> {
    const searchUrl = `${this.apiBase}/manga?order[relevance]=desc&keyword=${encodeURIComponent(query)}&limit=5`;
    const results: SearchResult[] = [];

    try {
      const response = await fetch(searchUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.result?.items && Array.isArray(data.result.items)) {
        for (const manga of data.result.items) {
          let coverImage: string | undefined;
          if (manga.poster?.large) {
            coverImage = manga.poster.large;
          } else if (manga.poster?.medium) {
            coverImage = manga.poster.medium;
          }

          let lastUpdated = '';
          let lastUpdatedTimestamp: number | undefined;
          if (manga.chapter_updated_at) {
            lastUpdatedTimestamp = manga.chapter_updated_at * 1000;
            lastUpdated = new Date(lastUpdatedTimestamp).toLocaleDateString();
          }

          results.push({
            id: manga.hash_id,
            title: manga.title,
            url: `${this.baseUrl}/title/${manga.hash_id}-${manga.slug}`,
            coverImage,
            latestChapter: manga.latest_chapter || 0,
            lastUpdated,
            lastUpdatedTimestamp,
            rating: manga.rated_avg,
            followers: manga.follows_total?.toString()
          });
        }
      }

      console.log(`[Comix] Found ${results.length} results for query: ${query}`);
    } catch (error) {
      console.error('[Comix] Search error:', error);
      throw error;
    }

    return results;
  }
}

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  coverImage?: string;
  latestChapter: number;
  lastUpdated: string;
  lastUpdatedTimestamp?: number;
  rating?: number;
  followers?: string;
}

/**
 * Extract unique scanlators from a list of chapters.
 * Returns scanlators sorted by the number of chapters they have (most to least).
 */
export function extractScanlators(chapters: ScrapedChapter[]): ScanlatorInfo[] {
  const scanlatorMap = new Map<number, { info: ScanlatorInfo; count: number }>();

  for (const chapter of chapters) {
    if (chapter.scanlator) {
      const existing = scanlatorMap.get(chapter.scanlator.id);
      if (existing) {
        existing.count++;
      } else {
        scanlatorMap.set(chapter.scanlator.id, {
          info: chapter.scanlator,
          count: 1
        });
      }
    }
  }

  // Sort by chapter count (descending)
  return Array.from(scanlatorMap.values())
    .sort((a, b) => b.count - a.count)
    .map(item => item.info);
}

/**
 * Check if chapters have multiple scanlators (i.e., same chapter number from different scanlators)
 */
export function hasMultipleScanlators(chapters: ScrapedChapter[]): boolean {
  const scanlatorIds = new Set<number>();

  for (const chapter of chapters) {
    if (chapter.scanlator) {
      scanlatorIds.add(chapter.scanlator.id);
      if (scanlatorIds.size > 1) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Filter chapters to only include those from a specific scanlator.
 * When multiple chapters have the same number, only keeps the one from the preferred scanlator.
 */
export function filterChaptersByScanlator(
  chapters: ScrapedChapter[],
  scanlatorId: number
): ScrapedChapter[] {
  // Group chapters by number
  const chaptersByNumber = new Map<number, ScrapedChapter[]>();

  for (const chapter of chapters) {
    const existing = chaptersByNumber.get(chapter.number) || [];
    existing.push(chapter);
    chaptersByNumber.set(chapter.number, existing);
  }

  const result: ScrapedChapter[] = [];

  for (const [, chaptersWithSameNumber] of chaptersByNumber) {
    // Try to find a chapter from the preferred scanlator
    const preferredChapter = chaptersWithSameNumber.find(
      ch => ch.scanlator?.id === scanlatorId
    );

    if (preferredChapter) {
      result.push(preferredChapter);
    }
    // If preferred scanlator doesn't have this chapter, we don't include it
    // (user wants only their scanlator's releases)
  }

  return result.sort((a, b) => a.number - b.number);
}

/**
 * Get the best chapter for each chapter number.
 * If no preference, takes the first available (usually most recent upload).
 * If preference set, prioritizes that scanlator.
 */
export function deduplicateChapters(
  chapters: ScrapedChapter[],
  preferredScanlatorId?: number
): ScrapedChapter[] {
  // Group chapters by number
  const chaptersByNumber = new Map<number, ScrapedChapter[]>();

  for (const chapter of chapters) {
    const existing = chaptersByNumber.get(chapter.number) || [];
    existing.push(chapter);
    chaptersByNumber.set(chapter.number, existing);
  }

  const result: ScrapedChapter[] = [];

  for (const [, chaptersWithSameNumber] of chaptersByNumber) {
    if (preferredScanlatorId) {
      // Try to find a chapter from the preferred scanlator first
      const preferredChapter = chaptersWithSameNumber.find(
        ch => ch.scanlator?.id === preferredScanlatorId
      );
      if (preferredChapter) {
        result.push(preferredChapter);
        continue;
      }
    }
    // Fall back to first available chapter
    result.push(chaptersWithSameNumber[0]);
  }

  return result.sort((a, b) => a.number - b.number);
}
