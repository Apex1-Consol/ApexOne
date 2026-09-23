import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";

// ── Per-request privacy context ────────────────────────────────────────────
// The Gemini free tier may use prompts to improve Google products and its terms
// say not to send personal information. So every person's name is swapped for a
// neutral code ([Learner 1], [Person 2]…) before a prompt is built, and swapped
// back in the model's reply. Company/programme names are not personal and stay.
// The context also records every prompt so numbers in replies can be checked.
type ReqCtx = { fwd: Map<string, string>; back: Map<string, string>; counters: Record<string, number>; refText: string[]; unverified: Set<string> };
const reqCtx = new AsyncLocalStorage<ReqCtx>();
const PLACEHOLDER_RE = /^(Learner|Assessor|Programme|Client|Person) \d+$/;

function alias(name: unknown, kind = "Person"): string {
  const ctx = reqCtx.getStore();
  const n = String(name ?? "").trim();
  if (!ctx || !n || n === "N/A" || n === "-" || PLACEHOLDER_RE.test(n)) return n;
  const key = n.toLowerCase();
  let code = ctx.fwd.get(key);
  if (!code) {
    ctx.counters[kind] = (ctx.counters[kind] || 0) + 1;
    code = `[${kind} ${ctx.counters[kind]}]`;
    ctx.fwd.set(key, code);
    ctx.back.set(code, n);
  }
  return code;
}

function unalias(text: string): string {
  const ctx = reqCtx.getStore();
  if (!ctx || !ctx.back.size || !text) return text;
  // Longest codes first so "[Learner 12]" is not clipped by "[Learner 1]".
  const codes = [...ctx.back.keys()].sort((a, b) => b.length - a.length);
  for (const code of codes) {
    const bare = code.slice(1, -1).replace(/ /g, "\\s*");
    // Accept the code with or without its brackets (models sometimes drop them).
    text = text.replace(new RegExp(`\\[?${bare}\\]?(?!\\d)`, "g"), ctx.back.get(code)!);
  }
  return text;
}

// Numbers the model states that appear nowhere in what it was given.
// Cheap, deterministic, no extra AI call. Flags possible invented figures.
function checkNumbers(output: string, reference: string) {
  const ctx = reqCtx.getStore();
  if (!ctx) return;
  const strip = (t: string) => t.replace(/\[(Learner|Assessor|Person|Programme|Client) \d+\]/g, " ").replace(/\b(Learner|Person|Assessor) \d+\b/g, " ");
  const norm = (x: string) => x.replace(",", ".").replace(/\.0+$/, "");
  const refNums = new Set((strip(reference).match(/\d+(?:[.,]\d+)?/g) || []).map(norm));
  for (const raw of strip(output).match(/\d+(?:[.,]\d+)?/g) || []) {
    const n = norm(raw);
    if (Number(n) <= 10 && !n.includes(".")) continue; // list numbering, small counts, KMA 1-6 etc.
    if (!refNums.has(n)) ctx.unverified.add(raw);
  }
}

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

// Inbound machine secrets. The service-role key is deliberately NOT accepted here:
// it is a database master key and must never double as an API credential.
const SECRETS = [
    Deno.env.get("WEBHOOK_SECRET"),
    Deno.env.get("FAM_CRON_SECRET"),
  ].filter(Boolean);

const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

const authClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!
  );

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

const QCTO_SYSTEM_CONTEXT = `You are an AI assistant for ApexU, a South African QCTO-accredited training provider.
Terminology: SDP = Skills Development Provider, SETA = Sector Education and Training Authority,
EISA = External Integrated Summative Assessment, KMA = Key Monitoring Area (1-6),
PoE = Portfolio of Evidence, MOU = Memorandum of Understanding, PM = Project Manager.
KMA domains: 1=Programme Implementation, 2=Human Resources, 3=Assessment Strategy,
4=Progress on Implementation, 5=General Responsiveness, 6=E-learning (N/A if not applicable).
KMA scores: 1=Non-compliant, 2=Partially compliant, 3=Mostly compliant, 4=Fully compliant.
Overall Judgment scores: 1=Unacceptable, 2=Not Yet Adequate, 3=Adequate, 4=Outstanding.
Write professionally but clearly. Use South African English. Be specific with numbers.
Flag risks directly. Do not hedge or use filler.`;

function todaySAST(): string {
    return new Intl.DateTimeFormat("en-ZA", { timeZone: "Africa/Johannesburg", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
}

async function callGemini(prompt: string, systemInstruction: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<string> {
    // Anchor every prompt to the real date so narratives don't invent or mis-state dates.
    systemInstruction = `${systemInstruction}\nToday's date is ${todaySAST()} (South African time). Use it for any relative date reasoning; never invent dates that are not in the data.\nPeople are referred to by codes in square brackets such as [Learner 1] or [Person 2]. Always refer to them by exactly that code, including the brackets.`;
    if (!GEMINI_API_KEY) throw Error("GEMINI_API_KEY not configured");
    const maxAttempts = 3;
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                            system_instruction: { parts: [{ text: systemInstruction }] },
                            contents: [{ parts: [{ text: prompt }] }],
                            generationConfig: {
                                        temperature: 0.3,
                                        maxOutputTokens: opts.maxTokens || 4096,
                                        ...(opts.json ? { responseMimeType: "application/json" } : {}),
                            },
                  }),
          });
          if (res.status === 503 || res.status === 429) {
                  const body = await res.json().catch(() => ({}));
                  lastErr = Error(`Gemini API ${res.status}: ${JSON.stringify(body)}`);
                  if (attempt < maxAttempts) {
                            await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
                            continue;
                  }
                  if (res.status === 429) throw new HttpError(429, "The free AI quota is used up for now. Please try again later or tomorrow.");
                  throw lastErr;
          }
          const body = await res.json();
          if (!res.ok) throw Error(`Gemini API ${res.status}: ${JSON.stringify(body)}`);
          const out = body.candidates?.[0]?.content?.parts?.[0]?.text || "";
          if (!opts.json) checkNumbers(out, prompt + "\n" + systemInstruction);
          return opts.json ? out : unalias(out);
    }
    throw lastErr || Error("Gemini API failed after retries");
}

function attendancePct(rows: any[]): { pct: number | null; present: number; total: number } {
    const total = rows.length;
    if (!total) return { pct: null, present: 0, total: 0 };
    const present = rows.filter((r: any) => {
          const s = String(r.status || "").trim().toUpperCase();
          return s === "PRESENT" || s === "P";
    }).length;
    return { pct: Math.round((present / total) * 1000) / 10, present, total };
}

function programmeLabel(p: any): string {
    return p.programme_name || p.fields?.Qualification || p.fields?.Client || `Programme ${p.id}`;
}

function learnerLabel(l: any): string {
    const name = [l.first_name, l.last_name].filter(Boolean).join(" ").trim();
    return name || l.fields?.["First Name"] || `Learner ${l.id}`;
}

async function getProgrammesForClient(clientId: number) {
    const { data: byId } = await supabase.from("programmes").select("*").eq("client_id", clientId);
    if (byId && byId.length) return byId;
    const { data: client } = await supabase.from("clients").select("client_name").eq("id", clientId).single();
    if (!client?.client_name) return [];
    const { data: byName } = await supabase.from("programmes").select("*").eq("fields->>Client", client.client_name);
    return byName || [];
}

