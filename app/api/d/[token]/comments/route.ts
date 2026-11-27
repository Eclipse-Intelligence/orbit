import { scheduleDocAlert } from "@/lib/docs/comment-alerts";
import { addCommentSchema, addPublicComment, listPublicComments } from "@/lib/docs/public-comments";
import { badRequest, COMMENT_HEADERS, failure, notFound, readJson, visitor } from "@/lib/docs/public-comments-http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { key, client } = visitor(request);
  try {
    const comments = await listPublicComments(token, key, client);
    if (!comments) return notFound();
    return Response.json({ comments }, { headers: COMMENT_HEADERS });
  } catch (error) {
    return failure(error, "Couldn't load comments. Try again.");
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const { key, client } = visitor(request);
  const parsed = addCommentSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Couldn't comment. Try again.");
  if (!key) return badRequest("Couldn't comment. Try again.");
  try {
    const comment = await addPublicComment(token, key, client, parsed.data);
    if (!comment) return notFound();
    await scheduleDocAlert(comment.id);
    return Response.json({ comment }, { status: 201, headers: COMMENT_HEADERS });
  } catch (error) {
    return failure(error, "Couldn't comment. Try again.");
  }
}
