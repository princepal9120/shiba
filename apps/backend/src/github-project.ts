/**
 * GitHub Projects v2 board sync over the GraphQL API — same fetch-only,
 * secret-in-header, redacted-error conventions as github.ts. A classic PAT
 * or fine-grained token with the `project` scope travels in one
 * Authorization header and never enters the container or logs.
 */
import { parseGitHubRepoUrl, redactSecrets } from "./security.js";

const GRAPHQL_URL = "https://api.github.com/graphql";
const USER_AGENT = "shiba-ai-coworker";
const API_TIMEOUT_MS = 30_000;

export interface ProjectDeps {
  fetchImpl?: typeof fetch;
  graphqlUrl?: string;
}

interface GraphqlResult<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  deps: Required<ProjectDeps>,
): Promise<T> {
  const response = await deps.fetchImpl(deps.graphqlUrl, {
    method: "POST",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub GraphQL failed with status ${response.status}: ${redactSecrets(text.slice(0, 500))}`);
  }
  const result = JSON.parse(text) as GraphqlResult<T>;
  if (result.errors?.length) {
    const message = result.errors.map((e) => e.message ?? "unknown").join("; ");
    throw new Error(`GitHub GraphQL errors: ${redactSecrets(message.slice(0, 500))}`);
  }
  return result.data as T;
}

function resolve(deps: ProjectDeps): Required<ProjectDeps> {
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    graphqlUrl: deps.graphqlUrl ?? GRAPHQL_URL,
  };
}

export interface ProjectRef {
  projectId: string;
  projectNumber: number;
  title: string;
}

/** Resolve a Projects v2 board by owner login + project number. */
export async function resolveProject(
  owner: string,
  projectNumber: number,
  token: string,
  deps: ProjectDeps = {},
): Promise<ProjectRef> {
  if (!token) {
    throw new Error("Projects sync requires a GITHUB_PROJECT_TOKEN secret (project scope).");
  }
  const d = resolve(deps);
  const data = await gql<{ repositoryOwner?: { projectV2?: { id: string; number: number; title: string } | null } }>(
    token,
    `query($owner: String!, $number: Int!) {
      repositoryOwner(login: $owner) {
        projectV2(number: $number) { id number title }
      }
    }`,
    { owner, number: projectNumber },
    d,
  );
  const project = data.repositoryOwner?.projectV2;
  if (!project) {
    throw new Error(`Project #${projectNumber} not found for ${owner} (check it is a Projects v2 board, not classic).`);
  }
  return { projectId: project.id, projectNumber: project.number, title: project.title };
}

/** Node id of a pull request — Projects items point at node ids, not numbers. */
export async function pullRequestNodeId(
  repoUrl: string,
  pullNumber: number,
  token: string,
  deps: ProjectDeps = {},
): Promise<string> {
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  const d = resolve(deps);
  const data = await gql<{ repository?: { pullRequest?: { id: string } | null } }>(
    token,
    `query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { id }
      }
    }`,
    { owner, repo, number: pullNumber },
    d,
  );
  const id = data.repository?.pullRequest?.id;
  if (!id) {
    throw new Error(`Pull request #${pullNumber} not found in ${owner}/${repo}.`);
  }
  return id;
}

/** Add a pull request to a board. Returns the new project item id. */
export async function addPullToProject(
  projectId: string,
  pullNodeId: string,
  token: string,
  deps: ProjectDeps = {},
): Promise<string> {
  const d = resolve(deps);
  const data = await gql<{ addProjectV2ItemById?: { item?: { id: string } } }>(
    token,
    `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) {
        item { id }
      }
    }`,
    { project: projectId, content: pullNodeId },
    d,
  );
  const id = data.addProjectV2ItemById?.item?.id;
  if (!id) {
    throw new Error("GitHub did not return a project item id after addProjectV2ItemById.");
  }
  return id;
}

export interface StatusField {
  fieldId: string;
  options: Record<string, string>;
}

/** Read the board's Status single-select field: field id + option name → option id. */
export async function statusField(
  projectId: string,
  token: string,
  deps: ProjectDeps = {},
): Promise<StatusField | null> {
  const d = resolve(deps);
  const data = await gql<{
    node?: {
      field?: { id: string; name: string; options?: Array<{ id: string; name: string }> } | null;
    };
  }>(
    token,
    `query($project: ID!) {
      node(id: $project) {
        ... on ProjectV2 {
          field(name: "Status") {
            ... on ProjectV2SingleSelectField { id name options { id name } }
          }
        }
      }
    }`,
    { project: projectId },
    d,
  );
  const field = data.node?.field;
  if (!field?.options) {
    return null;
  }
  const options: Record<string, string> = {};
  for (const option of field.options) {
    options[option.name] = option.id;
  }
  return { fieldId: field.id, options };
}

/** Move a project item to a named Status column. No-op when the column is absent. */
export async function setItemStatus(
  projectId: string,
  itemId: string,
  status: string,
  token: string,
  deps: ProjectDeps = {},
): Promise<boolean> {
  const field = await statusField(projectId, token, deps);
  const optionId = field?.options[status];
  if (!field || !optionId) {
    return false;
  }
  const d = resolve(deps);
  await gql<unknown>(
    token,
    `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $project, itemId: $item, fieldId: $field,
        value: { singleSelectOptionId: $option }
      }) { projectV2Item { id } }
    }`,
    { project: projectId, item: itemId, field: field.fieldId, option: optionId },
    d,
  );
  return true;
}