async function generateReportNarrative(clientId: number) {
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("*")
      .eq("id", clientId)
      .single();
    if (cErr || !client) throw Error(`Client ${clientId} not found: ${cErr?.message}`);

  const clientName = client.fields?.Name || client.fields?.name || `Client ${clientId}`;

  const { data: programmes } = await supabase
      .from("programmes")
      .select("*")
      .or(`fields->>Client.eq.${clientId},fields->>client_id.eq.${clientId}`);

  const progIds = (programmes || []).map((p: any) => String(p.id));

  const { data: enrolments } = await supabase
      .from("enrolments")
      .select("*")
      .in("programme_id", progIds.map(Number));

  const { data: visits } = await supabase
      .from("monitoring_visits")
      .select("*");
    const clientVisits = (visits || []).filter((v: any) => {
          const vProgs = v.fields?.Programme || [];
          return vProgs.some((pid: string) => progIds.includes(pid));
    });

  const { data: recs } = await supabase
      .from("recommendations")
      .select("*");
    const clientRecs = (recs || []).filter((r: any) => {
          const rProgs = r.fields?.Programme || [];
          return rProgs.some((pid: string) => progIds.includes(pid));
    });

  const { data: attendance } = await supabase
      .from("attendance")
      .select("*");
    const clientAttendance = (attendance || []).filter((a: any) => {
          return progIds.includes(String(a.programme_id));
    });

  const system = `You are a professional QCTO compliance report writer for ApexU, a South African training provider.
  Write in formal but clear English. Use South African QCTO terminology.
  Structure: Executive Summary, Programme Overview, Monitoring & Compliance, Learner Progress, Recommendations & Risks, Conclusion.
  Be specific with numbers. Flag risks clearly. Keep it under 800 words.`;

  const prompt = `Generate a monthly client progress report for ${clientName}.

  Data:
  - Programmes: ${(programmes || []).length} active
  ${(programmes || []).map((p: any) => `  - ${p.fields?.Name || p.fields?.name || 'Programme ' + p.id} (Type: ${p.fields?.Type || 'N/A'})`).join('\n')}
  - Enrolments: ${(enrolments || []).length} total
    - Active: ${(enrolments || []).filter((e: any) => e.fields?.Status === 'Active').length}
      - Completed: ${(enrolments || []).filter((e: any) => e.fields?.Status === 'Completed').length}
        - Withdrawn: ${(enrolments || []).filter((e: any) => e.fields?.Status === 'Withdrawn').length}
        - Monitoring Visits: ${clientVisits.length}
        ${clientVisits.map((v: any) => `  - ${v.fields?.['Date of Visit'] || 'No date'}: Overall ${v.fields?.Overall || 'N/A'}/4, KMA scores: ${['KMA1','KMA2','KMA3','KMA4','KMA5','KMA6'].map(k => v.fields?.[k] || '-').join(', ')}`).join('\n')}
        - Open Recommendations: ${clientRecs.filter((r: any) => r.fields?.Status !== 'Resolved').length} of ${clientRecs.length}
        ${clientRecs.filter((r: any) => r.fields?.Status !== 'Resolved').map((r: any) => `  - ${r.fields?.Recommendation || r.fields?.recommendation || 'N/A'} (${r.fields?.Priority || 'Normal'})`).join('\n')}
        - Attendance Records: ${clientAttendance.length}
        - MOU Status: ${client.fields?.['MOU Status'] || 'N/A'}
        - Contact: ${alias(client.fields?.['Contact Person'] || 'N/A')}`;

  const narrative = await callGemini(prompt, system);
    return { client: clientName, narrative, data_summary: { programmes: (programmes || []).length, enrolments: (enrolments || []).length, visits: clientVisits.length, open_recs: clientRecs.filter((r: any) => r.fields?.Status !== 'Resolved').length } };
}

async function generateVisitReport(visitId: number) {
    const { data: visit, error: vErr } = await supabase
      .from("monitoring_visits")
      .select("*")
      .eq("id", visitId)
      .single();
    if (vErr || !visit) throw Error(`Visit ${visitId} not found: ${vErr?.message}`);

  const f = visit.fields || {};
    const progId = f.Programme?.[0];
    let progName = f["Programme Name"]?.[0] || "Unknown Programme";

  if (progId) {
        const { data: prog } = await supabase.from("programmes").select("fields").eq("id", Number(progId)).single();
        if (prog) progName = prog.fields?.Name || prog.fields?.name || progName;
  }

  const system = `You are a QCTO monitoring visit report writer. Write a structured visit report following South African QCTO standards.
  KMA domains: 1=Programme Implementation, 2=Human Resources, 3=Assessment Strategy, 4=Progress on Implementation, 5=General Responsiveness, 6=E-learning (N/A if not applicable).
  KMA scores: 1=Non-compliant, 2=Partially compliant, 3=Mostly compliant, 4=Fully compliant.
  Overall Judgment scores: 1=Unacceptable, 2=Not Yet Adequate, 3=Adequate, 4=Outstanding.
  Structure: Visit Summary, KMA Analysis (per domain), Learner Statistics, Overall Assessment, Recommendations, Next Steps.
  Flag any KMA below 3 as requiring attention. Be specific and actionable.`;

  const prompt = `Generate a monitoring visit report:
  - Programme: ${progName}
  - Date: ${f["Date of Visit"] || "N/A"}
  - Venue: ${f.Venue || "N/A"}
  - QCTO Personnel: ${alias(f["QCTO Personnel"] || "N/A")}
  - KMA1 (Programme Implementation): ${f.KMA1 || "-"}/4
  - KMA2 (Human Resources): ${f.KMA2 || "-"}/4
  - KMA3 (Assessment Strategy): ${f.KMA3 || "-"}/4
  - KMA4 (Progress on Implementation): ${f.KMA4 || "-"}/4
  - KMA5 (General Responsiveness): ${f.KMA5 || "-"}/4
  - KMA6 (E-learning): ${f.KMA6 || "-"}/4
  - Overall Judgment: ${f["Overall Judgment"] || "-"}/4
  - EISA Readiness: ${f["EISA Readiness"] || "N/A"}
  - Logbook Status: ${f["Logbook Status"] || "N/A"}
  - MOU Signed: ${f["MOU Signed"] ? "Yes" : "No"}
  - Learners Enrolled: ${f["Learners Enrolled"] ?? "N/A"}
  - Learners on Course for EISA: ${f["Learners on Course for EISA"] ?? "N/A"}
  - Dropouts: ${f["Dropouts"] ?? "N/A"}${f["Dropout Reasons"] ? ` (${f["Dropout Reasons"]})` : ""}
  - Special Needs Count: ${f["Special Needs Count"] ?? "N/A"}
  - Knowledge Facilitator: ${alias(f["Knowledge Facilitator"] || "N/A")}
  - Practical Facilitator: ${alias(f["Practical Facilitator"] || "N/A")}
  - Workplace Mentor: ${alias(f["Workplace Mentor"] || "N/A")}
  - Next Monitoring Date: ${f["Next Monitoring Date"] || "N/A"}`;

  const report = await callGemini(prompt, system);
    return { visit_id: visitId, programme: progName, date: f["Date of Visit"], report };
}

