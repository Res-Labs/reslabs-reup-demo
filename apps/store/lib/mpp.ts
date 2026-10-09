import { PATH_USD } from "@reup/chain-proof";
import { Mppx, tempo } from "mppx/server";
import { createClient, http } from "viem";
import { tempoModerato } from "viem/chains";
import { config } from "./config";

function lazy<T>(create: () => T): () => T {
  let value: T | undefined;
  return () => {
    value ??= create();
    return value;
  };
}

// No fee payer: co-signing would change the transaction hash after the client signs,
// and a reorder reserves that hash before broadcast.
export const mppx = lazy(() =>
  Mppx.create({
    secretKey: config.mppSecretKey,
    methods: [
      tempo.charge({
        testnet: true,
        currencies: [PATH_USD],
        recipient: config.mppRecipient,
        getClient: () =>
          createClient({ chain: tempoModerato, transport: http(config.tempoRpcUrl) }),
      }),
    ],
  }),
);
