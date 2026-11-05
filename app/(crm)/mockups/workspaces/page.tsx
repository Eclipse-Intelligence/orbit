import { MOCK_STATES, type MockState } from "./mock-data";
import WorkspaceMockups from "./mockups";

export const dynamic = "force-dynamic";

export default async function WorkspaceMockupsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = typeof params.state === "string" ? params.state : "A";
  const state: MockState = (MOCK_STATES as readonly string[]).includes(requested) ? (requested as MockState) : "A";
  return <WorkspaceMockups key={`${state}-${params.device}`} state={state} phone={params.device === "iphone"} />;
}