async function generateDocExtract(assessorId: number) {
    const { data: assessor, error: aErr } = await supabase
      .from("assessors")
      .select("*")
      .eq("id", assessorId)
      .single();
    if (aErr || !assessor) throw Error(`Assessor ${assessorId} not found: ${aErr?.message}`);

  const { data: docs } = await supabase
      .from("fam_documents")
      .select("*")
      .eq("assessor_id", assessorId);

  const { data: regs } = await supabase
      .from("fam_seta_registrations")
      .select("*")
      .eq("assessor_id", assessorId);

  const { data: followups } = await supabase
      .from("fam_follow_ups")
      .select("*")
      .eq("assessor_id", assessorId);

  const name = assessor.full_name || assessor.fields?.Name || assessor.fields?.name || `Assessor ${assessorId}`;

  const system = `You are a compliance analyst reviewing FAM (Facilitator/Assessor/Moderator) practitioner documents for a South African training provider.
  Summarize the compliance status. Flag gaps: missing documents, expired registrations, unresolved follow-ups.
  Be direct and actionable. Output a structured compliance summary with a risk rating (Green/Amber/Red).`;

  const prompt = `Compliance review for: ${alias(name, "Assessor")}

  Documents on file (${(docs || []).length}):
  ${(docs || []).map((d: any) => `- ${d.document_type}: uploaded ${d.uploaded_at || 'N/A'}, verified: ${d.verified ? 'Yes' : 'No'}`).join('\n') || '- None'}

  SETA Registrations (${(regs || []).length}):
  ${(regs || []).map((r: any) => `- ${r.seta_name} | Role: ${r.role} | Status: ${r.registration_status} | Expires: ${r.registration_expiry_date || 'N/A'}`).join('\n') || '- None'}

  Open Follow-ups (${(followups || []).filter((f: any) => f.status !== 'resolved').length}):
  ${(followups || []).filter((f: any) => f.status !== 'resolved').map((f: any) => `- ${f.action_required} (due: ${f.due_date || 'N/A'})`).join('\n') || '- None'}

  Overall assessor status: ${assessor.fields?.Status || 'Unknown'}`;

  const summary = await callGemini(prompt, system);
    return { assessor: name, doc_count: (docs || []).length, reg_count: (regs || []).length, summary };
}

async function generateProgrammeSummary(programmeId: number) {
    const { data: programme, error: pErr } = await supabase.from("programmes").select("*").eq("id", programmeId).single();
    if (pErr || !programme) throw Error(`Programme ${programmeId} not found: ${pErr?.message}`);
    const progName = programmeLabel(programme);

  const { data: enrolments } = await supabase.from("enrolments").select("*").eq("programme_id", programmeId);
    const { data: attendance } = await supabase.from("attendance").select("status").eq("programme_id", programmeId);
    const { data: eisaRows } = await supabase.from("eisa").select("*").eq("programme_id", programmeId);
    const { data: visits } = await supabase.from("monitoring_visits").select("*").eq("programme_id", programmeId).order("id", { ascending: false });
    const { data: recs } = await supabase.from("recommendations").select("*").eq("programme_id", programmeId);

  const att = attendancePct(attendance || []);
    const latestVisit = (visits || [])[0];
    const enrolStatus: Record<string, number> = {};
    for (const e of enrolments || []) enrolStatus[e.status || "unknown"] = (enrolStatus[e.status || "unknown"] || 0) + 1;
    const openRecs = (recs || []).filter((r: any) => !r.resolved);

  const system = QCTO_SYSTEM_CONTEXT + `\nSummarize a training programme's overall health for a project manager. Structure: Overview, Enrolment & Attendance, Monitoring & Compliance, EISA Progress, Risks & Recommendations. Keep it under 500 words.`;

  const prompt = `Programme: ${progName} (id ${programmeId})
  Qualification: ${programme.qualification_name || programme.fields?.Qualification || "N/A"}
  Type: ${programme.programme_type || programme.fields?.Type || "N/A"}
  Status: ${programme.status || programme.programme_status || "N/A"}

  Enrolments (${(enrolments || []).length} total): ${Object.entries(enrolStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}
  Attendance: ${att.pct !== null ? `${att.pct}% (${att.present}/${att.total} records present)` : "no records"}
  EISA: ${(eisaRows || []).length} module records tracked

  Latest monitoring visit: ${latestVisit ? `${latestVisit.fields?.["Date of Visit"] || "no date"}, Overall ${latestVisit.fields?.["Overall Judgment"] || latestVisit.fields?.Overall || "N/A"}/4, KMA1-6: ${["KMA1","KMA2","KMA3","KMA4","KMA5","KMA6"].map((k) => latestVisit.fields?.[k] || "-").join(",")}` : "no visits recorded"}
  Total visits: ${(visits || []).length}

  Recommendations: ${openRecs.length} open of ${(recs || []).length} total
  ${openRecs.map((r: any) => `- ${r.fields?.Text || "N/A"} (due ${r.fields?.["Due Date"] || "N/A"})`).join("\n") || "- none open"}`;

  const narrative = await callGemini(prompt, system);
    return {
          programme: progName,
        narrative,
          data_summary: {
                  enrolments: (enrolments || []).length,
                  enrolment_status: enrolStatus,
                  attendance_pct: att.pct,
                  eisa_records: (eisaRows || []).length,
                  visits: (visits || []).length,
                  open_recommendations: openRecs.length,
          },
    };
}

