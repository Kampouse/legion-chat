import { JsonRpcProvider, actions } from "near-api-js";
import { SBT_CONTRACT, KV_ACCOUNT, NEAR_RPC } from "./constants";

export const provider = new JsonRpcProvider({ url: NEAR_RPC });

export const SBT_CONTRACTS = [SBT_CONTRACT, "initiate.nearlegion.near"];

export async function checkSbt(accountId: string): Promise<boolean> {
  try {
    for (const contractId of SBT_CONTRACTS) {
      const result = await provider.callFunction({
        contractId,
        method: "nft_tokens_for_owner",
        args: { account_id: accountId },
      });
      if (Array.isArray(result) && result.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export async function sendBindingTx(
  signAndSend: (params: any) => Promise<any>,
  accountId: string,
  npub: string,
  relay: string,
  proof: string,
): Promise<string> {
  const challenge = `legion:${accountId}:${Math.floor(Date.now() / 1000)}`;
  const txHash = await signAndSend({
    receiverId: KV_ACCOUNT,
    actions: [
      actions.functionCall(
        "__fastdata_kv",
        {
          [`nostr/${accountId}`]: {
            npub,
            relay,
            challenge,
            proof, // full Nostr event — anyone can verify pubkey signed this challenge
            bound_at: Math.floor(Date.now() / 1000),
          },
        },
        300_000_000_000_000n,
        0n,
      ),
    ],
  });
  return typeof txHash === "string" ? txHash : JSON.stringify(txHash);
}
