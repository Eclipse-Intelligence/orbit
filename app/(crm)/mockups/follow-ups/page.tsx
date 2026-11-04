import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import FollowUpMockups, { type MockState } from "./mockups";

export const dynamic = "force-dynamic";

const STATES: MockState[] = [
  "A",
  "A-reminder",
  "B-empty",
  "B-written",
  "C",
  "C-unwritten",
  "C-done",
  "D-capture",
  "D-notification",
  "E-thread",
  "E-task",
];

export default async function FollowUpMockupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const requested = typeof resolved.s === "string" ? resolved.s : "A";
  const state = STATES.find((item) => item === requested) ?? "A";
  return (
    <FollowUpMockups
      state={state}
      viewer={{
        id: user.userId,
        name: user.fullName || user.email,
        email: user.email,
        role: user.role,
        workspaceName: user.workspaceName,
      }}
    />
  );
}