async function generateLearnerProgress(learnerId: number) {
    const { data: learner, error: lErr } = await supabase.from("learners").select("*").eq("id", learnerId).single();
    if (lErr || !learner) throw Error(`Learner ${learnerId} not found: ${lErr?.message}`);
    const name = learnerLabel(learner);

  const { data: enrolments } = await supabase.from("enrolments").select("*").eq("learner_id", learnerId);
    const progIds = (enrolments || []).map((e: any) => e.programme_id).filter(Boolean);
    const { data: programmes } = progIds.length ? await supabase.from("programmes").select("id, programme_name, fields").in("id", progIds) : { data: [] };
    const progNameById: Record<number, string> = {};
    for (const p of programmes || []) progNameById[p.id] = programmeLabel(p);

  const { data: attendance } = await supabase.from("attendance").select("status").eq("learner_id", learnerId);
    const att = attendancePct(attendance || []);

  const { data: poe } = await supabase.from("poe_checklist").select("*").eq("learner_id", learnerId);
    let poeReceived = 0, poeTotal = 0;
    for (const row of poe || []) {
          try {
                  const marks = typeof row.fields?.Marks === "string" ? JSON.parse(row.fields.Marks) : (row.fields?.Marks || {});
                  const vals = Object.values(marks);
                  poeTotal += vals.length;
                  poeReceived += vals.filter((v: any) => String(v).toLowerCase() === "received").length;
          } catch { /* skip malformed */ }
    }

  const { data: eisaRows } = await supabase.from("eisa").select("*").eq("learner_id", learnerId);

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite an individual learner progress report for a project manager. Structure: Enrolment Status, Attendance, Portfolio of Evidence, EISA Readiness, Overall Assessment. Keep it under 350 words.`;

  const prompt = `Learner: ${alias(name, "Learner")}
  Employment: ${learner.fields?.Employment || "N/A"}

  Enrolments (${(enrolments || []).length}):
  ${(enrolments || []).map((e: any) => `- ${progNameById[e.programme_id] || "Programme " + e.programme_id}: ${e.status}`).join("\n") || "- none"}

  Attendance: ${att.pct !== null ? `${att.pct}% (${att.present}/${att.total})` : "no records"}
  PoE: ${poeTotal ? `${poeReceived}/${poeTotal} items received` : "no PoE records"}
  EISA module records: ${(eisaRows || []).length}
  ${(eisaRows || []).map((r: any) => `- Module ${r.module_number}: KM=${r.km_result || "-"}, PM=${r.pm_result || "-"}, WM=${r.wm_result || "-"}, Exam v1=${r.exam_v1_result || "-"} (${r.exam_v1_pct || "-"}%)`).join("\n") || ""}`;

  const narrative = await callGemini(prompt, system);
    return {
          learner: name,
          narrative,
          data_summary: { enrolments: (enrolments || []).length, attendance_pct: att.pct, poe_received: poeReceived, poe_total: poeTotal, eisa_records: (eisaRows || []).length },
    };
}

async function generateRiskAssessment(clientId: number) {
    const { data: client, error: cErr } = await supabase.from("clients").select("*").eq("id", clientId).single();
    if (cErr || !client) throw Error(`Client ${clientId} not found: ${cErr?.message}`);

  const programmes = await getProgrammesForClient(clientId);
    const progIds = programmes.map((p: any) => p.id);

  const risks: any[] = [];
    for (const p of programmes) {
          const { data: visits } = await supabase.from("monitoring_visits").select("*").eq("programme_id", p.id).order("id", { ascending: false }).limit(1);
          const { data: attendance } = await supabase.from("attendance").select("status, learner_id").eq("programme_id", p.id);
          const { data: recs } = await supabase.from("recommendations").select("*").eq("programme_id", p.id);
          const att = attendancePct(attendance || []);
          const openRecs = (recs || []).filter((r: any) => !r.resolved);
          const overdueRecs = openRecs.filter((r: any) => r.fields?.["Due Date"] && new Date(r.fields["Due Date"]) < new Date());
          const latestVisit = (visits || [])[0];
          const lowKma = latestVisit ? ["KMA1","KMA2","KMA3","KMA4","KMA5","KMA6"].filter((k) => Number(latestVisit.fields?.[k]) > 0 && Number(latestVisit.fields?.[k]) < 3) : [];
          const daysSinceVisit = latestVisit?.fields?.["Date of Visit"] ? Math.floor((Date.now() - new Date(latestVisit.fields["Date of Visit"]).getTime()) / 86400000) : null;
          // Individual learners below 70% attendance, even when the programme average is fine.
          const byLearner: Record<number, any[]> = {};
          for (const a of attendance || []) if (a.learner_id) (byLearner[a.learner_id] ||= []).push(a);
          const lowIds = Object.keys(byLearner).map(Number).filter((id) => { const x = attendancePct(byLearner[id]).pct; return x !== null && x < 70; });
          const { data: lowLearners } = lowIds.length ? await supabase.from("learners").select("id, first_name, last_name, fields").in("id", lowIds) : { data: [] };
          const lowNameById: Record<number, string> = {};
          for (const l of lowLearners || []) lowNameById[l.id] = learnerLabel(l);
          const learnersBelow70 = lowIds.map((id) => ({ learner: lowNameById[id] || `Learner ${id}`, pct: attendancePct(byLearner[id]).pct }))
            .sort((a, b) => (a.pct ?? 0) - (b.pct ?? 0));

      risks.push({
              programme: programmeLabel(p),
              attendance_pct: att.pct,
              open_recommendations: openRecs.length,
              overdue_recommendations: overdueRecs.length,
              low_kma_domains: lowKma,
              days_since_last_visit: daysSinceVisit,
              learners_below_70: learnersBelow70,
              flags: [
                        att.pct !== null && att.pct < 70 ? "low attendance" : null,
                        learnersBelow70.length > 0 ? `${learnersBelow70.length} learner(s) below 70% attendance` : null,
                        overdueRecs.length > 0 ? "overdue recommendations" : null,
                        lowKma.length > 0 ? "low KMA score(s)" : null,
                        daysSinceVisit !== null && daysSinceVisit > 60 ? "stale monitoring (60+ days)" : null,
                        daysSinceVisit === null ? "no monitoring visit on record" : null,
                      ].filter(Boolean),
      });
    }

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite a risk assessment for a client's training programme portfolio. Rate overall client risk Green/Amber/Red and explain why. List the specific programmes and issues driving the rating. Call out individual learners below 70% attendance even when the programme average is acceptable. Keep it under 500 words.`;

  const prompt = `Client: ${client.client_name} (id ${clientId})
  MOU Status: ${client.fields?.["MOU Status"] || "N/A"}
  Programmes assessed: ${risks.length}

  ${risks.map((r) => `- ${r.programme}: attendance ${r.attendance_pct ?? "N/A"}%, ${r.open_recommendations} open recs (${r.overdue_recommendations} overdue), low KMAs: ${r.low_kma_domains.join(",") || "none"}, last visit ${r.days_since_last_visit === null ? "never" : r.days_since_last_visit + " days ago"}, learners below 70% attendance: ${r.learners_below_70.length ? r.learners_below_70.map((l: any) => `${alias(l.learner, "Learner")} ${l.pct}%`).join(", ") : "none"}. Flags: ${r.flags.join("; ") || "none"}`).join("\n")}`;

  const narrative = await callGemini(prompt, system);
    return { client: client.client_name, narrative, programmes: risks };
}

function _riskRating(count: number, amberAt: number, redAt: number): string {
      if (count >= redAt) return "Red";
      if (count >= amberAt) return "Amber";
      return "Green";
}

async function generateSystemRiskScan() {
      const today = new Date();
      const in60 = new Date(today.getTime() + 60 * 86400000).toISOString().slice(0, 10);

    const [{ data: recs }, { data: expiringRegs }, { data: programmes }] = await Promise.all([
                supabase.from("recommendations").select("*"),
                supabase.from("fam_seta_registrations").select("*, assessors(full_name)").not("registration_expiry_date", "is", null).lte("registration_expiry_date", in60),
                supabase.from("programmes").select("id, programme_name, fields, status, programme_status"),
              ]);

    const overdueRecs = (recs || []).filter((r: any) => !r.resolved && r.fields?.["Due Date"] && new Date(r.fields["Due Date"]) < today);
      const activeProgrammes = (programmes || []).filter((p: any) => {
                  const status = p.status || p.programme_status || p.fields?.Status;
                  return status !== "Completed";
      });
      const progIds = activeProgrammes.map((p: any) => p.id);
      const { data: visits } = progIds.length
            ? await supabase.from("monitoring_visits").select("*").in("programme_id", progIds).order("id", { ascending: false })
                  : { data: [] };
      const latestVisitByProg: Record<number, any> = {};
      for (const v of visits || []) {
                  if (v.programme_id && !latestVisitByProg[v.programme_id]) latestVisitByProg[v.programme_id] = v;
      }
      const staleProgrammes = activeProgrammes.filter((p: any) => {
                  const v = latestVisitByProg[p.id];
                  const d = v?.fields?.["Date of Visit"];
                  if (!d) return true;
                  return Math.floor((today.getTime() - new Date(d).getTime()) / 86400000) > 60;
      });
      const categories = [
        {
                        category: "Overdue Recommendations",
                        count: overdueRecs.length,
                        rating: _riskRating(overdueRecs.length, 1, 5),
                        detail: overdueRecs.slice(0, 5).map((r: any) => r.fields?.Text || r.fields?.Recommendation || "untitled").join("; "),
        },
        {
                        category: "FAM Registrations Expiring (60d)",
                        count: (expiringRegs || []).length,
                        rating: _riskRating((expiringRegs || []).length, 1, 5),
                        detail: (expiringRegs || []).slice(0, 5).map((r: any) => alias(r.assessors?.full_name || `assessor ${r.assessor_id}`, "Assessor")).join(", "),
        },
        {
                        category: "Stale Programmes (no visit 60d+)",
                        count: staleProgrammes.length,
                        rating: _riskRating(staleProgrammes.length, 1, 4),
                        detail: staleProgrammes.slice(0, 5).map((p: any) => programmeLabel(p)).join(", "),
        },
                ];
      const system = QCTO_SYSTEM_CONTEXT + `\nWrite a short (150-200 word) system-wide risk narrative for training-provider leadership, based on traffic-light categories (Green/Amber/Red). Call out Red and Amber items directly by name and recommend the single most urgent action. Do not repeat the raw counts already shown on the cards — focus on what to do about them.`;

    const prompt = `System-wide risk scan:
        ${categories.map((c) => `- ${c.category} [${c.rating}]: ${c.count}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")}`;

    const narrative = await callGemini(prompt, system);
      return { narrative, risks: categories };
}

