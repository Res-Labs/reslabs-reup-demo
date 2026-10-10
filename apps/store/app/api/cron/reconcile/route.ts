import { config } from "../../../../lib/config";
import { reconcile } from "../../../../lib/reorder";

export const runtime = "nodejs";
// A prerendered or cached response would skip the pass, and a build must never run it.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** `GET /api/cron/reconcile`: one reconciler pass, for hosts without a long-lived process. */
export async function GET(request: Request): Promise<Response> {
  const secret = config.cronSecret;
  if (secret !== undefined && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json({ checked: await reconcile() });
}
