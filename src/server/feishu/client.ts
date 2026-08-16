/**
 * Feishu (Lark) open-platform client — credential-gated.
 *
 * Every integration is a graceful no-op without FEISHU_APP_ID/FEISHU_APP_SECRET,
 * preserving the project's hard invariant: offline deterministic operation.
 * Token caching avoids a tenant_access_token call per request.
 */
const TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const OPEN_API_BASE = "https://open.feishu.cn/open-apis";

let cachedToken: { token: string; expiresAt: number } | null = null;

/** True only when a self-built Feishu app is configured via env. */
export function feishuEnabled(): boolean {
  return Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
}

export async function getTenantAccessToken(force = false): Promise<string | null> {
  if (!feishuEnabled()) return null;
  if (!force && cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_id: process.env.FEISHU_APP_ID,
        app_secret: process.env.FEISHU_APP_SECRET,
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code !== 0 || !data.tenant_access_token) return null;
    cachedToken = {
      token: data.tenant_access_token,
      expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
    };
    return cachedToken.token;
  } catch {
    return null;
  }
}

export interface FeishuResponse<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

/** Call an open-platform API. Returns null when disabled, unauthenticated or failed. */
export async function feishuRequest<T = unknown>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<FeishuResponse<T> | null> {
  const call = async (): Promise<FeishuResponse<T> | null> => {
    const token = await getTenantAccessToken();
    if (!token) return null;
    try {
      const res = await fetch(OPEN_API_BASE + path, {
        method,
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return (await res.json().catch(() => ({}))) as FeishuResponse<T>;
    } catch {
      return null;
    }
  };
  const first = await call();
  // Token expired mid-flight: refresh once and retry.
  if (first && (first.code === 99991663 || first.code === 99991661)) {
    await getTenantAccessToken(true);
    return call();
  }
  return first;
}