async function generateResolutionSummary() {
    const { data: recs } = await supabase.from("recommendations").select("*");
    const today = new Date();
    const resolved = (recs || []).filter((r: any) => r.resolved);
    const open = (recs || []).filter((r: any) => !r.resolved);
    const overdue = open.filter((r: any) => r.fields?.["Due Date"] && new Date(r.fields["Due Date"]) < today);

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite a quarterly-review narrative summarizing recommendation resolution across the whole system, for training-provider leadership. Structure: Overview, Resolved Highlights, Open & Overdue Items, Trend/Pattern Observations. Keep it under 450 words.`;

  const prompt = `Recommendation resolution summary:
  - Total recommendations: ${(recs || []).length}
  - Resolved: ${resolved.length}
  - Open: ${open.length}
  - Overdue (open, past due date): ${overdue.length}

  Sample resolved (up to 8): ${resolved.slice(0, 8).map((r: any) => r.fields?.Text || r.fields?.Recommendation || "untitled").join("; ") || "none"}
  Sample open (up to 8): ${open.slice(0, 8).map((r: any) => `${r.fields?.Text || r.fields?.Recommendation || "untitled"} (due ${r.fields?.["Due Date"] || "N/A"})`).join("; ") || "none"}`;

  const narrative = await callGemini(prompt, system);
    return {
          narrative,
          data_summary: { total: (recs || []).length, resolved: resolved.length, open: open.length, overdue: overdue.length },
    };
}

async function generateRecommendationDraft(visitId: number, kmaDomain: string, score: number) {
    const { data: visit, error: vErr } = await supabase.from("monitoring_visits").select("*").eq("id", visitId).single();
    if (vErr || !visit) throw Error(`Visit ${visitId} not found: ${vErr?.message}`);
    const f = visit.fields || {};
    let progName = f["Programme Name"]?.[0] || `Programme ${visit.programme_id ?? ""}`;
    if (visit.programme_id) {
          const { data: prog } = await supabase.from("programmes").select("fields").eq("id", Number(visit.programme_id)).single();
          if (prog) progName = prog.fields?.Qualification || prog.fields?.Name || prog.fields?.name || progName;
    }

  const domainNames: Record<string, string> = {
        KMA1: "Programme Implementation", KMA2: "Human Resources", KMA3: "Assessment Strategy",
        KMA4: "Progress on Implementation", KMA5: "General Responsiveness", KMA6: "E-learning",
  };
    const domainLabel = domainNames[kmaDomain] || kmaDomain;

  const system = QCTO_SYSTEM_CONTEXT + `\nDraft ONE specific, actionable QCTO monitoring recommendation in 1-3 sentences, addressed to the training provider, based on a low KMA score. Also propose a priority (High/Medium/Low) and a realistic due date (as an offset like "+30 days" or "+60 days" from the visit date). Return as plain text in this exact format:
  Recommendation: <text>
  Priority: <High|Medium|Low>
  Due: <+N days>`;

  const prompt = `Visit for ${progName}, date ${f["Date of Visit"] || "N/A"}.
  Domain: ${kmaDomain} (${domainLabel}), score ${score}/4 (1=Non-compliant, 2=Partially compliant, 3=Mostly compliant, 4=Fully compliant).
  Venue: ${f.Venue || "N/A"}
  QCTO Personnel: ${alias(f["QCTO Personnel"] || "N/A")}
  Logbook Status: ${f["Logbook Status"] || "N/A"}`;

  const draft = await callGemini(prompt, system);
    return { visit_id: visitId, kma_domain: kmaDomain, domain_label: domainLabel, score, draft };
}

async function generateExecutiveSummary() {
    const [{ count: learnerCount }, { count: activeProgCount }, { data: enrolments }, { data: recs }, { data: expiringRegs }] = await Promise.all([
          supabase.from("learners").select("*", { count: "exact", head: true }),
          supabase.from("programmes").select("*", { count: "exact", head: true }).eq("status", "active"),
          supabase.from("enrolments").select("status"),
          supabase.from("recommendations").select("resolved"),
          supabase.from("fam_seta_registrations").select("registration_expiry_date").not("registration_expiry_date", "is", null).lte("registration_expiry_date", new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10)),
        ]);

  const enrolStatus: Record<string, number> = {};
    for (const e of enrolments || []) enrolStatus[e.status || "unknown"] = (enrolStatus[e.status || "unknown"] || 0) + 1;
    const openRecs = (recs || []).filter((r: any) => !r.resolved).length;

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite a whole-system executive snapshot for a training provider's leadership. Structure: Headline Numbers, Programme Health, Compliance Status, Top Risks. Keep it under 400 words.`;

  const prompt = `System-wide snapshot:
  - Total learners: ${learnerCount ?? "N/A"}
  - Active programmes: ${activeProgCount ?? "N/A"}
  - Enrolments (${(enrolments || []).length} total): ${Object.entries(enrolStatus).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}
  - Open recommendations: ${openRecs} of ${(recs || []).length}
  - FAM SETA registrations expiring within 60 days: ${(expiringRegs || []).length}`;

  const narrative = await callGemini(prompt, system);
    return {
          narrative,
          data_summary: {
                  total_learners: learnerCount ?? 0,
                  active_programmes: activeProgCount ?? 0,
                  enrolment_status: enrolStatus,
                  open_recommendations: openRecs,
                  expiring_registrations_60d: (expiringRegs || []).length,
          },
    };
}

async function generateAttendanceAnalysis(programmeId: number) {
    const { data: programme, error: pErr } = await supabase.from("programmes").select("*").eq("id", programmeId).single();
    if (pErr || !programme) throw Error(`Programme ${programmeId} not found: ${pErr?.message}`);
    const progName = programmeLabel(programme);

  const { data: attendance } = await supabase.from("attendance").select("*").eq("programme_id", programmeId);
    const { data: enrolments } = await supabase.from("enrolments").select("learner_id").eq("programme_id", programmeId);
    const learnerIds = (enrolments || []).map((e: any) => e.learner_id).filter(Boolean);
    const { data: learners } = learnerIds.length ? await supabase.from("learners").select("id, first_name, last_name, fields").in("id", learnerIds) : { data: [] };
    const nameById: Record<number, string> = {};
    for (const l of learners || []) nameById[l.id] = learnerLabel(l);

  const byLearner: Record<number, any[]> = {};
    for (const a of attendance || []) {
          if (!a.learner_id) continue;
          (byLearner[a.learner_id] ||= []).push(a);
    }
    const perLearner = Object.entries(byLearner).map(([id, rows]) => {
          const att = attendancePct(rows);
          return { learner: nameById[Number(id)] || `Learner ${id}`, pct: att.pct, present: att.present, total: att.total };
    }).sort((a, b) => (a.pct ?? 100) - (b.pct ?? 100));
    const atRisk = perLearner.filter((l) => l.pct !== null && l.pct < 70);
    const overall = attendancePct(attendance || []);

  if (!overall.total) return { programme: progName, narrative: "", no_data: true, overall_pct: null, at_risk_count: 0, per_learner: [] };

  const system = QCTO_SYSTEM_CONTEXT + `\nAnalyse attendance trends for a programme. Structure: Overall Trend, At-Risk Learners, Projected Completion Impact, Recommended Actions. Keep it under 400 words.`;

  const prompt = `Programme: ${progName}
  Overall attendance: ${overall.pct ?? "N/A"}% (${overall.present}/${overall.total} records)
  Learners tracked: ${perLearner.length}
  At-risk (<70%): ${atRisk.length}
  ${perLearner.slice(0, 20).map((l) => `- ${alias(l.learner, "Learner")}: ${l.pct ?? "N/A"}% (${l.present}/${l.total})`).join("\n")}`;

  const narrative = await callGemini(prompt, system);
    return { programme: progName, narrative, overall_pct: overall.pct, at_risk_count: atRisk.length, per_learner: perLearner };
}

