import { databasePool } from "../../../../features/database/server/client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await databasePool().query("SELECT 1");
    return Response.json({ status: "ok" });
  } catch (error) {
    console.error("Database health check failed:", error);
    return Response.json({ status: "error" }, { status: 503 });
  }
}
