import { redirect } from "next/navigation";
import ConnectChromeForm from "@/components/extension/connect-chrome-form";
import { getUserActor, getWorkspaceChoices } from "@/lib/auth/user";
import { formatPairingCode, pairingState } from "@/lib/extension/pairing";
import Logo from "@/public/assets/images/_common/logo.svg";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Connect Chrome extension",
  robots: { index: false, follow: false },
};

const CLOSED: Record<string, { title: string; text: string }> = {
  approved: { title: "Already approved", text: "This browser is connected. Go back to the extension." },
  used: { title: "Already connected", text: "This code was used. Go back to the extension, or press Connect there again." },
  declined: { title: "Cancelled", text: "Nothing was connected. Press Connect in the extension to try again." },
  expired: { title: "Code expired", text: "Codes work for 10 minutes. Press Connect in the extension again." },
  missing: { title: "Code not found", text: "Press Connect in the extension and use the tab it opens." },
};

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ConnectChromePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const code = first(params.code)?.slice(0, 20) ?? "";
  const suggested = first(params.name)?.replace(/\s+/g, " ").trim().slice(0, 120) || "Chrome";
  const user = await getUserActor();
  if (!user) {
    const next = `/connect/chrome?${new URLSearchParams({ code, name: suggested }).toString()}`;
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  const [{ state }, workspaces] = await Promise.all([pairingState(code), getWorkspaceChoices()]);
  const closed = state === "pending" ? null : CLOSED[state];
  return (
    <main className="flex min-h-dvh items-start justify-center px-4 pt-[9vh] pb-10">
      <div className="flex w-full max-w-[26em] flex-col gap-6">
        <div className="flex flex-col items-start gap-4">
          <Logo aria-hidden className="size-10 overflow-visible" />
          <h1 className="leading-6">{closed ? closed.title : "Connect Chrome extension"}</h1>
          <p className="text-subtle text-[14px] leading-5">
            {closed ? closed.text : `The Orbit extension wants to use Orbit as ${user.fullName || user.email}.`}
          </p>
        </div>
        {!closed && (
          <ConnectChromeForm
            code={formatPairingCode(code)}
            suggestedName={suggested}
            workspaces={workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }))}
          />
        )}
      </div>
    </main>
  );
}
