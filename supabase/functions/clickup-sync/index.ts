import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CLICKUP_TOKEN = Deno.env.get("CLICKUP_API_TOKEN")!;
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET")!;
const CLICKUP_BASE = "https://api.clickup.com/api/v2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const FIELD_IDS = {
  apexoneRecordId: "e7934dac-3578-4e7d-a460-4ec5af0f6756",
  programme: "bd3e4f2c-3d5f-4894-a6b2-94848b7064e8",
  learnerClientName: "7507416c-a59e-4bb6-9f23-a1a022773b7d",
  enrolledLearners: "0eccc603-40b9-42d5-8c87-52d5bd7a874a",
  companyName: "b05acf04-85b5-4def-896e-795c41970ec9",
  mouStatus: "362aaaa0-f9f1-44f8-a502-ea1fe5733a9e",
  mouExpiryDate: "eb7f87f7-1963-4254-bf83-7fbb06050ffe",
  programmeName: "fc7ada3e-e3e4-483f-b07b-abecaa6a2edd",
  poeStatus: "0727b6fb-564b-403a-a82a-bccb9c02c31b",
  attendancePct: "98e07ffc-1b10-4fe1-91bc-c8cf4ed5926e",
  overallJudgment: "adff55e9-edb7-437f-a969-3ef71c82bf0c",
  eisaReadiness: "b22663b2-6936-4112-b62a-1027ae601be3",
  recommendationStatus: "fa0ee5b4-0cb7-4099-ba0a-cbe83ad31202",
  eisaResult: "cc8dcdf1-6c0b-4649-aae6-7cf42667dcd1",
  complianceStatus: "fe2f5fbe-187c-4bac-9738-7ebd53a52454",
  accreditationStatus: "d595fdb8-d557-4ab4-9ec1-a84799441b3a",
  extensionOfScopeStatus: "dd382d6b-7e11-4fc9-95b5-54c447ffaf7d",
  statementStatus: "ee677f1e-747c-42ba-ab76-d2e15cb49865",
  lastReportSent: "c5142519-c09a-437f-a3dd-41e1ede90975",
  reportSentBy: "06b1ae22-8c7a-47c6-9459-13103ebd2058",
  reportFlags: "f5e5333a-7b7e-437b-95d7-0c8f7eea40be",
};

const DROPDOWN_OPTIONS: Record<string, Record<string, string>> = {
  [FIELD_IDS.mouStatus]: {
    "Draft": "6f477281-5ffe-47ad-810d-603e297db0d5",
    "Signed": "2aaf5e04-d196-4e07-aa39-89b3285c3c2f",
    "Expired": "365a69bd-275e-4cac-ad77-f4ba0dd211cd",
  },
  [FIELD_IDS.eisaReadiness]: {
    "Ready": "0e648365-5759-4d91-bc7e-558a500edae3",
    "Not Ready": "52aa715a-d50c-45e4-b568-0291cbb666fc",
    "In Progress": "ebdd108a-cce1-4afc-b9ee-ba2a2b2ae886",
  },
  [FIELD_IDS.eisaResult]: {
    "Competent": "58f00831-2e1a-48d8-a471-021b4cdbe5a5",
    "Not Yet Competent": "9a2620b0-5a2a-4924-bfa4-5788fdafc143",
    "Pending": "7a07c250-0ae9-49ac-82df-16bb5453e245",
    "Absent": "5eaa87d0-7eeb-4dd8-a496-fb3d32e288ac",
  },
  [FIELD_IDS.poeStatus]: {
    "Complete": "1b2eb428-ea69-474f-a726-7342e2457fd9",
    "Incomplete": "86603bc1-f69a-4dac-aba5-43487b1f4d66",
    "Not Started": "5530c063-3267-460c-beb0-2ec44327402a",
  },
  [FIELD_IDS.recommendationStatus]: {
    "Open": "77ecbe12-dc85-430d-ad70-84bceb5f7540",
    "Closed": "8b06ee52-19db-43dc-9ec1-e9382575fd20",
  },
  [FIELD_IDS.complianceStatus]: {
    "Compliant": "99320590-c8e4-4813-9bdf-8fbafcd12813",
    "At Risk": "5ef33600-0f12-4eb9-b1d8-27f8c9f464a5",
    "Non-Compliant": "20edc68b-582a-4737-b80a-f6fdcea83706",
  },
  [FIELD_IDS.accreditationStatus]: {
    "Active": "d2b4c399-d49c-4956-bc4e-0bb4af35a98f",
    "Renewal Due": "673d571f-4138-44d3-aaf6-0aa47832fe60",
    "Expired": "4dbc727a-a48e-4611-bb93-6641802df7ae",
  },
  [FIELD_IDS.extensionOfScopeStatus]: {
    "Active": "32558189-d5d7-41eb-b341-23bbbf608144",
    "Renewal Due": "f3810eb9-4707-4a75-9a9c-894d05adf84f",
    "Expired": "4075602e-76f7-4cca-ab9e-d583ba426c0e",
  },
  [FIELD_IDS.statementStatus]: {
    "Issued": "4ff97abd-640f-4f99-9e6e-eb51a2fd2410",
    "Pending": "9976dff3-2dda-49b4-8265-a9577ac2e8e7",
    "Not Issued": "f61905c6-60c2-4ed4-8823-7d92ac2c32cb",
  },
};