async function generateEisaReadinessCheck(programmeId: number) {
    const { data: programme, error: pErr } = await supabase.from("programmes").select("*").eq("id", programmeId).single();
    if (pErr || !programme) throw Error(`Programme ${programmeId} not found: ${pErr?.message}`);
    const progName = programmeLabel(programme);

  const { data: eisaRows } = await supabase.from("eisa").select("*").eq("programme_id", programmeId);
    const learnerIds = [...new Set((eisaRows || []).map((r: any) => r.learner_id).filter(Boolean))];
    const { data: learners } = learnerIds.length ? await supabase.from("learners").select("id, first_name, last_name, fields").in("id", learnerIds) : { data: [] };
    const nameById: Record<number, string> = {};
    for (const l of learners || []) nameById[l.id] = learnerLabel(l);

  const byLearner: Record<number, any[]> = {};
    for (const r of eisaRows || []) {
          if (!r.learner_id) continue;
          (byLearner[r.learner_id] ||= []).push(r);
    }
    const perLearner = Object.entries(byLearner).map(([id, rows]) => {
          const complete = rows.filter((r: any) => r.km_result && r.pm_result && r.wm_result).length;
          return { learner: nameById[Number(id)] || `Learner ${id}`, modules_complete: complete, modules_total: rows.length };
    });

  if (!perLearner.length) return { programme: progName, narrative: "", no_data: true, per_learner: [] };

  const system = QCTO_SYSTEM_CONTEXT + `\nAssess EISA readiness for a programme's learners. For each learner classify as Ready / Almost Ready (say what's missing) / Not Ready (say what's needed). Then give an overall programme readiness verdict. Keep it under 500 words.`;

  const prompt = `Programme: ${progName}
  Learners with EISA records: ${perLearner.length}
  ${perLearner.map((l) => `- ${alias(l.learner, "Learner")}: ${l.modules_complete}/${l.modules_total} modules with complete KM/PM/WM results`).join("\n") || "- none"}`;

  const narrative = await callGemini(prompt, system);
    return { programme: progName, narrative, per_learner: perLearner };
}

async function generatePoeGapAnalysis(programmeId: number) {
    const { data: programme, error: pErr } = await supabase.from("programmes").select("*").eq("id", programmeId).single();
    if (pErr || !programme) throw Error(`Programme ${programmeId} not found: ${pErr?.message}`);
    const progName = programmeLabel(programme);

  const { data: poeRows } = await supabase.from("poe_checklist").select("*").eq("programme_id", programmeId);
    const learnerIds = [...new Set((poeRows || []).map((r: any) => r.learner_id).filter(Boolean))];
    const { data: learners } = learnerIds.length ? await supabase.from("learners").select("id, first_name, last_name, fields").in("id", learnerIds) : { data: [] };
    const nameById: Record<number, string> = {};
    for (const l of learners || []) nameById[l.id] = learnerLabel(l);

  const perLearner = (poeRows || []).map((row: any) => {
        let marks: Record<string, string> = {};
        try {
                marks = typeof row.fields?.Marks === "string" ? JSON.parse(row.fields.Marks) : (row.fields?.Marks || {});
        } catch { /* skip malformed */ }
        const items = Object.entries(marks);
        const missing = items.filter(([, v]) => String(v).toLowerCase() !== "received").map(([k]) => k);
        return { learner: nameById[row.learner_id] || `Learner ${row.learner_id}`, total_items: items.length, missing };
  });

  if (!perLearner.length) return { programme: progName, narrative: "", no_data: true, per_learner: [] };

  const system = QCTO_SYSTEM_CONTEXT + `\nAnalyse Portfolio of Evidence completeness for a programme. List learners with missing items and priority actions to close the gaps before EISA. Keep it under 500 words.`;

  const prompt = `Programme: ${progName}
  Learners with PoE records: ${perLearner.length}
  ${perLearner.map((l: any) => `- ${alias(l.learner, "Learner")}: ${l.total_items - l.missing.length}/${l.total_items} items complete. Missing: ${l.missing.join(", ") || "none"}`).join("\n") || "- none"}`;

  const narrative = await callGemini(prompt, system);
    return { programme: progName, narrative, per_learner: perLearner };
}

