// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TaskComposer, type TaskComposerProps } from "./TaskComposer";

afterEach(() => cleanup());

const routing = {
  codingModel: "",
  connectionId: "",
  reasoningEffort: "" as const,
  onCodingModelChange: vi.fn(),
  onConnectionChange: vi.fn(),
  onReasoningEffortChange: vi.fn(),
};

function renderComposer(variant: "hero" | "docked", overrides?: Partial<TaskComposerProps>) {
  render(
    <TaskComposer
      repoUrl=""
      task=""
      baseBranch="main"
      publishPullRequest={false}
      harness="opencode"
      routing={routing}
      busy={false}
      isSubmitting={false}
      clearing={false}
      onRepoUrlChange={vi.fn()}
      onTaskChange={vi.fn()}
      onBaseBranchChange={vi.fn()}
      onPublishPullRequestChange={vi.fn()}
      onHarnessChange={vi.fn()}
      onSubmit={vi.fn()}
      onClear={vi.fn()}
      variant={variant}
      {...overrides}
    />,
  );
}

describe("TaskComposer", () => {
  it("states the empty-thread prompt and keeps send disabled until there is a task", () => {
    renderComposer("hero");
    expect(screen.getByRole("heading", { name: "What should Shiba change?" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Task description" }).getAttribute("placeholder")).toBe(
      "Describe the change in this repository",
    );
    expect(screen.getByRole("button", { name: "Send task" }).hasAttribute("disabled")).toBe(true);
  });

  it("docks without the empty-thread heading once a run is going", () => {
    renderComposer("docked");
    expect(screen.queryByRole("heading", { name: "What should Shiba change?" })).toBeNull();
  });

  it("renders the effort chip for claude-code and lists options on open", () => {
    renderComposer("docked", { harness: "claude-code" });
    const chip = screen.getByRole("button", { name: "Reasoning effort: default" });
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("Effort");
    fireEvent.click(chip);
    for (const label of ["Default", "Low", "Medium", "High", "Xhigh", "Max"]) {
      expect(screen.getByRole("menuitemradio", { name: label })).toBeTruthy();
    }
  });

  it("does not render the effort chip for an unsupported harness like devin", () => {
    renderComposer("docked", { harness: "devin" });
    expect(screen.queryByRole("button", { name: /reasoning effort/i })).toBeNull();
  });

  it("calls onReasoningEffortChange with high when High is clicked", () => {
    const onReasoningEffortChange = vi.fn();
    renderComposer("docked", {
      harness: "claude-code",
      routing: {
        ...routing,
        onReasoningEffortChange,
      },
    });
    const chip = screen.getByRole("button", { name: "Reasoning effort: default" });
    fireEvent.click(chip);
    const highOption = screen.getByRole("menuitemradio", { name: "High" });
    fireEvent.click(highOption);
    expect(onReasoningEffortChange).toHaveBeenCalledWith("high");
  });

  it("opens Environment variables from the + menu and handles adding a variable", () => {
    const onEnvVarsChange = vi.fn();
    renderComposer("docked", { onEnvVarsChange });
    const addBtn = screen.getByRole("button", { name: "Add to message" });
    fireEvent.click(addBtn);
    const envMenuItem = screen.getByRole("menuitem", { name: "Environment variables" });
    fireEvent.click(envMenuItem);

    const nameInput = screen.getByPlaceholderText("NAME");
    const valInput = screen.getByPlaceholderText("value");
    expect(valInput.getAttribute("type")).toBe("password");
    expect(valInput.getAttribute("autocomplete")).toBe("off");

    fireEvent.change(nameInput, { target: { value: "API_KEY" } });
    fireEvent.change(valInput, { target: { value: "secret123" } });

    const addVarBtn = screen.getByRole("button", { name: "Add variable" });
    fireEvent.click(addVarBtn);

    expect(onEnvVarsChange).toHaveBeenCalledWith([{ name: "API_KEY", value: "secret123" }]);
  });

  it("shows count chip when named env vars exist and clicking it opens the editor", () => {
    const onEnvVarsChange = vi.fn();
    renderComposer("docked", {
      envVars: [{ name: "DATABASE_URL", value: "secret" }],
      onEnvVarsChange,
    });
    const chip = screen.getByRole("button", { name: "1 environment variable attached" });
    expect(chip.textContent).toContain("ENV ×1");
    fireEvent.click(chip);

    const removeBtn = screen.getByRole("button", { name: "Remove DATABASE_URL" });
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn);
    expect(onEnvVarsChange).toHaveBeenCalledWith([]);
  });

  it("opening Thread configuration shows the Run repo setup checkbox, and toggling it calls onRunSetupChange(true)", () => {
    const onRunSetupChange = vi.fn();
    renderComposer("docked", { onRunSetupChange });
    const configBtn = screen.getByRole("button", { name: "Thread configuration" });
    fireEvent.click(configBtn);

    const setupCheckbox = screen.getByRole("menuitemcheckbox", { name: "Run repo setup" });
    expect(setupCheckbox).toBeTruthy();
    expect(setupCheckbox.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Runs .shiba/setup.json initialize before the agent")).toBeTruthy();

    fireEvent.click(setupCheckbox);
    expect(onRunSetupChange).toHaveBeenCalledWith(true);
  });

  describe("voice dictation", () => {
    it("renders no button when unsupported", () => {
      renderComposer("docked");
      expect(screen.queryByRole("button", { name: /voice input/i })).toBeNull();
    });

    it("with a fake SpeechRecognition class on window, clicking starts it and flips aria-pressed", () => {
      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onerror = null;
        onend = null;
        start = vi.fn();
        stop = vi.fn();
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      try {
        renderComposer("docked");
        const btn = screen.getByRole("button", { name: "Voice input" });
        expect(btn.getAttribute("aria-pressed")).toBe("false");
        fireEvent.click(btn);
        expect(btn.getAttribute("aria-pressed")).toBe("true");
        expect(btn.getAttribute("aria-label")).toBe("Stop voice input");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });

    it("a fired result event calls onTaskChange with the appended text", () => {
      interface SpeechResultItem {
        transcript: string;
      }
      interface SpeechResult {
        isFinal?: boolean;
        length: number;
        0: SpeechResultItem;
      }
      interface SpeechEvent {
        resultIndex: number;
        results: SpeechResult[];
      }
      let instance: {
        onresult: ((event: SpeechEvent) => void) | null;
        start: () => void;
        stop: () => void;
      } | null = null;

      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult: ((event: SpeechEvent) => void) | null = null;
        onerror = null;
        onend = null;
        start = vi.fn();
        stop = vi.fn();
        constructor() {
          instance = this;
        }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      const onTaskChange = vi.fn();
      try {
        renderComposer("docked", { task: "initial task", onTaskChange });
        const btn = screen.getByRole("button", { name: "Voice input" });
        fireEvent.click(btn);
        expect(instance).toBeTruthy();
        if (instance) {
          (instance as { onresult: ((event: SpeechEvent) => void) | null }).onresult?.({
            resultIndex: 0,
            results: [{ isFinal: true, length: 1, 0: { transcript: "additional text" } }],
          });
        }
        expect(onTaskChange).toHaveBeenCalledWith("initial task additional text");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });

    it("clicking again stops it", () => {
      let instance: {
        stop: () => void;
        onend: (() => void) | null;
      } | null = null;

      class FakeSpeechRecognition {
        continuous = false;
        interimResults = false;
        lang = "";
        onresult = null;
        onerror = null;
        onend: (() => void) | null = null;
        start = vi.fn();
        stop = vi.fn(() => {
          this.onend?.();
        });
        constructor() {
          instance = this;
        }
      }
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeSpeechRecognition;
      try {
        renderComposer("docked");
        const btn = screen.getByRole("button", { name: "Voice input" });
        fireEvent.click(btn);
        expect(btn.getAttribute("aria-pressed")).toBe("true");

        fireEvent.click(btn);
        expect(instance).toBeTruthy();
        if (instance) {
          expect((instance as { stop: () => void }).stop).toHaveBeenCalled();
        }
        expect(btn.getAttribute("aria-pressed")).toBe("false");
        expect(btn.getAttribute("aria-label")).toBe("Voice input");
      } finally {
        delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
      }
    });
  });
});
