import NutriApp from "@/components/nutri-app";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, SESSION_COOKIE } from "@/lib/server/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const slug = (await params).slug ?? [];
  const isPublic =
    slug.length === 0 ||
    (slug.length === 1 && ["login", "signup", "forgot-password"].includes(slug[0]));
  if (!isPublic) {
    const cookieStore = await cookies();
    const user = getSessionUser(cookieStore.get(SESSION_COOKIE)?.value);
    if (!user) redirect("/login");
  }
  return <NutriApp />;
}