async function generateFamComplianceDigest() {
    const { data: assessors } = await supabase.from("assessors").select("*");
    const { data: allRegs } = await supabase.from("fam_seta_registrations").select("*");
    const { data: allDocs } = await supabase.from("fam_documents").select("*").eq("is_current", true);
    const { data: allFollowups } = await supabase.from("fam_follow_ups").select("*").neq("status", "resolved");

  const digest = (assessors || []).map((a: any) => {
        const regs = (allRegs || []).filter((r: any) => r.assessor_id === a.id);
        const docs = (allDocs || []).filter((d: any) => d.assessor_id === a.id);
        const followups = (allFollowups || []).filter((f: any) => f.assessor_id === a.id);
        const today = new Date();
        const expiring = regs.filter((r: any) => r.registration_expiry_date && new Date(r.registration_expiry_date) < new Date(today.getTime() + 60 * 86400000));
        const missingDocTypes = ["CV", "Highest Qualification"].filter((t) => !docs.some((d: any) => d.doc_type === t));
        let rating = "Green";
        if (expiring.length > 0 || missingDocTypes.length > 0 || followups.length > 0) rating = "Amber";
        if (regs.length === 0 || missingDocTypes.length >= 2) rating = "Red";
        return {
                assessor: a.full_name || `Assessor ${a.id}`,
                registrations: regs.length,
                expiring_60d: expiring.length,
                documents: docs.length,
                missing_doc_types: missingDocTypes,
                open_follow_ups: followups.length,
                rating,
        };
  });

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite a compliance digest covering all FAM (Facilitator/Assessor/Moderator) practitioners. For each flagged (Amber/Red) practitioner, state the specific issue. End with a short priority action list. Keep it under 500 words.`;

  const prompt = `FAM practitioners: ${digest.length}
  ${digest.map((d: any) => `- ${alias(d.assessor, "Assessor")} [${d.rating}]: ${d.registrations} registrations (${d.expiring_60d} expiring within 60d), ${d.documents} current documents (missing: ${d.missing_doc_types.join(", ") || "none"}), ${d.open_follow_ups} open follow-ups`).join("\n")}`;

  const narrative = await callGemini(prompt, system);
    return { narrative, practitioners: digest };
}

const NARRATIVE_FIELD_LABELS: Record<string, string> = {
    att_summary: "Attendance Summary",
    eisa_summary: "EISA Summary",
    time_keeping: "Time Keeping",
    interaction: "Interaction & Participation",
    concerns: "Concerns",
};

function narrativeFieldLabel(fieldKey: string): string {
    if (fieldKey.startsWith("feedback_m")) return `Module ${fieldKey.slice("feedback_m".length)} Feedback`;
    return NARRATIVE_FIELD_LABELS[fieldKey] || fieldKey;
}

async function polishNarrative(fieldKey: string, draftText: string, facts: unknown) {
    const label = narrativeFieldLabel(fieldKey);

  const system = QCTO_SYSTEM_CONTEXT + `\nYou are rewriting one short section of a QCTO monthly programme report. You will be given a mechanically-generated draft sentence and the underlying facts it was built from. Rewrite it as natural, professional flowing prose (1-3 sentences). You MUST preserve every number, percentage, name and date exactly as given — do not round, estimate, or invent any figure not present in the draft or facts. Do not add headings, labels, or markdown. Return only the rewritten paragraph, nothing else.`;

  const prompt = `Section: ${label}
  Mechanically-generated draft: ${draftText}
  Underlying facts (for reference, do not restate as a list): ${JSON.stringify(facts ?? {})}`;

  const polished = await callGemini(prompt, system);
    return { field_key: fieldKey, label, polished: polished.trim() };
}

// ── file_extract: map an imported file's text onto report-generator fields ──
// Draft-only: returns proposed values; the browser shows them for review and
// nothing is written until the user applies them. Output is validated against
// the fields, learners and dates the browser sent, so the model can't invent targets.
const FILE_EXTRACT_MAX_CHARS = 60000;
const ATT_STATUSES = ["P", "A", "R", "N/A"];

async function fileExtract(body: any) {
  const text = String(body.text || "").slice(0, FILE_EXTRACT_MAX_CHARS);
  const fileName = String(body.file_name || "file").slice(0, 200);
  const fields: { key: string; label: string }[] = (Array.isArray(body.fields) ? body.fields : [])
    .filter((f: any) => f && typeof f.key === "string").slice(0, 40)
    .map((f: any) => ({ key: f.key, label: String(f.label || f.key).slice(0, 80) }));
  const learners: { id: string; name: string }[] = (Array.isArray(body.learners) ? body.learners : [])
    .filter((l: any) => l && l.id != null).slice(0, 400)
    .map((l: any) => ({ id: String(l.id), name: String(l.name || "").slice(0, 120) }));
  const attDates: string[] = (Array.isArray(body.att_dates) ? body.att_dates : [])
    .map(String).filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 120);
  const reportMonth = String(body.report_month || "").slice(0, 40);
  if (text.trim().length < 20) throw Error("The file contains no readable text");
  if (!fields.length) throw Error("fields required");

  const system = QCTO_SYSTEM_CONTEXT + `
You extract information from a document a project manager imported, to pre-fill a monthly QCTO programme report.
Rules:
- Only use information actually stated in the document. Never invent facts, numbers, names or dates.
- Write narrative fields as professional prose (1-4 sentences each), in the report's voice. Leave a field out if the document says nothing relevant to it.
- Learner comments: only for learners in the provided list, matched by name (allow for surname/first-name order, initials and minor spelling differences). Skip anyone you cannot match confidently.
- Attendance: only if the document contains an attendance register. Use only the provided learner ids and session dates. Status must be one of P (present), A (absent), R (reported/excused absence), N/A.
- Learner names in the document have been replaced with codes like [Learner 3]; the learner list uses the same codes. Keep the codes exactly as written.
- For every item give "source": a short verbatim quote (max 25 words) from the document that supports it, and "where": the page, sheet, row or section it came from if the text shows it (e.g. "Page 2", "Sheet Register row 14"), else "".
- If the document contradicts itself about something you are filling in (two different values for the same thing), list it in "file_conflicts" instead of guessing.
- Return JSON only, exactly this shape:
{"narratives":{"<field key>":{"text":"<text>","source":"<quote>","where":"<location>"}},"comments":{"<learner id>":{"text":"<text>","source":"<quote>","where":"<location>"}},"attendance":[{"learner_id":"<id>","date":"YYYY-MM-DD","status":"P","source":"<quote>","where":"<location>"}],"file_conflicts":["<short description>"],"notes":"<one short sentence on what the file contained and anything you could not use>"}`;

  const prompt = `Report month: ${reportMonth || "N/A"}
Narrative fields (key: label):
${fields.map((f) => `- ${f.key}: ${f.label}`).join("\n")}

Learners (id: name):
${learners.map((l) => `- ${l.id}: ${l.name}`).join("\n") || "- none"}

Attendance session dates in this report: ${attDates.join(", ") || "none"}

Imported file "${fileName}" (text extracted in the browser; names coded, ID numbers, emails and phone numbers redacted; "--- Page N ---" / "### Sheet:" markers show locations):
"""
${text}
"""`;

  const raw = await callGemini(prompt, system, { json: true, maxTokens: 8192 });
  let out: any;
  try {
    out = JSON.parse(raw.replace(/^```json\s*|```\s*$/g, "").trim());
  } catch {
    throw Error("AI response could not be read; try again or use a smaller file");
  }

  const fieldKeys = new Set(fields.map((f) => f.key));
  const learnerIds = new Set(learners.map((l) => l.id));
  const dateSet = new Set(attDates);
  // Accept either "text" or {text, source, where}; always return the object form.
  const item = (v: any, max: number) => {
    const text = typeof v === "string" ? v : typeof v?.text === "string" ? v.text : "";
    if (!text.trim()) return null;
    return { text: text.trim().slice(0, max), source: String(v?.source || "").slice(0, 300), where: String(v?.where || "").slice(0, 80) };
  };
  const narratives: Record<string, any> = {};
  for (const [k, v] of Object.entries(out?.narratives || {})) {
    const it = fieldKeys.has(k) ? item(v, 4000) : null;
    if (it) narratives[k] = it;
  }
  const comments: Record<string, any> = {};
  for (const [k, v] of Object.entries(out?.comments || {})) {
    const it = learnerIds.has(String(k)) ? item(v, 1500) : null;
    if (it) comments[String(k)] = it;
  }
  const seen = new Set<string>();
  const attendance = (Array.isArray(out?.attendance) ? out.attendance : [])
    .map((a: any) => ({ learner_id: String(a?.learner_id ?? ""), date: String(a?.date ?? ""), status: String(a?.status ?? "").toUpperCase().replace(/^NA$/, "N/A"), source: String(a?.source || "").slice(0, 200), where: String(a?.where || "").slice(0, 80) }))
    .filter((a: any) => {
      const k = `${a.learner_id}_${a.date}`;
      if (!learnerIds.has(a.learner_id) || !dateSet.has(a.date) || !ATT_STATUSES.includes(a.status) || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  return {
    file_name: fileName,
    truncated: String(body.text || "").length > FILE_EXTRACT_MAX_CHARS,
    narratives,
    comments,
    attendance,
    file_conflicts: (Array.isArray(out?.file_conflicts) ? out.file_conflicts : []).map((c: any) => String(c).slice(0, 300)).slice(0, 20),
    notes: typeof out?.notes === "string" ? out.notes.slice(0, 500) : "",
  };
}

// ── Per-user daily caps (signed-in users only; service secrets are exempt) ──
const DAILY_CAP_TOTAL = 200;
const DAILY_CAP_BY_TYPE: Record<string, number> = { file_extract: 25 };
const NO_AI_TYPES = new Set(["log_import", "usage_stats"]);

async function logImport(userId: string, details: any) {
  const d = details && typeof details === "object" ? details : {};
  const safe = {
    file_name: String(d.file_name || "").slice(0, 200),
    programme_id: d.programme_id ?? null,
    report_month: String(d.report_month || "").slice(0, 20),
    narratives: Number(d.narratives) || 0,
    comments: Number(d.comments) || 0,
    attendance: Number(d.attendance) || 0,
    suggested: Number(d.suggested) || 0,
  };
  const { error } = await supabase.from("ai_usage").insert({ user_id: userId, type: "import_applied", input_chars: 0, details: safe });
  if (error) throw Error(`Could not log import: ${error.message}`);
  return { logged: true };
}

async function usageStats() {
  const since30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const { data, error } = await supabase.from("ai_usage").select("user_id, type, input_chars, created_at").gte("created_at", since30).limit(20000);
  if (error) throw Error(error.message);
  const rows = data || [];
  const since7 = Date.now() - 7 * 86400000;
  const byType: Record<string, { d30: number; d7: number }> = {};
  const byUser: Record<string, number> = {};
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    const t = byType[r.type] ||= { d30: 0, d7: 0 };
    t.d30++;
    if (new Date(r.created_at).getTime() >= since7) t.d7++;
    if (r.type !== "import_applied") {
      byUser[r.user_id] = (byUser[r.user_id] || 0) + 1;
      const day = new Date(new Date(r.created_at).getTime() + 2 * 3600000).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + 1;
    }
  }
  const topUsers = Object.entries(byUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const users = await Promise.all(topUsers.map(async ([id, n]) => {
    const { data: u } = await supabase.auth.admin.getUserById(id);
    return { user: u?.user?.email || id.slice(0, 8), calls_30d: n };
  }));
  return {
    by_type: Object.entries(byType).map(([type, v]) => ({ type, ...v })).sort((a, b) => b.d30 - a.d30),
    top_users: users,
    by_day: Object.entries(byDay).sort().slice(-30).map(([day, calls]) => ({ day, calls })),
    caps: { daily_total_per_user: DAILY_CAP_TOTAL, daily_by_type: DAILY_CAP_BY_TYPE },
  };
}

async function checkAndLogUsage(userId: string, type: string, inputChars: number): Promise<string | null> {
  // "Day" = since midnight South African time (UTC+2, no DST).
  const now = new Date();
  const sast = new Date(now.getTime() + 2 * 3600000);
  const since = new Date(Date.UTC(sast.getUTCFullYear(), sast.getUTCMonth(), sast.getUTCDate()) - 2 * 3600000).toISOString();
  const { data, error } = await supabase.from("ai_usage").select("type").eq("user_id", userId).gte("created_at", since);
  if (error) {
    console.error("ai_usage read failed (allowing call):", error.message);
  } else {
    const rows = data || [];
    if (rows.length >= DAILY_CAP_TOTAL) return `Daily AI limit reached (${DAILY_CAP_TOTAL} requests). It resets at midnight.`;
    const typeCap = DAILY_CAP_BY_TYPE[type];
    if (typeCap && rows.filter((r: any) => r.type === type).length >= typeCap) return `Daily limit for this AI feature reached (${typeCap}). It resets at midnight.`;
  }
  const { error: insErr } = await supabase.from("ai_usage").insert({ user_id: userId, type: String(type || "unknown").slice(0, 60), input_chars: inputChars });
  if (insErr) console.error("ai_usage insert failed:", insErr.message);
  return null;
}

// smart_write (AI-validated direct DB writes) was removed on 2026-09-23: it had no
// tenant/ownership checks or one-time confirmation tokens and no UI used it.
// Rebuild it with both before re-enabling.

async function handle(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") {
          return new Response(null, {
                  headers: {
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
                            "Access-Control-Allow-Methods": "POST, OPTIONS",
                  },
          });
    }
    if (req.method !== "POST") return j({ ok: false, error: "POST required" }, 405);

             const authHeader = req.headers.get("authorization");
    const secret = req.headers.get("x-webhook-secret") || authHeader?.replace(/^Bearer\s+/i, "");
    const isSecretAuth = secret && SECRETS.includes(secret);

             let verifiedUser: any = null;
    if (!isSecretAuth && secret) {
          const { data: userData } = await authClient.auth.getUser(secret);
          verifiedUser = userData?.user || null;
    }

             if (!isSecretAuth && !verifiedUser) {
                   return j({ ok: false, error: "Unauthorized" }, 401);
             }

             try {
                   const body = await req.json();
                   const { type, client_id, visit_id, assessor_id, programme_id, learner_id, kma_domain, score, table, action, data, confirmed } = body;
                   if (verifiedUser && !isSecretAuth && !NO_AI_TYPES.has(type)) {
                         const capMsg = await checkAndLogUsage(verifiedUser.id, type, typeof body.text === "string" ? body.text.length : 0);
                         if (capMsg) return j({ ok: false, error: capMsg }, 429);
                   }

      let result;
                   switch (type) {
                     case "report_narrative":
                               if (!client_id) return j({ ok: false, error: "client_id required" }, 400);
                               result = await generateReportNarrative(client_id);
                               break;
                     case "visit_report":
                               if (!visit_id) return j({ ok: false, error: "visit_id required" }, 400);
                               result = await generateVisitReport(visit_id);
                               break;
                     case "document_extract":
                               if (!assessor_id) return j({ ok: false, error: "assessor_id required" }, 400);
                               result = await generateDocExtract(assessor_id);
                               break;
                     case "programme_summary":
                               if (!programme_id) return j({ ok: false, error: "programme_id required" }, 400);
                               result = await generateProgrammeSummary(programme_id);
                               break;
                     case "learner_progress":
                               if (!learner_id) return j({ ok: false, error: "learner_id required" }, 400);
                               result = await generateLearnerProgress(learner_id);
                               break;
                     case "risk_assessment":
                                       result = client_id ? await generateRiskAssessment(client_id) : await generateSystemRiskScan();
                               break;
                     case "resolution_summary":
                               result = await generateResolutionSummary();
                               break;
                     case "recommendation_draft":
                               if (!visit_id || !kma_domain || score === undefined) return j({ ok: false, error: "visit_id, kma_domain, score required" }, 400);
                               result = await generateRecommendationDraft(visit_id, kma_domain, score);
                               break;
                     case "executive_summary":
                               result = await generateExecutiveSummary();
                               break;
                     case "attendance_analysis":
                               if (!programme_id) return j({ ok: false, error: "programme_id required" }, 400);
                               result = await generateAttendanceAnalysis(programme_id);
                               break;
                     case "eisa_readiness_check":
                               if (!programme_id) return j({ ok: false, error: "programme_id required" }, 400);
                               result = await generateEisaReadinessCheck(programme_id);
                               break;
                     case "poe_gap_analysis":
                               if (!programme_id) return j({ ok: false, error: "programme_id required" }, 400);
                               result = await generatePoeGapAnalysis(programme_id);
                               break;
                     case "fam_compliance_digest":
                               result = await generateFamComplianceDigest();
                               break;
                     case "narrative_polish": {
                               const { field_key, draft_text, facts } = body;
                               if (!field_key || !draft_text) return j({ ok: false, error: "field_key, draft_text required" }, 400);
                               result = await polishNarrative(field_key, draft_text, facts);
                               break;
                     }
                     case "file_extract": {
                               if (!body.text || !Array.isArray(body.fields)) return j({ ok: false, error: "text, fields required" }, 400);
                               result = await fileExtract(body);
                               break;
                     }
                     case "log_import": {
                               if (!verifiedUser) return j({ ok: false, error: "log_import requires a signed-in user" }, 403);
                               result = await logImport(verifiedUser.id, body.details);
                               break;
                     }
                     case "usage_stats": {
                               if (!verifiedUser || verifiedUser.app_metadata?.role !== "admin") return j({ ok: false, error: "usage_stats is admin-only" }, 403);
                               result = await usageStats();
                               break;
                     }
                     case "smart_write":
                               return j({ ok: false, error: "smart_write has been removed" }, 410);
                     default:
                               return j({ ok: false, error: `Unknown type: ${type}` }, 400);
                   }

      const unverified = [...(reqCtx.getStore()?.unverified || [])].slice(0, 20);
      return j({ ok: true, type, ...result, ...(unverified.length ? { fact_check: { unverified_numbers: unverified } } : {}) });
             } catch (err) {
                   console.error("AI generate error:", err);
                   if (err instanceof HttpError) return j({ ok: false, error: err.message }, err.status);
                   return j({ ok: false, error: String(err) }, 500);
             }
}

Deno.serve((req: Request) => reqCtx.run({ fwd: new Map(), back: new Map(), counters: {}, refText: [], unverified: new Set() }, () => handle(req)));

function j(b: any, s = 200) {
    return new Response(JSON.stringify(b), {
          status: s,
          headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
          },
    });
}
