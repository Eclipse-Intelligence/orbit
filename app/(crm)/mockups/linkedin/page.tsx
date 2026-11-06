import { redirect } from "next/navigation";
import { getUserActor } from "@/lib/auth/user";
import LinkedinMockup from "./linkedin-mockup";
import { SCENES } from "./mock-data";

export const dynamic = "force-dynamic";

export default async function LinkedinMockupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const { scene, crop } = await searchParams;
  const chosen = SCENES.find((item) => item === scene) ?? "new-person";
  return (
    <LinkedinMockup
      scene={chosen}
      crop={crop === "1"}
      workspace={{ id: user.workspaceId, name: user.workspaceName }}
      viewer={{ id: user.userId, name: user.fullName || user.email, email: user.email, role: user.role, workspaceName: user.workspaceName }}
    />
  );
}
