import ActionMockup from "./action-mockup";
import { SCENES } from "./mock-data";

export const dynamic = "force-dynamic";

export default async function ActionNeededMockupPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { scene } = await searchParams;
  const chosen = SCENES.find((item) => item === scene) ?? "full";
  return <ActionMockup scene={chosen} />;
}
