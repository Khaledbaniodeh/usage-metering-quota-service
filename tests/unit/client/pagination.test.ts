import { describe, expect, it } from "vitest";
import { collectAllPages, PaginationError, type PageResult } from "../../../client/pagination.js";

/** Pages keyed by the cursor that requests them (`undefined` for the first page). */
function pagesFrom(pages: Readonly<Record<string, PageResult<string>>>) {
  const requested: (string | undefined)[] = [];
  const fetchPage = (cursor: string | undefined) => {
    requested.push(cursor);
    const page = pages[cursor ?? "first"];
    return page === undefined
      ? Promise.reject(new Error(`unexpected cursor ${String(cursor)}`))
      : Promise.resolve(page);
  };
  return { fetchPage, requested };
}

const identity = (item: string) => item;

describe("collectAllPages", () => {
  it("follows each nextCursor until null and keeps the page order", async () => {
    const { fetchPage, requested } = pagesFrom({
      first: { items: ["a"], nextCursor: "c1" },
      c1: { items: ["b"], nextCursor: "c2" },
      c2: { items: ["c"], nextCursor: null },
    });

    const traversal = await collectAllPages(fetchPage, identity);

    expect(traversal).toEqual({ items: ["a", "b", "c"], pages: 3 });
    expect(requested).toEqual([undefined, "c1", "c2"]);
  });

  it("returns a single page as is, including an empty list", async () => {
    const { fetchPage } = pagesFrom({ first: { items: [], nextCursor: null } });

    expect(await collectAllPages(fetchPage, identity)).toEqual({ items: [], pages: 1 });
  });

  it("rejects an item returned twice", async () => {
    const { fetchPage } = pagesFrom({
      first: { items: ["a"], nextCursor: "c1" },
      c1: { items: ["a"], nextCursor: null },
    });

    await expect(collectAllPages(fetchPage, identity)).rejects.toThrow(
      new PaginationError("item a was returned twice (page 2)"),
    );
  });

  it("rejects a repeated cursor instead of looping", async () => {
    const { fetchPage } = pagesFrom({
      first: { items: ["a"], nextCursor: "c1" },
      c1: { items: ["b"], nextCursor: "c1" },
    });

    await expect(collectAllPages(fetchPage, identity)).rejects.toThrow(
      "page 2 repeated an earlier cursor",
    );
  });

  it("rejects an empty page that announces another page", async () => {
    const { fetchPage } = pagesFrom({ first: { items: [], nextCursor: "c1" } });

    await expect(collectAllPages(fetchPage, identity)).rejects.toThrow(
      "page 1 was empty but announced another page",
    );
  });

  it("stops after the page budget", async () => {
    let page = 0;
    const endless = () => {
      page += 1;
      return Promise.resolve({ items: [`item-${String(page)}`], nextCursor: `c${String(page)}` });
    };

    await expect(collectAllPages(endless, identity, 3)).rejects.toThrow(
      "the list did not end within 3 pages",
    );
    expect(page).toBe(3);
  });

  it("propagates a failing page request", async () => {
    const failing = () => Promise.reject(new Error("GET /v1/users: expected HTTP 200, got 503"));

    await expect(collectAllPages(failing, identity)).rejects.toThrow("got 503");
  });
});
