import { config, isUuid } from "./config";

/** The only part of a Res Labs decision that may leave `readTap`. */
export interface Tap {
  tapId: string;
  batchId: string;
  batchCode: string;
  productName: string;
  vendorName: string;
  /** Empty when Res Labs has no lab URL for the COA; shown as "COA on file at Res Labs". */
  coaUrl: string;
}

export const TAP_ERROR_STATUS = {
  bad_link: 400,
  link_expired: 410,
  not_eligible: 422,
  reslabs_unavailable: 502,
} as const;

export type TapError = keyof typeof TAP_ERROR_STATUS;

export type TapRead = { kind: "verified"; tap: Tap } | { kind: "rejected"; error: TapError };

/** The decision paths `readTap` projects; every other field of the body is ignored. */
interface SessionDecision {
  variant?: unknown;
  verified?: unknown;
  tap?: { id?: unknown } | null;
  batch?: { id?: unknown; batch_code?: unknown; product_name?: unknown } | null;
  provenance_summary?: { brand_name?: unknown } | null;
  coa?: { lab_coa_url?: unknown } | null;
}

const SESSION_TIMEOUT_MS = 5_000;

/** Returns the share token when `link` is a `/v/p` link on the Res Labs link origin. */
export function tapToken(link: string, linkOrigin: string): string | null {
  if (!URL.canParse(link)) return null;
  const url = new URL(link);
  if (url.origin !== linkOrigin || url.pathname !== "/v/p") return null;
  return url.searchParams.get("t") || null;
}

export function projectSession(status: number, body: string, demoBatchId: string): TapRead {
  if (status === 401) return { kind: "rejected", error: "link_expired" };
  if (status !== 200) return { kind: "rejected", error: "reslabs_unavailable" };

  const decision = (() => {
    try {
      const parsed: unknown = JSON.parse(body);
      return typeof parsed === "object" && parsed !== null ? (parsed as SessionDecision) : null;
    } catch {
      return null;
    }
  })();
  const tapId = decision?.tap?.id;
  const batchCode = decision?.batch?.batch_code;
  const productName = decision?.batch?.product_name;
  const vendorName = decision?.provenance_summary?.brand_name;
  const coaUrl = decision?.coa?.lab_coa_url ?? "";
  if (
    decision?.variant !== "success" ||
    decision.verified !== true ||
    !isUuid(tapId) ||
    decision.batch?.id !== demoBatchId ||
    typeof batchCode !== "string" ||
    typeof productName !== "string" ||
    typeof vendorName !== "string" ||
    typeof coaUrl !== "string"
  ) {
    return { kind: "rejected", error: "not_eligible" };
  }
  return {
    kind: "verified",
    tap: { tapId, batchId: demoBatchId, batchCode, productName, vendorName, coaUrl },
  };
}

/**
 * Reads the tap behind a 5-minute share link. Only the `Tap` projection leaves this function;
 * the raw body is never logged, stored or returned.
 */
export async function readTap(link: string): Promise<TapRead> {
  const token = tapToken(link, config.reslabsLinkOrigin);
  if (token === null) return { kind: "rejected", error: "bad_link" };
  const sessionUrl = new URL(config.reslabsSessionUrl);
  sessionUrl.searchParams.set("t", token);
  try {
    const response = await fetch(sessionUrl, {
      cache: "no-store",
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
    if (response.status !== 200 && response.status !== 401) {
      console.warn(`res labs session answered HTTP ${response.status}`);
    }
    return projectSession(response.status, await response.text(), config.demoBatchId);
  } catch (error) {
    console.warn(`res labs session unreachable: ${error instanceof Error ? error.name : "error"}`);
    return { kind: "rejected", error: "reslabs_unavailable" };
  }
}
