import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import { NearConnector } from "@hot-labs/near-connect";

interface NearWalletContextType {
  accountId: string | null;
  isConnected: boolean;
  connect: () => void;
  disconnect: () => void;
  signAndSendTransaction: (params: any) => Promise<any>;
}

const NearWalletContext = createContext<NearWalletContextType | undefined>(undefined);

export function NearWalletProvider({ children }: { children: ReactNode }) {
  const [accountId, setAccountId] = useState<string | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("legion:cachedAccountId");
    }
    return null;
  });

  const connectorRef = useRef<NearConnector | null>(null);

  useEffect(() => {
    const connector = new NearConnector({
      network: "mainnet",
      autoConnect: true,
    });
    connectorRef.current = connector;

    connector
      .getConnectedWallet()
      .then(({ accounts }) => {
        if (accounts.length > 0) {
          const id = accounts[0].accountId;
          setAccountId(id);
          localStorage.setItem("legion:cachedAccountId", id);
        } else {
          setAccountId(null);
          localStorage.removeItem("legion:cachedAccountId");
        }
      })
      .catch(() => {
        setAccountId(null);
        localStorage.removeItem("legion:cachedAccountId");
      });

    const handleSignIn = ({ accounts }: { accounts: Array<{ accountId: string }> }) => {
      if (accounts.length > 0) {
        const id = accounts[0].accountId;
        setAccountId(id);
        localStorage.setItem("legion:cachedAccountId", id);
      }
    };

    const handleSignOut = () => {
      setAccountId(null);
      localStorage.removeItem("legion:cachedAccountId");
    };

    connector.on("wallet:signIn", handleSignIn as any);
    connector.on("wallet:signOut", handleSignOut);

    return () => {
      connector.off("wallet:signIn", handleSignIn as any);
      connector.off("wallet:signOut", handleSignOut);
    };
  }, []);

  const connect = useCallback(() => {
    connectorRef.current?.connect().catch(() => {});
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await connectorRef.current?.disconnect();
    } catch {}
    setAccountId(null);
    localStorage.removeItem("legion:cachedAccountId");
  }, []);

  const signAndSendTransaction = useCallback(async (params: any) => {
    const connector = connectorRef.current;
    if (!connector) throw new Error("Wallet not initialized");
    const wallet = await connector.wallet();
    return wallet.signAndSendTransaction(params);
  }, []);

  return (
    <NearWalletContext.Provider
      value={{ accountId, isConnected: !!accountId, connect, disconnect, signAndSendTransaction }}
    >
      {children}
    </NearWalletContext.Provider>
  );
}

export function useNearWallet() {
  const context = useContext(NearWalletContext);
  if (context === undefined) {
    throw new Error("useNearWallet must be used within a NearWalletProvider");
  }
  return context;
}
