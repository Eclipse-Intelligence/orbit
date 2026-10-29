import { cache } from "react";
import type { DocsNav, DocsSeed, Page, PageFilter, PageSummary } from "@/lib/docs/client-types";
import { createFakeDocs } from "@/lib/docs/fake-adapter";
import type { DocsRoute } from "@/lib/docs/routes";

export type DocsViewer = { userId: string; fullName: string | null; email: string };

export type DocsInitial = {
  list: PageFilter;
  summaries: PageSummary[];
  page: Page | null;
};

const requestNow = cache(() => new Date().toISOString());

const docsFor = cache((viewerId: string, viewerName: string) => createFakeDocs({ now: requestNow(), viewer: { id: viewerId, name: viewerName } }));

export function docsSeed(user: DocsViewer): DocsSeed {
  return { now: requestNow(), viewer: { id: user.userId, name: user.fullName || user.email } };
}

function docs(user: DocsViewer) {
  const seed = docsSeed(user);
  return docsFor(seed.viewer.id, seed.viewer.name);
}

export async function loadDocsNav(user: DocsViewer): Promise<DocsNav> {
  return docs(user).nav();
}

export async function loadDocsInitial(user: DocsViewer, route: DocsRoute): Promise<DocsInitial> {
  const source = docs(user);
  const summaries = await source.listPages(route.list);
  let page: Page | null = null;
  if (route.pageId) page = await source.getPage(route.pageId);
  else if (route.date) page = await source.dailyNote(route.date);
  else if (route.list.kind === "daily") page = await source.dailyNote((await source.nav()).today);
  else if (summaries[0]) page = await source.getPage(summaries[0].id);
  return { list: route.list, summaries, page };
}
