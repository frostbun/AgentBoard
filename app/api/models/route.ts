import { supportsModel } from "@/lib/herdr/names";
import { candidateModels } from "@/lib/herdr/models";

export const dynamic = "force-dynamic";

/** Model ids to offer when starting or resuming an agent, gathered from local configs. */
export async function GET(request: Request): Promise<Response> {
  const kind = new URL(request.url).searchParams.get("kind") ?? "";
  if (!supportsModel(kind)) {
    return Response.json({ supported: false, models: [] }, { headers: { "cache-control": "no-store" } });
  }
  const models = candidateModels(kind);
  return Response.json(
    {
      supported: true,
      models,
      note: models.length ? "from this machine's agent config and recent sessions" : "no models found — pass one with extra args",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
