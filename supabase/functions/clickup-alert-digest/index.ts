import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ── ApexOne → ClickUp sync failure digest ─────────────────────────────
// Polls `clickup_sync_failures` for rows logged since the last run and, if
// there are any, posts a summary to a ClickUp chat channel. Triggered on a
// schedule by pg_cron (see migration: schedule_clickup_alert_digest),
// following the same net.http_post + vault-secret pattern already used for
// clickup-webhook-healthcheck and pi-bridge-sync-poll.

const CLICKUP_TOKEN = Deno.env.get("CLICKUP_API_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const WORKSPACE_ID = "90152506082";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

function truncate(s: string | null, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function buildDigest(failures: any[]): string {
  const grouped: Record<string, number> = {};
  for (const f of failures) {
    const key = `${f.source_table ?? "unknown"} / ${f.operation ?? "unknown"}`;
    grouped[key] = (grouped[key] ?? 0) + 1;
  }

  const lines = [
    `⚠️ ClickUp sync: ${failures.length} new failure${failures.length !== 1 ? "s" : ""} since last check`,
    "",
    ...Object.entries(grouped)
      .sort((a, b) => b[1] - a[1])
      .map(([k, c]) => `• ${k}: ${c}`),
    "",
    "Most recent:",
    ...failures.slice(-5).map((f) =>
      `- [${f.occurred_at}] ${f.source_table ?? "?"}/${f.operation ?? "?"} record ${f.record_id ?? "?"}: ${truncate(f.error_message, 200)}`
    ),
  ];
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Channel ID is stored in Vault (set once the "ApexOne Sync Alerts"
  // channel exists) rather than hardcoded, mirroring get_clickup_webhook_secret().
  const { data: channelId, error: channelErr } = await supabase.rpc(
    "get_clickup_alert_channel_id",
  );
  if (channelErr || !channelId) {
    console.error("No alert channel configured yet:", channelErr);
    return new Response(
      JSON.stringify({ ok: false, error: "clickup_alert_channel_id not set in vault" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const { data: state } = await supabase
    .from("clickup_alert_state")
    .select("last_alerted_at")
    .eq("id", 1)
    .maybeSingle();
  const since = state?.last_alerted_at ?? new Date(0).toISOString();

  const { data: failures, error } = await supabase
    .from("clickup_sync_failures")
    .select("*")
    .gt("occurred_at", since)
    .order("occurred_at", { ascending: true });

  if (error) {
    console.error("Failed to query clickup_sync_failures:", error);
    return new Response(JSON.stringify({ ok: false, error: String(error) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!failures || failures.length === 0) {
    return new Response(JSON.stringify({ ok: true, posted: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const message = buildDigest(failures);

  const res = await fetch(
    `https://api.clickup.com/api/v3/workspaces/${WORKSPACE_ID}/chat/channels/${channelId}/messages`,
    {
      method: "POST",
      headers: {
        "Authorization": CLICKUP_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "message", content: message }),
    },
  );

  if (!res.ok) {
    const body = await res.text();
    console.error("Failed to post digest to ClickUp:", res.status, body);
    return new Response(JSON.stringify({ ok: false, error: body }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  await supabase
    .from("clickup_alert_state")
    .upsert({ id: 1, last_alerted_at: new Date().toISOString() });

  return new Response(
    JSON.stringify({ ok: true, posted: true, count: failures.length }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
