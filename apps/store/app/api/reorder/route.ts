import { reorder } from "../../../lib/reorder";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return reorder(request);
}
