import { verify } from "../../../lib/verify";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return verify(request);
}
