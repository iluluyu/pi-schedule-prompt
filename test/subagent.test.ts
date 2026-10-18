import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSession,
  describeAvailableModels,
  getLastAssistantText,
  promptSubagentSession,
  resolveModel,
  runSubagentOnce,
} from "../src/subagent.js";

// Mock the pi-coding-agent module for runSubagentOnce tests
// Must be at file scope — vitest hoists vi.mock to the top automatically.
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: vi.fn(),
  // Instantiated via `new DefaultResourceLoader(...)`, so the mock must be a
  // constructable function expression — an arrow function can't be `new`-ed.
  // biome-ignore lint/complexity/useArrowFunction: used as a constructor mock
  DefaultResourceLoader: vi.fn(function () {
    return { reload: vi.fn().mockResolvedValue(undefined) };
  }),
  getAgentDir: vi.fn(() => "/tmp/agent-dir"),
  SessionManager: { inMemory: vi.fn(() => ({ getSessionId: () => "test" })) },
  SettingsManager: { create: vi.fn(() => ({})) },
}));

import { createAgentSession, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

const mockCreateAgentSession = vi.mocked(createAgentSession);
const mockDefaultResourceLoader = vi.mocked(DefaultResourceLoader);

// Mirror of the minimal Model shape resolveModel actually touches: provider, id, name.
const MODELS = [
  { id: "claude-opus-4-6", name: "Claude Opus 4.6", provider: "anthropic" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

function makeRegistry(available = MODELS) {
  return {
    find: (provider: string, id: string) =>
      MODELS.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => available,
  } as any;
}

describe("resolveModel", () => {
  it("matches exact provider/id", () => {
    expect(resolveModel(makeRegistry(), "anthropic/claude-opus-4-6")).toEqual(MODELS[0]);
  });

  it("falls through to fuzzy when provider/id is not exact", () => {
    // 'anthropic/haiku' is not a real id; the slash branch fails registry.find,
    // then fuzzy match scans the full string against id/name and still picks haiku.
    expect(resolveModel(makeRegistry(), "anthropic/haiku")).toEqual(MODELS[2]);
  });

  it("matches exact id without provider prefix", () => {
    expect(resolveModel(makeRegistry(), "gpt-4o")).toEqual(MODELS[3]);
  });

  it("resolves current/same aliases to the active model", () => {
    expect(resolveModel(makeRegistry(), "current", MODELS[1])).toEqual(MODELS[1]);
    expect(resolveModel(makeRegistry(), "same", MODELS[1])).toEqual(MODELS[1]);
  });

  it("resolves fast to a lightweight sibling from the active provider", () => {
    expect(resolveModel(makeRegistry(), "fast", MODELS[1])).toEqual(MODELS[2]);
  });

  it("is case-insensitive on exact id", () => {
    expect(resolveModel(makeRegistry(), "GPT-4o")).toEqual(MODELS[3]);
  });

  it("matches via id substring", () => {
    expect(resolveModel(makeRegistry(), "haiku")).toEqual(MODELS[2]);
    expect(resolveModel(makeRegistry(), "sonnet")).toEqual(MODELS[1]);
  });

  it("matches via name substring when id substring misses", () => {
    // 'Gemini' appears in the model name but not in the id.
    expect(resolveModel(makeRegistry(), "Gemini")).toEqual(MODELS[4]);
  });

  it("returns undefined for unknown model", () => {
    expect(resolveModel(makeRegistry(), "definitely-not-a-real-model")).toBeUndefined();
  });

  it("returns undefined when registry is empty", () => {
    expect(resolveModel(makeRegistry([]), "haiku")).toBeUndefined();
  });

  it("only resolves against models with configured auth (getAvailable)", () => {
    // Auth only configured for opus — even though sonnet is in MODELS, it isn't
    // returned by getAvailable() so fuzzy can't reach it.
    const registry = makeRegistry([MODELS[0]]);
    expect(resolveModel(registry, "sonnet")).toBeUndefined();
  });
});

describe("describeAvailableModels", () => {
  it("returns explanatory text when registry is empty", () => {
    expect(describeAvailableModels(makeRegistry([]))).toBe(
      "No models with configured auth.",
    );
  });

  it("lists up to 5 models as provider/id pairs", () => {
    const text = describeAvailableModels(makeRegistry());
    expect(text).toMatch(/^Available: /);
    expect(text).toContain("anthropic/claude-opus-4-6");
    expect(text).toContain("openai/gpt-4o");
  });

  it("appends a '… (N more)' suffix when more than 5 models exist", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `m${i}`,
      name: `Model ${i}`,
      provider: "p",
    }));
    const text = describeAvailableModels(makeRegistry(many));
    // First 5 listed, 3 more elided
    expect(text).toContain("p/m0");
    expect(text).toContain("p/m4");
    expect(text).not.toContain("p/m5");
    expect(text).toContain("(3 more)");
  });

  it("does not append the 'more' suffix when count is exactly 5", () => {
    const exactly5 = MODELS.slice(0, 5);
    const text = describeAvailableModels(makeRegistry(exactly5));
    expect(text).not.toContain("more");
  });
});

