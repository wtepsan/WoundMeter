import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { DemoWorkflow } from "@/components/demo/DemoWorkflow";
import { DEMO_MODE } from "@/lib/accounts";

export const metadata: Metadata = { title: "Demo measurement" };

/** /demo: no sign-in; the real capture and record screens for one photo, nothing saved. Demo builds only. */
export default function DemoPage() {
  if (!DEMO_MODE) notFound();
  return (
    <main className="app-main" id="main">
      <DemoWorkflow />
    </main>
  );
}