function resolveFieldValue(fieldId: string, value: string): string | null {
  const options = DROPDOWN_OPTIONS[fieldId];
  if (!options) return value;
  return options[value] ?? null;
}

const CLIENT_LIST = {
  id: "901524833469",
  templates: [
    "Collect signed service agreement",
    "Verify company/SDL registration",
    "Assign account manager",
    "Send welcome pack & onboarding checklist to client",
  ],
  closeStatus: "complete",
};

const PROGRAMME_SETUP_LIST = "901524838434";
const ATTENDANCE_POE_LIST = "901524848028";
const MONITORING_VISITS_LIST = "901524848033";
const RECOMMENDATIONS_LIST = "901524848036";
const EISA_LIST = "901524848044";
const REPORTING_LIST = "901524848046";

const PROGRAMME_LISTS = [
  {
    id: PROGRAMME_SETUP_LIST,
    templates: [
      "Confirm qualification/programme selection with client",
      "Set up learning material & assessment packs",
      "Assign facilitator/assessor/moderator",
      "Confirm programme start date & schedule",
    ],
    closeStatus: "Closed",
  },
  {
    id: "901524848024",
    templates: [
      "Collect learner registration forms & ID documents",
      "Verify learner eligibility (prior learning/qualifications)",
      "Register learner on SETA/QCTO system",
      "Issue learner welcome pack & induction",
    ],
    closeStatus: "complete",
  },
  {
    id: ATTENDANCE_POE_LIST,
    templates: [
      "Capture weekly attendance register",
      "Review PoE submission for completeness",
      "Flag non-compliant learners for follow-up",
    ],
    closeStatus: "compliant",
  },
  {
    id: MONITORING_VISITS_LIST,
    templates: [
      "Schedule site monitoring visit",
      "Conduct site visit & complete monitoring checklist",
      "File monitoring visit report",
    ],
    closeStatus: "complete",
  },
  {
    id: RECOMMENDATIONS_LIST,
    templates: [
      "Log corrective action recommendation",
      "Track implementation of recommendation",
    ],
    closeStatus: "complete",
  },
  {
    id: EISA_LIST,
    templates: [
      "Confirm learner PoE sign-off for EISA eligibility",
      "Register learner for EISA",
    ],
    closeStatus: "complete",
  },
  {
    id: REPORTING_LIST,
    templates: [
      "Compile monthly SETA/QCTO compliance report",
      "Submit compliance report to client/SETA",
    ],
    closeStatus: "complete",
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickupFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<any> {
  const res = await fetch(`${CLICKUP_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": CLICKUP_TOKEN,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (res.status === 429 && attempt < 4) {
    const retryAfterHeader = res.headers.get("Retry-After");
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : null;
    const backoffMs = retryAfterMs ?? Math.min(1000 * 2 ** attempt, 8000);
    await sleep(backoffMs);
    return clickupFetch(path, init, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickUp API ${res.status}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function setTaskField(taskId: string, fieldId: string, rawValue: string) {
  const value = resolveFieldValue(fieldId, rawValue);
  if (value === null) return;
  await clickupFetch(`/task/${taskId}/field/${fieldId}`, {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

async function createTaskWithFields(
  listId: string,
  name: string,
  fields: Record<string, string>,
) {
  const task = await clickupFetch(`/list/${listId}/task`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  for (const [fieldId, value] of Object.entries(fields)) {
    if (!value) continue;
    await setTaskField(task.id, fieldId, value);
  }
  return task;
}

async function createPipelineForList(
  list: { id: string; templates: string[] },
  fields: Record<string, string>,
) {
  const results = [];
  for (const name of list.templates) {
    results.push(await createTaskWithFields(list.id, name, fields));
  }
  return results;
}

async function findTasksForRecord(listId: string, apexoneRecordId: string) {
  const query = encodeURIComponent(
    JSON.stringify([
      { field_id: FIELD_IDS.apexoneRecordId, operator: "=", value: apexoneRecordId },
    ]),
  );
  const data = await clickupFetch(`/list/${listId}/task?custom_fields=${query}&include_closed=true`);
  return data.tasks || [];
}

async function closeTasksForRecord(apexoneRecordId: string) {
  const lists = [CLIENT_LIST, ...PROGRAMME_LISTS];
  for (const list of lists) {
    const tasks = await findTasksForRecord(list.id, apexoneRecordId);
    for (const task of tasks) {
      await clickupFetch(`/task/${task.id}`, {
        method: "PUT",
        body: JSON.stringify({ status: list.closeStatus }),
      });
    }
  }
}

async function setFieldOnList(listId: string, apexoneRecordId: string, fieldId: string, value: string) {
  const tasks = await findTasksForRecord(listId, apexoneRecordId);
  for (const task of tasks) {
    await setTaskField(task.id, fieldId, value);
  }
}

async function setFieldAcrossAllLists(apexoneRecordId: string, fieldId: string, value: string) {
  const lists = [CLIENT_LIST, ...PROGRAMME_LISTS];
  for (const list of lists) {
    await setFieldOnList(list.id, apexoneRecordId, fieldId, value);
  }
}

async function postComment(taskId: string, text: string) {
  await clickupFetch(`/task/${taskId}/comment`, {
    method: "POST",
    body: JSON.stringify({ comment_text: text }),
  });
}

function assessorRegistrationStatus(expiryDate: string | null): string {
  if (!expiryDate) return "Unknown (no expiry date on file)";
  const expiry = new Date(expiryDate).getTime();
  const now = Date.now();
  if (expiry < now) return "EXPIRED";
  if (expiry - now < 90 * 24 * 60 * 60 * 1000) return "Expiring soon (within 90 days)";
  return "Active";
}

function formatAssessorStatusComment(assessor: any): string {
  const status = assessorRegistrationStatus(assessor.registration_expiry_date);
  return [
    `Assessor registration status: ${assessor.full_name || "(unnamed)"}`,
    `SETA registration #: ${assessor.seta_registration_number || "not set"}`,
    `Accreditation body: ${assessor.accreditation_body || "not set"}`,
    `Expiry date: ${assessor.registration_expiry_date || "not set"}`,
    `Status: ${status}`,
  ].join("\n");
}

function formatLearnerCommentComment(learnerName: string, month: string | null, comment: string, pmEmail: string | null): string {
  return [
    `Learner comment — ${learnerName}${month ? ` (${month})` : ""}`,
    comment,
    pmEmail ? `Logged by: ${pmEmail}` : null,
  ].filter(Boolean).join("\n");
}

function formatExecSnapshotLines(execSnapshot: any | null): string[] {
  if (!execSnapshot) return [];
  const { avgAtt, totalFlags, eisaCompletedPct } = execSnapshot;
  const lines = ["—"];
  lines.push(
    totalFlags > 0
      ? `⚠ ${totalFlags} flag${totalFlags !== 1 ? "s" : ""} raised this period (see report's Recommended Next Steps)`
      : `✓ No flags this period — on track`,
  );
  if (avgAtt !== null && avgAtt !== undefined) lines.push(`Attendance: ${avgAtt}%`);
  if (eisaCompletedPct !== null && eisaCompletedPct !== undefined) lines.push(`EISA completed: ${eisaCompletedPct}%`);
  return lines;
}

function formatReportSentComment(record: any, execSnapshot: any | null): string {
  const client = record.client_name_snapshot || "(client not recorded)";
  const programme = record.programme_name_snapshot || "(programme not recorded)";
  const month = record.month || "(month not recorded)";
  const learners = record.learner_count != null ? String(record.learner_count) : "unknown";
  const sentAt = record.sent_at ? new Date(record.sent_at).toLocaleString("en-ZA", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "unknown";
  const lines = [
    `📤 Report sent to client`,
    `Client: ${client}`,
    `Programme: ${programme}`,
    `Reporting month: ${month}`,
    `Learners covered: ${learners}`,
    `Sent by: ${record.sent_by || "unknown"}`,
    `Sent at: ${sentAt}`,
    ...formatExecSnapshotLines(execSnapshot),
  ];
  return lines.join("\n");
}

function formatReportSubmittedComment(record: any): string {
  const client = record.client_name_snapshot || "(client not recorded)";
  const programme = record.programme_name_snapshot || "(programme not recorded)";
  const month = record.month || "(month not recorded)";
  const learners = record.learner_count != null ? String(record.learner_count) : "unknown";
  const submittedAt = record.printed_at ? new Date(record.printed_at).toLocaleString("en-ZA", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "unknown";
  return [
    `📝 Report submitted for review`,
    `Client: ${client}`,
    `Programme: ${programme}`,
    `Reporting month: ${month}`,
    `Learners covered: ${learners}`,
    `Submitted by: ${record.submitted_by_email || "unknown"}`,
    `Submitted at: ${submittedAt}`,
  ].join("\n");
}

function formatReviewDecisionComment(record: any): string {
  const client = record.client_name_snapshot || "(client not recorded)";
  const programme = record.programme_name_snapshot || "(programme not recorded)";
  const month = record.month || "(month not recorded)";
  const decision = record.status === "approved" ? "✅ Report approved" : "↩ Changes requested";
  const reviewedAt = record.reviewed_at ? new Date(record.reviewed_at).toLocaleString("en-ZA", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "unknown";
  const lines = [
    decision,
    `Client: ${client}`,
    `Programme: ${programme}`,
    `Reporting month: ${month}`,
    `Reviewed by: ${record.reviewed_by || "unknown"}`,
    `Reviewed at: ${reviewedAt}`,
  ];
  if (record.reviewer_note) {
    lines.push("—");
    lines.push(`Note: ${record.reviewer_note}`);
  }
  return lines.join("\n");
}

function formatReportArchivedComment(record: any): string {
  const client = record.client_name_snapshot || "(client not recorded)";
  const programme = record.programme_name_snapshot || "(programme not recorded)";
  const month = record.month || "(month not recorded)";
  const archivedAt = record.archived_at ? new Date(record.archived_at).toLocaleString("en-ZA", {
    day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }) : "unknown";
  return [
    `🗄 Report archived`,
    `Client: ${client}`,
    `Programme: ${programme}`,
    `Reporting month: ${month}`,
    `Archived by: ${record.archived_by || "unknown"}`,
    `Archived at: ${archivedAt}`,
  ].join("\n");
}

function extractStatusCode(errMsg: string): number | null {
  const m = errMsg.match(/ClickUp API (\d+):/);
  return m ? parseInt(m[1], 10) : null;
}

async function logFailure(opts: {
  sourceTable: string | undefined;
  operation: string | undefined;
  recordId: string | null;
  errMsg: string;
}) {
  try {
    await supabase.from("clickup_sync_failures").insert({
      source_table: opts.sourceTable ?? null,
      operation: opts.operation ?? null,
      record_id: opts.recordId,
      status_code: extractStatusCode(opts.errMsg),
      response_body: opts.errMsg,
      error_message: opts.errMsg,
    });
  } catch (logErr) {
    console.error("Failed to write sync failure log:", logErr);
  }
}

function mapRecommendationStatus(resolved: boolean): string {
  return resolved ? "Closed" : "Open";
}

Deno.serve(async (req: Request) => {
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const { type, table, record, old_record, client_name } = payload;

  try {
    if (table === "clients" && type === "INSERT") {
      const f = record.fields || {};
      const fields: Record<string, string> = {
        [FIELD_IDS.apexoneRecordId]: `clients:${record.id}`,
        [FIELD_IDS.learnerClientName]: record.client_name,
        [FIELD_IDS.companyName]: f["Company Name"] || record.client_name || "",
      };
      if (f["MOU Status"]) {
        fields[FIELD_IDS.mouStatus] = f["MOU Status"];
      }
      await createPipelineForList(CLIENT_LIST, fields);
    }

    if (table === "clients" && type === "UPDATE") {
      const f = record.fields || {};
      const of = old_record?.fields || {};
      const apexoneRecordId = `clients:${record.id}`;

      if (f["Company Name"] !== of["Company Name"] || record.client_name !== old_record?.client_name) {
        await setFieldOnList(CLIENT_LIST.id, apexoneRecordId, FIELD_IDS.companyName, f["Company Name"] || record.client_name || "");
        await setFieldOnList(CLIENT_LIST.id, apexoneRecordId, FIELD_IDS.learnerClientName, record.client_name || "");
      }
      if (f["MOU Status"] && f["MOU Status"] !== of["MOU Status"]) {
        await setFieldOnList(CLIENT_LIST.id, apexoneRecordId, FIELD_IDS.mouStatus, f["MOU Status"]);
      }
      if (f["MOU Expiry Date"] && f["MOU Expiry Date"] !== of["MOU Expiry Date"]) {
        const d = Date.parse(f["MOU Expiry Date"]);
        if (!isNaN(d)) {
          await setFieldOnList(CLIENT_LIST.id, apexoneRecordId, FIELD_IDS.mouExpiryDate, String(d));
        }
      }
    }

    if (table === "programmes" && type === "INSERT") {
      for (const list of PROGRAMME_LISTS) {
        const fields: Record<string, string> = {
          [FIELD_IDS.apexoneRecordId]: `programmes:${record.id}`,
          [FIELD_IDS.programme]: record.programme_name,
          [FIELD_IDS.learnerClientName]: client_name || "",
        };
        if (list.id === PROGRAMME_SETUP_LIST) {
          fields[FIELD_IDS.programmeName] = record.programme_name || "";
        }
        await createPipelineForList(list, fields);
      }
    }

    if (
      table === "programmes" &&
      type === "UPDATE" &&
      record.status === "closed" &&
      old_record?.status !== "closed"
    ) {
      await closeTasksForRecord(`programmes:${record.id}`);
    }

    if (table === "enrolments" && type === "ENROLMENT_COUNT") {
      await setFieldAcrossAllLists(
        `programmes:${record.programme_id}`,
        FIELD_IDS.enrolledLearners,
        String(record.enrolled_count),
      );
    }

    if (table === "monitoring_visits" && (type === "INSERT" || type === "UPDATE")) {
      const f = record.fields || {};
      const programmeId = record.programme_id ?? (Array.isArray(f.Programme) ? f.Programme[0] : null);
      if (programmeId) {
        const apexoneRecordId = `programmes:${programmeId}`;
        if (f["Overall Judgment"]) {
          await setFieldOnList(MONITORING_VISITS_LIST, apexoneRecordId, FIELD_IDS.overallJudgment, String(f["Overall Judgment"]));
        }
        if (f["EISA Readiness"]) {
          await setFieldOnList(MONITORING_VISITS_LIST, apexoneRecordId, FIELD_IDS.eisaReadiness, f["EISA Readiness"]);
          await setFieldOnList(EISA_LIST, apexoneRecordId, FIELD_IDS.eisaReadiness, f["EISA Readiness"]);
        }
      }
    }

    if (table === "recommendations" && (type === "INSERT" || type === "UPDATE")) {
      if (record.programme_id) {
        const status = mapRecommendationStatus(!!record.resolved);
        await setFieldOnList(
          RECOMMENDATIONS_LIST,
          `programmes:${record.programme_id}`,
          FIELD_IDS.recommendationStatus,
          status,
        );
      }
    }

    if (table === "attendance" && type === "ATTENDANCE_PCT") {
      await setFieldOnList(
        ATTENDANCE_POE_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.attendancePct,
        String(record.attendance_pct),
      );
    }

    if (table === "poe_checklist" && type === "POE_STATUS") {
      await setFieldOnList(
        ATTENDANCE_POE_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.poeStatus,
        record.poe_status,
      );
    }

    if (table === "eisa" && type === "EISA_RESULT") {
      await setFieldOnList(
        EISA_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.eisaResult,
        record.eisa_result,
      );
    }

    if (table === "statement" && type === "STATEMENT_STATUS") {
      await setFieldOnList(
        EISA_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.statementStatus,
        record.statement_status,
      );
    }

    if (table === "compliance" && type === "COMPLIANCE_STATUS") {
      await setFieldOnList(
        REPORTING_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.complianceStatus,
        record.compliance_status,
      );
    }

    if (table === "accreditation" && type === "ACCREDITATION_STATUS") {
      await setFieldOnList(
        REPORTING_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.accreditationStatus,
        record.accreditation_status,
      );
    }

    if (table === "extension_of_scope" && type === "EXTENSION_OF_SCOPE_STATUS") {
      await setFieldOnList(
        REPORTING_LIST,
        `programmes:${record.programme_id}`,
        FIELD_IDS.extensionOfScopeStatus,
        record.extension_of_scope_status,
      );
    }

    if (table === "assessors" && type === "ASSESSOR_STATUS") {
      const { data: linkedProgrammes } = await supabase
        .from("programmes")
        .select("id")
        .eq("facilitator_id", record.id);

      const comment = formatAssessorStatusComment(record);
      for (const p of linkedProgrammes || []) {
        const tasks = await findTasksForRecord(PROGRAMME_SETUP_LIST, `programmes:${p.id}`);
        for (const task of tasks) {
          await postComment(task.id, comment);
        }
      }
    }

    if (table === "programmes" && type === "FACILITATOR_ASSIGNED") {
      if (record.facilitator_id) {
        const { data: assessor } = await supabase
          .from("assessors")
          .select("*")
          .eq("id", record.facilitator_id)
          .maybeSingle();

        if (assessor) {
          const tasks = await findTasksForRecord(PROGRAMME_SETUP_LIST, `programmes:${record.id}`);
          const comment = formatAssessorStatusComment(assessor);
          for (const task of tasks) {
            await postComment(task.id, comment);
          }
        }
      }
    }

    if (table === "learner_comments" && type === "LEARNER_COMMENT") {
      if (record.programme_id && record.comment) {
        const { data: learner } = await supabase
          .from("learners")
          .select("first_name, last_name")
          .eq("id", record.learner_id)
          .maybeSingle();

        const learnerName = learner
          ? `${learner.first_name || ""} ${learner.last_name || ""}`.trim() || `Learner #${record.learner_id}`
          : `Learner #${record.learner_id}`;

        const comment = formatLearnerCommentComment(learnerName, record.month, record.comment, record.pm_email);
        const tasks = await findTasksForRecord(EISA_LIST, `programmes:${record.programme_id}`);
        for (const task of tasks) {
          await postComment(task.id, comment);
        }
      }
    }

    if (table === "drafts" && (type === "INSERT" || type === "UPDATE")) {
      const execSnapshot = record.payload?._meta?.execSnapshot ?? null;
      if (record.programme_id && execSnapshot && execSnapshot.totalFlags != null) {
        await setFieldOnList(
          REPORTING_LIST,
          `programmes:${record.programme_id}`,
          FIELD_IDS.reportFlags,
          String(execSnapshot.totalFlags),
        );
      }
    }

    // ── Report lifecycle: status progression on Reporting Compliance tasks ────
    // INSERT = report first submitted for review → move task to "in progress"
    if (table === "reports" && type === "INSERT") {
      if (record.programme_id) {
        const apexoneRecordId = `programmes:${record.programme_id}`;
        const tasks = await findTasksForRecord(REPORTING_LIST, apexoneRecordId);
        const comment = formatReportSubmittedComment(record);
        for (const task of tasks) {
          await clickupFetch(`/task/${task.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "in progress" }),
          });
          await postComment(task.id, comment);
        }
      }
    }

    // UPDATE with reviewed_by newly set = admin approved or requested changes
    // Status stays "in progress" — comment records the decision
    if (table === "reports" && type === "UPDATE" && record.reviewed_by && !old_record?.reviewed_by) {
      if (record.programme_id) {
        const comment = formatReviewDecisionComment(record);
        const tasks = await findTasksForRecord(REPORTING_LIST, `programmes:${record.programme_id}`);
        for (const task of tasks) {
          await postComment(task.id, comment);
        }
      }
    }

    // UPDATE with sent_at newly set = report sent to client → move task to "complete"
    if (table === "reports" && type === "UPDATE" && record.sent_at && !old_record?.sent_at) {
      if (record.programme_id) {
        const apexoneRecordId = `programmes:${record.programme_id}`;
        const sentTimestamp = Date.parse(record.sent_at);
        if (!isNaN(sentTimestamp)) {
          await setFieldOnList(REPORTING_LIST, apexoneRecordId, FIELD_IDS.lastReportSent, String(sentTimestamp));
        }
        if (record.sent_by) {
          await setFieldOnList(REPORTING_LIST, apexoneRecordId, FIELD_IDS.reportSentBy, record.sent_by);
        }

        let execSnapshot: any = null;
        try {
          const { data: draft } = await supabase
            .schema("reports")
            .from("drafts")
            .select("payload")
            .eq("tenant_id", record.tenant_id)
            .eq("programme_id", record.programme_id)
            .eq("month", record.month)
            .order("saved_at", { ascending: false })
            .limit(1)
            .maybeSingle();
          execSnapshot = draft?.payload?._meta?.execSnapshot ?? null;
        } catch (e) {
          console.warn("execSnapshot lookup failed (non-fatal):", e);
        }

        const comment = formatReportSentComment(record, execSnapshot);
        const tasks = await findTasksForRecord(REPORTING_LIST, apexoneRecordId);
        for (const task of tasks) {
          await clickupFetch(`/task/${task.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "complete" }),
          });
          await postComment(task.id, comment);
        }
      }
    }

    // UPDATE with archived_at newly set = report archived → ensure task is "complete"
    if (table === "reports" && type === "UPDATE" && record.archived_at && !old_record?.archived_at) {
      if (record.programme_id) {
        const apexoneRecordId = `programmes:${record.programme_id}`;
        const comment = formatReportArchivedComment(record);
        const tasks = await findTasksForRecord(REPORTING_LIST, apexoneRecordId);
        for (const task of tasks) {
          await clickupFetch(`/task/${task.id}`, {
            method: "PUT",
            body: JSON.stringify({ status: "complete" }),
          });
          await postComment(task.id, comment);
        }
      }
    }

    if (type === "DELETE" && (table === "clients" || table === "programmes")) {
      await closeTasksForRecord(`${table}:${record.id}`);
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    const errMsg = String(err);
    const recordId = record?.id != null ? String(record.id) : null;
    await logFailure({ sourceTable: table, operation: type, recordId, errMsg });
    return new Response(JSON.stringify({ ok: false, error: errMsg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
