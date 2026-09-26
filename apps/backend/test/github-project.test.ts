import { describe, expect, it } from "vitest";
import {
  addPullToProject,
  pullRequestNodeId,
  resolveProject,
  setItemStatus,
  statusField,
} from "../src/github-project.js";

function fakeFetch(handler: (body: { query: string; variables: Record<string, unknown> }) => unknown) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return new Response(JSON.stringify({ data: handler(body) }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("github-project", () => {
  it("resolveProject returns the board id for an owner + number", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({
      repositoryOwner: { projectV2: { id: "PVT_1", number: 3, title: "Shiba board" } },
    }));
    const project = await resolveProject("princepal9120", 3, "tok", { fetchImpl });
    expect(project).toEqual({ projectId: "PVT_1", projectNumber: 3, title: "Shiba board" });
    expect(calls[0]!.variables).toEqual({ owner: "princepal9120", number: 3 });
  });

  it("resolveProject throws a clear error when the board is absent", async () => {
    const { fetchImpl } = fakeFetch(() => ({ repositoryOwner: { projectV2: null } }));
    await expect(resolveProject("princepal9120", 9, "tok", { fetchImpl })).rejects.toThrow(/not found/);
  });

  it("resolveProject refuses to run without a token", async () => {
    await expect(resolveProject("o", 1, "")).rejects.toThrow(/GITHUB_PROJECT_TOKEN/);
  });

  it("pullRequestNodeId parses https repo urls and returns the node id", async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ repository: { pullRequest: { id: "PR_node" } } }));
    const id = await pullRequestNodeId("https://github.com/princepal9120/shiba", 17, "tok", { fetchImpl });
    expect(id).toBe("PR_node");
    expect(calls[0]!.variables).toMatchObject({ owner: "princepal9120", repo: "shiba", number: 17 });
  });

  it("pullRequestNodeId rejects non-github urls", async () => {
    await expect(pullRequestNodeId("https://evil.example/x/y", 1, "tok")).rejects.toThrow();
  });

  it("addPullToProject returns the created item id", async () => {
    const { fetchImpl } = fakeFetch(() => ({ addProjectV2ItemById: { item: { id: "ITEM_1" } } }));
    await expect(addPullToProject("PVT_1", "PR_node", "tok", { fetchImpl })).resolves.toBe("ITEM_1");
  });

  it("setItemStatus writes the named single-select option", async () => {
    const { fetchImpl, calls } = fakeFetch((body) =>
      body.query.includes("field(name:")
        ? { node: { field: { id: "F_status", name: "Status", options: [{ id: "O_done", name: "Done" }] } } }
        : { updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_1" } } },
    );
    await expect(setItemStatus("PVT_1", "ITEM_1", "Done", "tok", { fetchImpl })).resolves.toBe(true);
    expect(calls[1]!.variables).toMatchObject({ item: "ITEM_1", field: "F_status", option: "O_done" });
  });

  it("setItemStatus is a no-op when the column does not exist", async () => {
    const { fetchImpl } = fakeFetch(() => ({
      node: { field: { id: "F_status", name: "Status", options: [{ id: "O_todo", name: "Todo" }] } },
    }));
    await expect(setItemStatus("PVT_1", "ITEM_1", "Done", "tok", { fetchImpl })).resolves.toBe(false);
  });

  it("surfaces GraphQL errors with redaction, not raw bodies", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "bad token gho_secret" }] }), { status: 200 })) as typeof fetch;
    await expect(resolveProject("o", 1, "tok", { fetchImpl })).rejects.toThrow(/GraphQL errors/);
  });
});
