import { generateTarget } from "../../../../features/game/server/target";

export async function POST() {
  return Response.json({ target: generateTarget() });
}
