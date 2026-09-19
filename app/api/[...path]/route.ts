import { handleApi } from "@/lib/server/api";
import { after } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function handler(request: Request) {
  return handleApi(request, { scheduleResetDelivery: (task) => after(task) });
}
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
