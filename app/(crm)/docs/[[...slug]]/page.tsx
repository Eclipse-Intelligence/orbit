import type { Metadata } from "next";
import { redirect } from "next/navigation";
import DocsScreen from "@/components/docs/docs-screen";
import { getUserActor } from "@/lib/auth/user";
import { parseDocsRoute } from "@/lib/docs/routes";
import { loadDocsInitial } from "@/lib/docs/server";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Docs" };

function decoded(part: string) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function searchParamsFrom(values: Record<string, string | string[] | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") params.set(key, value);
    else if (Array.isArray(value) && value[0]) params.set(key, value[0]);
  }
  return params;
}

export default async function DocsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const [{ slug = [] }, search] = await Promise.all([params, searchParams]);
  const pathname = `/docs${slug.length ? `/${slug.map((part) => encodeURIComponent(decoded(part))).join("/")}` : ""}`;
  const route = parseDocsRoute(pathname, searchParamsFrom(search));
  const initial = await loadDocsInitial(user, route);

  return (
    <DocsScreen
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
      initial={initial}
    />
  );
}
