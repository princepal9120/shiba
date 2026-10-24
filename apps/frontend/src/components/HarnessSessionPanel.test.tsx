// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessSessionPanel } from "./HarnessSessionPanel";

const board = {
  runs: [
    {
      sandboxId: "sb-1",
      events: [{ seq: 1, type: "message.completed", text: "adding a greeting" }],
      diff: "diff --git a/greeting.txt b/greeting.txt\n+hello\n",
      approvals: [
        { requestId: "r1", kind: "file_change", title: "Write greeting.txt", detail: "hello" },
      ],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("HarnessSessionPanel", () => {
  it("stays quiet until it is enabled", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const view = render(<HarnessSessionPanel />);
    expect(view.container.textContent).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the stream, the diff, and posts an allow", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/computers/harness" && init === undefined) {
        return { ok: true, status: 200, json: async () => board };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<HarnessSessionPanel enabled />);
    expect(await screen.findByText("adding a greeting")).toBeTruthy();
    expect(screen.getByTestId("harness-diff").textContent).toContain("greeting.txt");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/computers/harness/decide",
      expect.objectContaining({ method: "POST" }),
    );
    const decide = fetchMock.mock.calls.find((call) => call[0] === "/api/computers/harness/decide");
    expect(String(decide?.[1]?.body)).toContain('"decision":"allow"');
    fireEvent.click(screen.getByRole("button", { name: "Interrupt" }));
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/computers/harness/control")).toBe(
      true,
    );
  });

  it("renders nothing when the local runtime is off", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );
    const view = render(<HarnessSessionPanel enabled />);
    await vi.waitFor(() => expect(view.container.textContent).toBe(""));
  });
});
