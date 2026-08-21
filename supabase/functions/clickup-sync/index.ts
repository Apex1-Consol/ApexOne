import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Config ────────────────────────────────────────────────────────────────────
const CLICKUP_API_KEY   = Deno.env.get("CLICKUP_API_KEY")!;
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SVC_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const FIELD_ID = "e7934dac-3578-4e7d-a460-4ec5af0f6756"; // "ApexOne Record ID"

const LIST = {
  client_onboarding:    "901524833469",
  programme_setup:      "901524838434",
  learner_enrolment:    "901524848024",
  attendance_poe:       "901524848028",
  monitoring_visits:    "901524848033",
  recommendations:      "901524848036",
  eisa_readiness:       "901524848044",
  reporting_compliance: "901524848046",
  engineering_bugs:     "901525116455",
};

// event → [{list, status}]  — extend as the pipeline grows
const EVENT_MAP: Record<string, Array<{ list: string; status: string }>> = {
  report_submitted:   [{ list: LIST.reporting_compliance, status: "in progress" }],
  report_approved:    [{ list: LIST.reporting_compliance, status: "in progress" }],
  report_sent:        [{ list: LIST.reporting_compliance, status: "complete"    }],
  report_archived:    [{ list: LIST.reporting_compliance, status: "complete"    }],
  programme_active:   [{ list: LIST.programme_setup,      status: "active"      }],
  enrolment_complete: [{ list: LIST.learner_enrolment,    status: "complete"    }],
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Handler ───────────────────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  // Auth: verify the caller holds a valid Supabase session
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);
  const { data: { user }, error: authErr } =
    await supabase.auth.getUser(authHeader.slice(7));
  if (authErr || !user) {
    return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
  }

  // Parse body
  let body: { event: string; programme_id?: number | string; client_id?: number | string };
  try { body = await req.json(); }
  catch { return new Response("Invalid JSON", { status: 400, headers: CORS_HEADERS }); }

  const { event, programme_id, client_id } = body;
  if (!event) return new Response("'event' is required", { status: 400, headers: CORS_HEADERS });

  const targets = EVENT_MAP[event];
  if (!targets?.length) {
    return json({ skipped: true, event });
  }

  const record_id = programme_id
    ? `programmes:${programme_id}`
    : `clients:${client_id}`;

  const results: Array<{ task_id: string; ok: boolean; error?: string }> = [];

  for (const target of targets) {
    const tasks = await fetchTasksByRecordId(target.list, record_id);
    for (const task of tasks) {
      const res = await updateTaskStatus(task.id, target.status);
      results.push({ task_id: task.id, ...res });

      if (!res.ok) {
        await supabase.from("clickup_sync_failures").insert({
          programme_id: programme_id ? String(programme_id) : null,
          client_id:    client_id    ? String(client_id)    : null,
          event_type:      event,
          record_id,
          clickup_list_id: target.list,
          payload:      { task_id: task.id, target_status: target.status },
          error_message:   res.error,
          http_status:     res.httpStatus ?? null,
        });
      }
    }
  }

  return json({ record_id, event, matched: results.length, results });
});

// ── ClickUp helpers ───────────────────────────────────────────────────────────
async function fetchTasksByRecordId(listId: string, recordId: string): Promise<any[]> {
  const url =
    `https://api.clickup.com/api/v2/list/${listId}/task` +
    `?include_closed=true&page=0&limit=100`;
  const res = await fetch(url, { headers: { Authorization: CLICKUP_API_KEY } });
  if (!res.ok) return [];
  const { tasks = [] } = await res.json();
  return tasks.filter((t: any) => {
    const field = (t.custom_fields ?? []).find((f: any) => f.id === FIELD_ID);
    return field?.value === recordId;
  });
}

async function updateTaskStatus(
  taskId: string,
  status: string,
): Promise<{ ok: boolean; error?: string; httpStatus?: number }> {
  const res = await fetch(`https://api.clickup.com/api/v2/task/${taskId}`, {
    method: "PUT",
    headers: {
      Authorization:  CLICKUP_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status }),
  });
  if (res.ok) return { ok: true };
  const error = await res.text().catch(() => "unknown error");
  return { ok: false, error, httpStatus: res.status };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
