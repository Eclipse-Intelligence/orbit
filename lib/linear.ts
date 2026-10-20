const DEFAULT_URL = "https://api.linear.app/graphql";
const TIMEOUT_MS = 15_000;
const TEAM_TTL_MS = 5 * 60 * 1000;

export const LINEAR_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
type LinearPriority = (typeof LINEAR_PRIORITIES)[number];

const PRIORITY_VALUE: Record<LinearPriority, number> = { urgent: 1, high: 2, medium: 3, low: 4 };

type LinearOptions = { fetchImpl?: typeof fetch; url?: string; apiKey?: string | null; teamKey?: string };

type LinearState = { id: string; name: string; type: string };

type LinearTeam = {
  id: string;
  key: string;
  name: string;
  states: LinearState[];
  labels: { id: string; name: string }[];
};

type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string | null;
  stateType: string | null;
  priority: string | null;
  assignee: string | null;
  project: string | null;
  labels: string[];
  createdAt: string;
  updatedAt: string;
};

type LinearIssueDetail = LinearIssue & {
  description: string | null;
  comments: { author: string | null; body: string; createdAt: string }[];
};

export class LinearError extends Error {}

type IssueNode = {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priorityLabel: string | null;
  createdAt: string;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  project: { name: string } | null;
  labels: { nodes: { name: string }[] } | null;
};

const ISSUE_FIELDS = `
  id identifier title url priorityLabel createdAt updatedAt
  state { name type }
  assignee { name }
  project { name }
  labels { nodes { name } }
`;

let teamCache: { key: string; at: number; team: LinearTeam } | null = null;

function linearApiKey() {
  return process.env.LINEAR_API_KEY?.trim() || null;
}

export function linearTeamKey() {
  return process.env.LINEAR_TEAM_KEY?.trim().toUpperCase() || "CNT";
}

export function resetLinearCache() {
  teamCache = null;
}

async function linearRequest<T>(query: string, variables: Record<string, unknown>, options: LinearOptions = {}): Promise<T> {
  const apiKey = options.apiKey === undefined ? linearApiKey() : options.apiKey;
  if (!apiKey) throw new LinearError("Linear isn't connected. Add LINEAR_API_KEY to the server environment.");
  const url = options.url ?? (process.env.LINEAR_API_URL?.trim() || DEFAULT_URL);
  const fetcher = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LinearError("Couldn't reach Linear. Try again in a moment.");
  }
  const payload = (await response.json().catch(() => null)) as { data?: T; errors?: { message?: string }[] } | null;
  if (response.status === 401 || response.status === 403) {
    throw new LinearError("Linear rejected the API key. Check LINEAR_API_KEY.");
  }
  if (response.status === 429) throw new LinearError("Linear is rate limiting Orbit. Try again in a minute.");
  if (!response.ok || !payload || payload.errors?.length || !payload.data) {
    const message = payload?.errors?.[0]?.message;
    throw new LinearError(message ? `Linear said: ${message}` : `Linear returned ${response.status}.`);
  }
  return payload.data;
}

