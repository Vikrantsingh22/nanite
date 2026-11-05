/** Minimal HTTP client for the Nanite agent API (/v1). The token is never logged or echoed. */
export interface ClientConfig {
  apiUrl: string;
  token: string;
  fetch?: typeof fetch;
}

export type ApiResult =
  | { ok: true; status: number; body: unknown }
  | { ok: false; status: number; error: string };

export function createClient(cfg: ClientConfig) {
  const base = cfg.apiUrl.replace(/\/+$/, "");
  const doFetch = cfg.fetch ?? fetch;

  async function get(path: string, params: Record<string, string | number | undefined> = {}, timeoutMs = 15_000): Promise<ApiResult> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const url = `${base}${path}${qs.size ? `?${qs}` : ""}`;
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { authorization: `Bearer ${cfg.token}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, status: 0, error: "network_error" };
    }
    if (res.status === 204) return { ok: true, status: 204, body: null };
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const code = (json as { error?: unknown } | null)?.error;
      return { ok: false, status: res.status, error: typeof code === "string" ? code : "http_error" };
    }
    return { ok: true, status: res.status, body: json };
  }

  return {
    listInbox: (p: { type?: string; before?: number; after?: number; limit?: number; cursor?: string }) =>
      get("/v1/inbox", p),
    getEmail: (entityKey: string, raw?: boolean) =>
      get(`/v1/emails/${encodeURIComponent(entityKey)}`, { raw: raw ? 1 : undefined }),
    latestOtp: () => get("/v1/otp/latest"),
    waitForEmail: (p: { type?: string; since?: number; timeout?: number }) =>
      get("/v1/emails/wait", p, ((p.timeout ?? 30) + 10) * 1000),
  };
}
export type NaniteClient = ReturnType<typeof createClient>;
