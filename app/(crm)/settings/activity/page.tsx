import { redirect } from "next/navigation";
import ActivityLog from "@/components/crm/activity-log";
import { AGENT_PREFIX, EVERYONE } from "@/lib/crm/activity-log";
import RecordTransfer from "@/components/crm/record-transfer";
import { SettingsPage } from "@/components/crm/settings-ui";
import { PAGE_SIZE, pageFromParams, pageOffset } from "@/components/crm/paging";
import { getUserActor } from "@/lib/auth/user";
import { listActivities, listActivityAgents } from "@/lib/crm/activities";
import { listMembers } from "@/lib/crm/companies";
import { activityQueryFromSearchParams } from "@/lib/crm/validation";

export const dynamic = "force-dynamic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function day(value: string | null) {
  return value && DAY.test(value) ? value : "";
}

export default async function ActivityLogPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getUserActor();
  if (!user) redirect("/login");
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === "string") params.set(key, value);
  }
  const [members, agents] = await Promise.all([listMembers(user), listActivityAgents(user)]);
  const wanted = params.get("person") ?? "";
  const agentId = wanted.startsWith(AGENT_PREFIX) ? wanted.slice(AGENT_PREFIX.length) : null;
  const person =
    wanted === EVERYONE || members.some((member) => member.id === wanted) || (agentId && agents.some((agent) => agent.id === agentId))
      ? wanted
      : user.userId;
  const from = day(params.get("from"));
  const to = day(params.get("to"));
  const query = new URLSearchParams();
  for (const key of ["q", "type"]) {
    const value = params.get(key);
    if (value) query.set(key, value);
  }
  if (person.startsWith(AGENT_PREFIX)) query.set("actor_agent_id", person.slice(AGENT_PREFIX.length));
  else if (person !== EVERYONE) query.set("actor_user_id", person);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  const filters = activityQueryFromSearchParams(query);
  const page = pageFromParams(params);
  filters.limit = PAGE_SIZE;
  filters.offset = pageOffset(page);
  const listed = await listActivities(user, filters);

  return (
    <SettingsPage
      title="Activity log"
      description="Calls, emails, meetings and notes logged by each person."
      action={<RecordTransfer resource="activities" />}
      wide
    >
      <ActivityLog
        viewerId={user.userId}
        members={members}
        agents={agents}
        person={person}
        type={filters.type ?? ""}
        from={from}
        to={to}
        query={filters.query ?? ""}
        activities={listed.data}
        total={listed.total}
        page={page}
      />
    </SettingsPage>
  );
}
