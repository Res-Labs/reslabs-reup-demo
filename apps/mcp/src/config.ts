import { z } from "zod";

export interface Config {
  agentKey: `0x${string}`;
  storeUrl: string;
  mppRecipient: `0x${string}`;
}

const hex = (bytes: number) => new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`);

const Env = z.object({
  AGENT_KEY: z.string().regex(hex(32), "must be a 0x-prefixed 32-byte private key"),
  STORE_URL: z.string().url("must be the Demo Store base URL"),
  MPP_RECIPIENT: z.string().regex(hex(20), "must be a 0x-prefixed 20-byte address"),
});

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
    throw new Error(`Invalid environment: ${problems.join("; ")}`);
  }
  const { AGENT_KEY, STORE_URL, MPP_RECIPIENT } = result.data;
  return {
    agentKey: AGENT_KEY as `0x${string}`,
    storeUrl: STORE_URL.replace(/\/+$/, ""),
    mppRecipient: MPP_RECIPIENT as `0x${string}`,
  };
}
