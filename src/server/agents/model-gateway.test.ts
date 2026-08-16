import { describe, it, expect, vi, afterEach } from "vitest";
import { complete, MAX_OUTPUT_TOKENS } from "./model-gateway";

// A configured (non-"off") provider so complete() actually attempts a network
// call — which we intercept with a stubbed fetch. No real request is made.
const CFG = { provider: "openai" as const, apiKey: "test-key", model: "glm-test" };

// The gateway's conservative retry ceiling (see RETRY_MAX_TOKENS in
// model-gateway.ts). Kept in sync here so the assertions read clearly.
const RETRY_MAX_TOKENS = 16384;

function res(ok: boolean, body: unknown, status = ok ? 200 : 400): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}
const okBody = (text: string) => ({ choices: [{ message: { content: text } }] });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("model gateway · 过大 max_tokens 降级重试", () => {
  it("首个请求(128K 上限)被供应商拒时，用保守上限重试成功，不回退离线", async () => {
    const seen: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { max_tokens: number };
      seen.push(body.max_tokens);
      // Emulate a provider that 400s on an over-large max_tokens.
      if (body.max_tokens > RETRY_MAX_TOKENS) return res(false, { error: "max_tokens too large" });
      return res(true, okBody("OK-RETRY"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const r = await complete({ messages: [{ role: "user", content: "hi" }] }, CFG);

    expect(r.provider).toBe("openai");
    expect(r.text).toBe("OK-RETRY");
    expect(seen[0]).toBe(MAX_OUTPUT_TOKENS); // first try: the 128K ceiling
    expect(seen[1]).toBe(RETRY_MAX_TOKENS); // retry: clamped
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("两次都失败才回退 deterministic（不因上限过大直接掉回离线复读）", async () => {
    const fetchMock = vi.fn(async () => res(false, { error: "nope" }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await complete({ messages: [{ role: "user", content: "hello world" }] }, CFG);

    expect(r.provider).toBe("deterministic");
    expect(r.text).toContain("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(2); // big, then clamped, then give up
  });

  it("显式传入的小 maxTokens 不触发重试（已在保守上限内）", async () => {
    const fetchMock = vi.fn(async () => res(false, { error: "nope" }));
    vi.stubGlobal("fetch", fetchMock);

    const r = await complete(
      { messages: [{ role: "user", content: "small" }], maxTokens: 512 },
      CFG,
    );

    expect(r.provider).toBe("deterministic");
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry when already small
  });

  it("成功时不重试，直接返回模型输出", async () => {
    const fetchMock = vi.fn(async () => res(true, okBody("FIRST-TRY")));
    vi.stubGlobal("fetch", fetchMock);

    const r = await complete({ messages: [{ role: "user", content: "hi" }] }, CFG);

    expect(r.provider).toBe("openai");
    expect(r.text).toBe("FIRST-TRY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("model gateway · 小模型分层 (mini tier)", () => {
  it("tier:'mini' 使用配置的 miniModel，tier:'main' 使用主模型", async () => {
    const models: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string };
      models.push(body.model);
      return res(true, okBody("OK"));
    });
    vi.stubGlobal("fetch", fetchMock);

    const cfg = { ...CFG, miniModel: "glm-mini" };
    const mini = await complete({ messages: [{ role: "user", content: "hi" }], tier: "mini" }, cfg);
    const main = await complete({ messages: [{ role: "user", content: "hi" }], tier: "main" }, cfg);

    expect(mini.model).toBe("glm-mini");
    expect(main.model).toBe("glm-test");
    expect(models).toEqual(["glm-mini", "glm-test"]);
  });

  it("未配置 miniModel 时 tier:'mini' 回退到 openai 默认小模型", async () => {
    const models: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      models.push((JSON.parse(init.body as string) as { model: string }).model);
      return res(true, okBody("OK"));
    });
    vi.stubGlobal("fetch", fetchMock);

    // No `model` set at all → main default is gpt-4o-mini, mini default likewise.
    const r = await complete(
      { messages: [{ role: "user", content: "hi" }], tier: "mini" },
      { provider: "openai", apiKey: "k" },
    );
    expect(r.model).toBe("gpt-4o-mini");
  });
});
