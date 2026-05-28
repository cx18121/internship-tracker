import { getStats } from "@/lib/store";
import { cachedJsonResponse } from "@/lib/cachedResponse";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return cachedJsonResponse(request, await getStats());
}
