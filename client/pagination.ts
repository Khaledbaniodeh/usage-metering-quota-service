/**
 * Walks a cursor-paginated list to its end, refusing anything that would make the result wrong
 * or the walk endless: a repeated item, a repeated cursor, an empty page that claims a successor,
 * or more pages than expected.
 */

export interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface Traversal<Item> {
  /** Every item, in the order the pages returned them. */
  readonly items: readonly Item[];
  readonly pages: number;
}

export const DEFAULT_MAX_PAGES = 1_000;

export class PaginationError extends Error {
  override readonly name = "PaginationError";
}

export async function collectAllPages<Item>(
  fetchPage: (cursor: string | undefined) => Promise<PageResult<Item>>,
  keyOf: (item: Item) => string,
  maxPages: number = DEFAULT_MAX_PAGES,
): Promise<Traversal<Item>> {
  const items: Item[] = [];
  const seenKeys = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pages = 1; pages <= maxPages; pages += 1) {
    const page = await fetchPage(cursor);
    for (const item of page.items) {
      const key = keyOf(item);
      if (seenKeys.has(key)) {
        throw new PaginationError(`item ${key} was returned twice (page ${String(pages)})`);
      }
      seenKeys.add(key);
      items.push(item);
    }
    if (page.nextCursor === null) {
      return { items, pages };
    }
    if (page.items.length === 0) {
      throw new PaginationError(`page ${String(pages)} was empty but announced another page`);
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new PaginationError(`page ${String(pages)} repeated an earlier cursor`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new PaginationError(`the list did not end within ${String(maxPages)} pages`);
}