describe("getLastAssistantText", () => {
  // session.messages is the only field we use — the rest of AgentSession is irrelevant.
  function fakeSession(messages: any[]) {
    return { messages } as any;
  }

  it("returns empty string when there are no messages", () => {
    expect(getLastAssistantText(fakeSession([]))).toBe("");
  });

  it("returns empty string when no assistant message exists", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "user", content: "hi" },
          { role: "toolResult", content: [{ type: "text", text: "ok" }] },
        ]),
      ),
    ).toBe("");
  });

  it("extracts text from a string-content assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([{ role: "assistant", content: "hello world" }]),
      ),
    ).toBe("hello world");
  });

  it("concatenates text parts from an array-content assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          {
            role: "assistant",
            content: [
              { type: "text", text: "part one " },
              { type: "toolCall", name: "bash" },
              { type: "text", text: "part two" },
            ],
          },
        ]),
      ),
    ).toBe("part one part two");
  });

  it("walks backward and returns the most recent assistant message", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "assistant", content: "first" },
          { role: "user", content: "follow up" },
          { role: "assistant", content: "second" },
        ]),
      ),
    ).toBe("second");
  });

  it("skips assistant messages that contain only tool calls (no text)", () => {
    expect(
      getLastAssistantText(
        fakeSession([
          { role: "assistant", content: "real text" },
          {
            role: "assistant",
            content: [{ type: "toolCall", name: "bash" }],
          },
        ]),
      ),
    ).toBe("real text");
  });
});

// Minimal fake AgentSession shared by the runSubagentOnce / createSubagentSession /
// promptSubagentSession tests — only the fields the code under test touches.
function makeFakeSession() {
  return {
    abort: vi.fn(),
    subscribe: vi.fn(() => vi.fn()),
    prompt: vi.fn().mockResolvedValue(undefined),
    messages: [] as any[],
    bindExtensions: vi.fn(),
  };
}

function makeCtx() {
  return {
    cwd: "/tmp",
    modelRegistry: {
      find: () => MODELS[0],
      getAvailable: () => MODELS,
    },
    sessionManager: {
      getSessionId: () => "test",
    },
  } as any;
}

describe("runSubagentOnce", () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockDefaultResourceLoader.mockReset();
  });

  it("default: creates subagent with noExtensions=true, noSkills=true, tools=DEFAULT_TOOL_NAMES, no bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id);

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: true, noSkills: true
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.noSkills).toBe(true);

    // Check createAgentSession was called with tools: DEFAULT_TOOL_NAMES
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);

    // bindExtensions should NOT have been called
    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("extensions:true: sets noExtensions=false, noSkills=true, tools=undefined, calls bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      extensions: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: false, noSkills: true
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(false);
    expect(loaderOptions.noSkills).toBe(true);

    // Check createAgentSession was called with tools: undefined
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();

    // bindExtensions should have been called
    expect(fakeSession.bindExtensions).toHaveBeenCalledTimes(1);
  });

  it("skills:true: sets noExtensions=true, noSkills=false, tools=DEFAULT_TOOL_NAMES, no bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      skills: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: true, noSkills: false
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.noSkills).toBe(false);

    // Check createAgentSession was called with tools: DEFAULT_TOOL_NAMES
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);

    // bindExtensions should NOT have been called
    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("extensions:true + skills:true: sets noExtensions=false, noSkills=false, tools=undefined, calls bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      extensions: true,
      skills: true,
    });

    expect(result.ok).toBe(true);

    // Check DefaultResourceLoader was created with noExtensions: false, noSkills: false
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(false);
    expect(loaderOptions.noSkills).toBe(false);

    // Check createAgentSession was called with tools: undefined
    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();

    // bindExtensions should have been called
    expect(fakeSession.bindExtensions).toHaveBeenCalledTimes(1);
  });

  it("extensions:[\"pkg\"]: filters extensions, sets noExtensions=false, tools=undefined, calls bindExtensions", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });


    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      extensions: ["telegram"],
    });

    expect(result.ok).toBe(true);

    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(false);
    expect(typeof loaderOptions.extensionsOverride).toBe("function");

    // The override keeps only extensions whose path matches a requested name
    // (substring match against the extension path).
    const filtered = loaderOptions.extensionsOverride({
      extensions: [{ path: "npm:pi-telegram" }, { path: "npm:pi-mcp-adapter" }],
    });
    expect(filtered.extensions.map((e: { path: string }) => e.path)).toEqual(["npm:pi-telegram"]);

    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toBeUndefined();

    expect(fakeSession.bindExtensions).toHaveBeenCalledTimes(1);
  });

  it("skills:[\"git\"]: filters skills, sets noSkills=false", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });


    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      skills: ["git"],
    });

    expect(result.ok).toBe(true);

    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noSkills).toBe(false);
    expect(typeof loaderOptions.skillsOverride).toBe("function");

    // The override keeps only exactly-named skills — "git" must not match "github".
    const filtered = loaderOptions.skillsOverride({
      skills: [{ name: "git" }, { name: "github" }, { name: "docs" }],
    });
    expect(filtered.skills.map((s: { name: string }) => s.name)).toEqual(["git"]);

    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("skills:[]: empty array means none — same as unset", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      skills: [],
    });

    expect(result.ok).toBe(true);

    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noSkills).toBe(true);
    expect(loaderOptions.skillsOverride).toBeUndefined();

    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });

  it("extensions:[]: empty array means none — same as unset", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await runSubagentOnce(makeCtx(), "test prompt", MODELS[0].id, undefined, {
      extensions: [],
    });

    expect(result.ok).toBe(true);

    // An empty array must not widen the toolset or load extensions.
    const loaderOptions = mockDefaultResourceLoader.mock.calls[0][0];
    expect(loaderOptions.noExtensions).toBe(true);
    expect(loaderOptions.extensionsOverride).toBeUndefined();

    const sessionOptions = mockCreateAgentSession.mock.calls[0][0];
    expect(sessionOptions.tools).toEqual(["bash", "read", "edit", "write", "grep", "find", "ls"]);

    expect(fakeSession.bindExtensions).not.toHaveBeenCalled();
  });
});

