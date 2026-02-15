import type { IngestItem } from "../doctype.js";

export interface ArticleMetadata {
  title?: string;
  author?: string;
  publishDate?: string;
  url?: string;
  [key: string]: unknown;
}

export function extractArticle(item: IngestItem): ArticleMetadata {
  const result: ArticleMetadata = {};
  const text = item.text;
  
  // Early return if no text available
  if (!text) {
    return result;
  }

  // Extract Open Graph tags from HTML
  const ogTitle = text.match(
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
  );
  if (ogTitle) {
    result.title = ogTitle[1];
  }

  const ogAuthor = text.match(
    /<meta\s+(?:property|name)=["'](?:og:|article:)?author["']\s+content=["']([^"']+)["']/i,
  );
  if (ogAuthor) {
    result.author = ogAuthor[1];
  }

  const ogPublished = text.match(
    /<meta\s+property=["']article:published_time["']\s+content=["']([^"']+)["']/i,
  );
  if (ogPublished) {
    result.publishDate = ogPublished[1];
  }

  // Fallback to HTML title tag
  if (!result.title) {
    const titleMatch = text.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      result.title = titleMatch[1].trim();
    }
  }

  // Fallback to meta author tag
  if (!result.author) {
    const authorMatch = text.match(
      /<meta\s+name=["']author["']\s+content=["']([^"']+)["']/i,
    );
    if (authorMatch) {
      result.author = authorMatch[1];
    }
  }

  // Extract from markdown frontmatter if present
  if (text.startsWith("---")) {
    const frontmatterMatch = text.match(/^---\n([\s\S]+?)\n---/);
    if (frontmatterMatch) {
      const frontmatter = frontmatterMatch[1];
      const titleMatch = frontmatter.match(/^title:\s*(.+)$/m);
      const authorMatch = frontmatter.match(/^author:\s*(.+)$/m);
      const dateMatch = frontmatter.match(/^date:\s*(.+)$/m);

      if (titleMatch && !result.title) result.title = titleMatch[1].trim();
      if (authorMatch && !result.author) result.author = authorMatch[1].trim();
      if (dateMatch && !result.publishDate)
        result.publishDate = dateMatch[1].trim();
    }
  }

  // Use source as URL if it looks like a URL
  if (item.source?.startsWith("http")) {
    result.url = item.source;
  }

  return result;
}
