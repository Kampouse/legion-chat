import { KV_ACCOUNTS, FASTNEAR_KV_API } from "./constants";

interface BindingValue {
  npub: string;
  relay: string;
  bound_at: number;
}

interface KvEntry {
  key: string;
  value: any;
}

interface KvResponse {
  entries: KvEntry[];
  page_token?: string;
}

async function fetchKvEntries(account: string, keyPrefix: string): Promise<KvEntry[]> {
  const all: KvEntry[] = [];
  let pageToken: string | undefined;
  do {
    const body: Record<string, unknown> = { key_prefix: keyPrefix, limit: 200 };
    if (pageToken) body.page_token = pageToken;
    const res = await fetch(`${FASTNEAR_KV_API}/v0/latest/${account}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 404) return all;
      throw new Error(`KV fetch failed: ${res.status}`);
    }
    const data: KvResponse = await res.json();
    all.push(...data.entries);
    pageToken = data.page_token;
  } while (pageToken);
  return all;
}

export async function fetchBinding(
  nearAccountId: string,
): Promise<{ npub: string; relay: string; bound_at: number } | null> {
  for (const account of KV_ACCOUNTS) {
    const url = `${FASTNEAR_KV_API}/v0/latest/${account}/${nearAccountId}/nostr/${nearAccountId}`;
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      if (data?.entries?.length > 0) return data.entries[0].value as BindingValue;
    } catch { /* try next */ }
  }
  return null;
}

export async function fetchAllBindings(): Promise<
  Record<string, { npub: string; relay: string }>
> {
  const result: Record<string, { npub: string; relay: string }> = {};
  for (const account of KV_ACCOUNTS) {
    try {
      const entries = await fetchKvEntries(account, "nostr/");
      for (const entry of entries) {
        const accountId = entry.key.slice(6);
        try {
          const parsed = entry.value as BindingValue;
          if (parsed?.npub && !result[accountId]) {
            result[accountId] = { npub: parsed.npub, relay: parsed.relay || "" };
          }
        } catch { /* skip */ }
      }
    } catch (e: any) {
      console.warn(`fetchAllBindings (${account}):`, e.message);
    }
  }
  return result;
}
