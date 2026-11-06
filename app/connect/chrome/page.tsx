import { redirect } from "next/navigation";
import ConnectChromeForm from "@/components/extension/connect-chrome-form";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import Logo from "@/public/assets/images/_common/logo.svg";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect Chrome extension",
  robots: { index: false, follow: false },
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConnectChromePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const suggested = first(params.name)?.replace(/\s+/g, " ").trim().slice(0, 120) || "Chrome";
  const user = await getUserActor();
  if (!user) {
    const next = `/connect/chrome?${new URLSearchParams({ name: suggested }).toString()}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const workspaces = await getWorkspaceChoices();
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 pt-[9vh] pb-10">
      <div className="flex w-full max-w-[26em] flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <Logo aria-hidden className="size-10 overflow-visible" />
          <h1>Connect Chrome extension</h1>
          <p className="text-subtle">Approve the Orbit extension to use Orbit as {user.fullName || user.email}.</p>
        </div>
        <ConnectChromeForm
          suggestedName={suggested}
          homeWorkspaceId={workspaces[0]?.id ?? null}
          workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
        />
      </div>
    </main>
  );
}