function mapIssue(node: IssueNode): LinearIssue {
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    state: node.state?.name ?? null,
    stateType: node.state?.type ?? null,
    priority: node.priorityLabel && node.priorityLabel !== "No priority" ? node.priorityLabel : null,
    assignee: node.assignee?.name ?? null,
    project: node.project?.name ?? null,
    labels: node.labels?.nodes.map((label) => label.name) ?? [],
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

async function getLinearTeam(options: LinearOptions = {}): Promise<LinearTeam> {
  const key = options.teamKey ?? linearTeamKey();
  if (teamCache && teamCache.key === key && Date.now() - teamCache.at < TEAM_TTL_MS && !options.fetchImpl) return teamCache.team;
  const data = await linearRequest<{
    teams: {
      nodes: {
        id: string;
        key: string;
        name: string;
        states: { nodes: (LinearState & { position: number })[] };
        labels: { nodes: { id: string; name: string }[] };
      }[];
    };
  }>(
    `query Team($key: String!) {
      teams(filter: { key: { eq: $key } }) {
        nodes {
          id key name
          states { nodes { id name type position } }
          labels(first: 250) { nodes { id name } }
        }
      }
    }`,
    { key },
    options,
  );
  const node = data.teams.nodes[0];
  if (!node) throw new LinearError(`There's no Linear team with the key ${key}.`);
  const team: LinearTeam = {
    id: node.id,
    key: node.key,
    name: node.name,
    states: node.states.nodes
      .slice()
      .sort((left, right) => left.position - right.position)
      .map((state) => ({ id: state.id, name: state.name, type: state.type })),
    labels: node.labels.nodes,
  };
  if (!options.fetchImpl) teamCache = { key, at: Date.now(), team };
  return team;
}

export async function searchLinearIssues(
  input: { query?: string | null; includeDone?: boolean; limit?: number },
  options: LinearOptions = {},
): Promise<LinearIssue[]> {
  const key = options.teamKey ?? linearTeamKey();
  const filter: Record<string, unknown> = { team: { key: { eq: key } } };
  const text = input.query?.trim();
  if (text) {
    const number = new RegExp(`^${key}-(\\d+)$`, "i").exec(text);
    if (number) filter.number = { eq: Number(number[1]) };
    else filter.or = [{ title: { containsIgnoreCase: text } }, { description: { containsIgnoreCase: text } }];
  }
  if (!input.includeDone) filter.state = { type: { nin: ["completed", "canceled"] } };
  const data = await linearRequest<{ issues: { nodes: IssueNode[] } }>(
    `query Issues($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first, orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } }
    }`,
    { filter, first: Math.min(Math.max(input.limit ?? 20, 1), 50) },
    options,
  );
  return data.issues.nodes.map(mapIssue);
}

export async function getLinearIssue(id: string, options: LinearOptions = {}): Promise<LinearIssueDetail> {
  const data = await linearRequest<{
    issue: (IssueNode & { description: string | null; comments: { nodes: { body: string; createdAt: string; user: { name: string } | null }[] } }) | null;
  }>(
    `query Issue($id: String!) {
      issue(id: $id) {
        ${ISSUE_FIELDS}
        description
        comments(first: 30) { nodes { body createdAt user { name } } }
      }
    }`,
    { id: id.trim() },
    options,
  );
  if (!data.issue) throw new LinearError(`Couldn't find ${id} in Linear.`);
  return {
    ...mapIssue(data.issue),
    description: data.issue.description,
    comments: data.issue.comments.nodes
      .map((comment) => ({ author: comment.user?.name ?? null, body: comment.body, createdAt: comment.createdAt }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}

function findState(team: LinearTeam, name: string | null | undefined) {
  if (!name?.trim()) return undefined;
  const wanted = name.trim().toLowerCase();
  const state = team.states.find((item) => item.name.toLowerCase() === wanted);
  if (!state) {
    throw new LinearError(`${team.name} has no status called ${name}. Use one of: ${team.states.map((item) => item.name).join(", ")}.`);
  }
  return state.id;
}

function findLabels(team: LinearTeam, names: string[] | undefined) {
  if (!names?.length) return undefined;
  const missing: string[] = [];
  const ids: string[] = [];
  for (const name of names) {
    const label = team.labels.find((item) => item.name.toLowerCase() === name.trim().toLowerCase());
    if (label) ids.push(label.id);
    else missing.push(name);
  }
  if (missing.length) throw new LinearError(`${team.name} has no label called ${missing.join(", ")}.`);
  return ids;
}

function priorityValue(priority: string | null | undefined) {
  if (!priority) return undefined;
  const value = PRIORITY_VALUE[priority.toLowerCase() as LinearPriority];
  if (value === undefined) throw new LinearError("Priority is urgent, high, medium or low.");
  return value;
}

export async function createLinearIssue(
  input: { title: string; description?: string | null; priority?: string | null; status?: string | null; labels?: string[]; assignToMe?: boolean },
  options: LinearOptions = {},
): Promise<LinearIssue> {
  const title = input.title.replace(/\s+/g, " ").trim().slice(0, 250);
  if (!title) throw new LinearError("Give the issue a title.");
  const team = await getLinearTeam(options);
  const issueInput: Record<string, unknown> = { teamId: team.id, title };
  const description = input.description?.trim();
  if (description) issueInput.description = description.slice(0, 50_000);
  const priority = priorityValue(input.priority);
  if (priority !== undefined) issueInput.priority = priority;
  const stateId = findState(team, input.status);
  if (stateId) issueInput.stateId = stateId;
  const labelIds = findLabels(team, input.labels);
  if (labelIds) issueInput.labelIds = labelIds;
  if (input.assignToMe) {
    const viewer = await linearRequest<{ viewer: { id: string } }>("query { viewer { id } }", {}, options);
    issueInput.assigneeId = viewer.viewer.id;
  }
  const data = await linearRequest<{ issueCreate: { success: boolean; issue: IssueNode | null } }>(
    `mutation Create($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    { input: issueInput },
    options,
  );
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new LinearError("Linear didn't create the issue.");
  return mapIssue(data.issueCreate.issue);
}

export async function updateLinearIssue(
  id: string,
  input: { title?: string | null; status?: string | null; priority?: string | null },
  options: LinearOptions = {},
): Promise<LinearIssue> {
  const team = await getLinearTeam(options);
  const issueInput: Record<string, unknown> = {};
  const title = input.title?.replace(/\s+/g, " ").trim();
  if (title) issueInput.title = title.slice(0, 250);
  const stateId = findState(team, input.status);
  if (stateId) issueInput.stateId = stateId;
  const priority = priorityValue(input.priority);
  if (priority !== undefined) issueInput.priority = priority;
  if (Object.keys(issueInput).length === 0) throw new LinearError("Say what to change: title, status or priority.");
  const data = await linearRequest<{ issueUpdate: { success: boolean; issue: IssueNode | null } }>(
    `mutation Update($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
    }`,
    { id: id.trim(), input: issueInput },
    options,
  );
  if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new LinearError("Linear didn't update the issue.");
  return mapIssue(data.issueUpdate.issue);
}

export async function commentOnLinearIssue(id: string, body: string, options: LinearOptions = {}) {
  const text = body.trim();
  if (!text) throw new LinearError("Write the comment first.");
  const issue = await getLinearIssue(id, options);
  const data = await linearRequest<{ commentCreate: { success: boolean; comment: { id: string; url: string } | null } }>(
    `mutation Comment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id url } }
    }`,
    { input: { issueId: issue.id, body: text.slice(0, 50_000) } },
    options,
  );
  if (!data.commentCreate.success || !data.commentCreate.comment) throw new LinearError("Linear didn't add the comment.");
  return { issue: issue.identifier, url: data.commentCreate.comment.url };
}

export type LinearStatus = { configured: boolean; team: { key: string; name: string } | null; error: string | null };

export async function linearStatus(options: LinearOptions = {}): Promise<LinearStatus> {
  const apiKey = options.apiKey === undefined ? linearApiKey() : options.apiKey;
  if (!apiKey) return { configured: false, team: null, error: null };
  try {
    const team = await getLinearTeam(options);
    return { configured: true, team: { key: team.key, name: team.name }, error: null };
  } catch (error) {
    return { configured: true, team: null, error: error instanceof Error ? error.message : "Couldn't reach Linear." };
  }
}
