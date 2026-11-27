import { z } from "zod";
import { deletePublicComment, editCommentSchema, editPublicComment } from "@/lib/docs/public-comments";
import { badRequest, COMMENT_HEADERS, failure, notFound, readJson, visitor } from "@/lib/docs/public-comments-http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token: string; id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const { token, id } = await params;
  const { key, client } = visitor(request);
  const parsed = editCommentSchema.safeParse(await readJson(request));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "Couldn't save the comment. Try again.");
  if (!key || !z.uuid().safeParse(id).success) return notFound();
  try {
    const comment = await editPublicComment(token, key, client, id, parsed.data.body);
    if (!comment) return notFound();
    return Response.json({ comment }, { headers: COMMENT_HEADERS });
  } catch (error) {
    return failure(error, "Couldn't save the comment. Try again.");
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const { token, id } = await params;
  const { key, client } = visitor(request);
  if (!key || !z.uuid().safeParse(id).success) return notFound();
  try {
    if (!(await deletePublicComment(token, key, client, id))) return notFound();
    return Response.json({ deleted: true }, { headers: COMMENT_HEADERS });
  } catch (error) {
    return failure(error, "Couldn't delete the comment. Try again.");
  }
}
