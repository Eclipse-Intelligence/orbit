export const COMMENTS_PARAM = "comments";
export const COMMENT_PARAM = "comment";

export function commentHref(pageId: string, commentId: string) {
  return `/docs/${encodeURIComponent(pageId)}?${COMMENTS_PARAM}=1&${COMMENT_PARAM}=${encodeURIComponent(commentId)}`;
}
