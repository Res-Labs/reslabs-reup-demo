import { reorder } from "../../../lib/reorder";

export const runtime = "nodejs";
// The inline resolution can wait about 45 s for the chain before answering.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  return reorder(request);
}