describe("createSubagentSession", () => {
  beforeEach(() => {
    mockCreateAgentSession.mockReset();
    mockDefaultResourceLoader.mockReset();
  });

  it("unknown model: returns ok:false with the Unknown-model error and never creates a session", async () => {
    const result = await createSubagentSession(
      makeCtx(),
      "definitely-not-a-real-model",
      undefined,
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return; // narrow for TS
    expect(result.error).toContain("Unknown model 'definitely-not-a-real-model'");
    expect(result.error).toContain("Available:");
    // Failed resolution must short-circuit before any session machinery runs.
    expect(mockDefaultResourceLoader).not.toHaveBeenCalled();
    expect(mockCreateAgentSession).not.toHaveBeenCalled();
  });

  it("success: returns a handle with the live session, resolved model, modelRef and requestedModel", async () => {
    const fakeSession = makeFakeSession();
    mockCreateAgentSession.mockResolvedValue({ session: fakeSession });

    const result = await createSubagentSession(makeCtx(), MODELS[0].id, undefined, {});

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.handle.session).toBe(fakeSession);
    expect(result.handle.model).toEqual(MODELS[0]);
    expect(result.handle.modelRef).toBe("anthropic/claude-opus-4-6");
    expect(result.handle.requestedModel).toBe(MODELS[0].id);
    // The resolved model is what the session is created with.
    expect(mockCreateAgentSession.mock.calls[0][0].model).toEqual(MODELS[0]);
  });

  it("prompt errors bubble as ok:false with the error message", async () => {
    // createAgentSession rejection must surface as an error string, not throw.
    mockCreateAgentSession.mockRejectedValue(new Error("boom"));

    const result = await createSubagentSession(makeCtx(), MODELS[0].id, undefined, {});

    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

describe("promptSubagentSession", () => {
  // Fake session whose subscribe handler is captured so a test can stream
  // events into it, plus a stale assistant message in history — if the
  // implementation wrongly fell back to getLastAssistantText, that stale
  // text would leak into the result.
  function makeStreamSession(staleText = "stale answer from a previous beat") {
    let handler: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const session = {
      abort: vi.fn(),
      subscribe: vi.fn((h: (event: any) => void) => {
        handler = h;
        return unsubscribe;
      }),
      prompt: vi.fn().mockResolvedValue(undefined),
      messages: [{ role: "assistant", content: staleText }],
      bindExtensions: vi.fn(),
    };
    return {
      session,
      unsubscribe,
      emit: (event: any) => handler?.(event),
    };
  }

  it("empty reply: returns {ok:true, text:''} — never falls back to stale session history", async () => {
    const { session, unsubscribe } = makeStreamSession();

    const result = await promptSubagentSession(session as any, "beat");

    expect(result).toEqual({ ok: true, text: "" });
    expect(session.prompt).toHaveBeenCalledWith("beat");
    // Request-scoped subscription is torn down after the prompt resolves.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("streams only this invocation's deltas: a later empty beat returns empty text, not the previous beat's answer", async () => {
    const { session, emit } = makeStreamSession();

    // Beat 1: the model streams text deltas during session.prompt.
    session.prompt.mockImplementation(async () => {
      emit({ type: "message_start" });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "beat one " } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
    });
    const first = await promptSubagentSession(session as any, "beat 1");
    expect(first).toEqual({ ok: true, text: "beat one answer" });

    // Beat 2 on the same resident session: nothing streams → empty text.
    session.prompt.mockResolvedValue(undefined);
    const second = await promptSubagentSession(session as any, "beat 2");
    expect(second).toEqual({ ok: true, text: "" });
  });

  it("aborts the session immediately when the signal is already aborted", async () => {
    const { session } = makeStreamSession();
    const controller = new AbortController();
    controller.abort();

    await promptSubagentSession(session as any, "beat", controller.signal);

    expect(session.abort).toHaveBeenCalledTimes(1);
  });
});
