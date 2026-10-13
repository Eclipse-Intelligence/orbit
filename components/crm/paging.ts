export const PAGE_SIZE = 100;
export const MAX_PAGE = 101;

export function pageFromParams(params: URLSearchParams) {
  const page = Number(params.get("page"));
  return Number.isInteger(page) && page > 1 ? Math.min(page, MAX_PAGE) : 1;
}

export function pageOffset(page: number) {
  return (page - 1) * PAGE_SIZE;
}
