import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRETS = [
    Deno.env.get("WEBHOOK_SECRET"),
    Deno.env.get("FAM_CRON_SECRET"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
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

async function callGemini(prompt: string, systemInstruction: string): Promise<string> {
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
                                        maxOutputTokens: 4096,
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
                  throw lastErr;
          }
          const body = await res.json();
          if (!res.ok) throw Error(`Gemini API ${res.status}: ${JSON.stringify(body)}`);
          return body.candidates?.[0]?.content?.parts?.[0]?.text || "";
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
        - Contact: ${client.fields?.['Contact Person'] || 'N/A'}`;

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
  - QCTO Personnel: ${f["QCTO Personnel"] || "N/A"}
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
  - Knowledge Facilitator: ${f["Knowledge Facilitator"] || "N/A"}
  - Practical Facilitator: ${f["Practical Facilitator"] || "N/A"}
  - Workplace Mentor: ${f["Workplace Mentor"] || "N/A"}
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

  const prompt = `Compliance review for: ${name}

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

  const prompt = `Learner: ${name} (id ${learnerId})
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
          const { data: attendance } = await supabase.from("attendance").select("status").eq("programme_id", p.id);
          const { data: recs } = await supabase.from("recommendations").select("*").eq("programme_id", p.id);
          const att = attendancePct(attendance || []);
          const openRecs = (recs || []).filter((r: any) => !r.resolved);
          const overdueRecs = openRecs.filter((r: any) => r.fields?.["Due Date"] && new Date(r.fields["Due Date"]) < new Date());
          const latestVisit = (visits || [])[0];
          const lowKma = latestVisit ? ["KMA1","KMA2","KMA3","KMA4","KMA5","KMA6"].filter((k) => Number(latestVisit.fields?.[k]) > 0 && Number(latestVisit.fields?.[k]) < 3) : [];
          const daysSinceVisit = latestVisit?.fields?.["Date of Visit"] ? Math.floor((Date.now() - new Date(latestVisit.fields["Date of Visit"]).getTime()) / 86400000) : null;

      risks.push({
              programme: programmeLabel(p),
              attendance_pct: att.pct,
              open_recommendations: openRecs.length,
              overdue_recommendations: overdueRecs.length,
              low_kma_domains: lowKma,
              days_since_last_visit: daysSinceVisit,
              flags: [
                        att.pct !== null && att.pct < 70 ? "low attendance" : null,
                        overdueRecs.length > 0 ? "overdue recommendations" : null,
                        lowKma.length > 0 ? "low KMA score(s)" : null,
                        daysSinceVisit !== null && daysSinceVisit > 60 ? "stale monitoring (60+ days)" : null,
                        daysSinceVisit === null ? "no monitoring visit on record" : null,
                      ].filter(Boolean),
      });
    }

  const system = QCTO_SYSTEM_CONTEXT + `\nWrite a risk assessment for a client's training programme portfolio. Rate overall client risk Green/Amber/Red and explain why. List the specific programmes and issues driving the rating. Keep it under 500 words.`;

  const prompt = `Client: ${client.client_name} (id ${clientId})
  MOU Status: ${client.fields?.["MOU Status"] || "N/A"}
  Programmes assessed: ${risks.length}

  ${risks.map((r) => `- ${r.programme}: attendance ${r.attendance_pct ?? "N/A"}%, ${r.open_recommendations} open recs (${r.overdue_recommendations} overdue), low KMAs: ${r.low_kma_domains.join(",") || "none"}, last visit ${r.days_since_last_visit === null ? "never" : r.days_since_last_visit + " days ago"}. Flags: ${r.flags.join("; ") || "none"}`).join("\n")}`;

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
                        detail: (expiringRegs || []).slice(0, 5).map((r: any) => r.assessors?.full_name || `assessor ${r.assessor_id}`).join(", "),
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
  QCTO Personnel: ${f["QCTO Personnel"] || "N/A"}
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

  const system = QCTO_SYSTEM_CONTEXT + `\nAnalyse attendance trends for a programme. Structure: Overall Trend, At-Risk Learners, Projected Completion Impact, Recommended Actions. Keep it under 400 words.`;

  const prompt = `Programme: ${progName}
  Overall attendance: ${overall.pct ?? "N/A"}% (${overall.present}/${overall.total} records)
  Learners tracked: ${perLearner.length}
  At-risk (<70%): ${atRisk.length}
  ${perLearner.slice(0, 20).map((l) => `- ${l.learner}: ${l.pct ?? "N/A"}% (${l.present}/${l.total})`).join("\n")}`;

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

  const system = QCTO_SYSTEM_CONTEXT + `\nAssess EISA readiness for a programme's learners. For each learner classify as Ready / Almost Ready (say what's missing) / Not Ready (say what's needed). Then give an overall programme readiness verdict. Keep it under 500 words.`;

  const prompt = `Programme: ${progName}
  Learners with EISA records: ${perLearner.length}
  ${perLearner.map((l) => `- ${l.learner}: ${l.modules_complete}/${l.modules_total} modules with complete KM/PM/WM results`).join("\n") || "- none"}`;

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

  const system = QCTO_SYSTEM_CONTEXT + `\nAnalyse Portfolio of Evidence completeness for a programme. List learners with missing items and priority actions to close the gaps before EISA. Keep it under 500 words.`;

  const prompt = `Programme: ${progName}
  Learners with PoE records: ${perLearner.length}
  ${perLearner.map((l) => `- ${l.learner}: ${l.total_items - l.missing.length}/${l.total_items} items complete. Missing: ${l.missing.join(", ") || "none"}`).join("\n") || "- none"}`;

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
  ${digest.map((d) => `- ${d.assessor} [${d.rating}]: ${d.registrations} registrations (${d.expiring_60d} expiring within 60d), ${d.documents} current documents (missing: ${d.missing_doc_types.join(", ") || "none"}), ${d.open_follow_ups} open follow-ups`).join("\n")}`;

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

const SMART_WRITE_ALLOWED_TABLES = ["monitoring_visits", "recommendations", "fam_follow_ups", "fam_seta_registrations", "fam_documents", "attendance"];

async function smartWrite(table: string, action: string, data: any, confirmed: boolean) {
    if (!SMART_WRITE_ALLOWED_TABLES.includes(table)) throw Error(`Table ${table} not allowed for smart_write`);
    if (action !== "insert" && action !== "update") throw Error(`Action must be insert or update, got ${action}`);
    if (!data || typeof data !== "object") throw Error("data must be an object");

  const system = `You are a data validation assistant for a QCTO training provider database. Check the given record for: missing required-looking fields, invalid or inconsistent values, formatting issues (e.g. bad dates). Return ONLY valid JSON, no markdown fences: { "valid": boolean, "issues": string[], "enriched": object }. "enriched" is the same object with obvious fixes applied (e.g. trimmed whitespace, normalized date format) — do not invent data that isn't implied by the input.`;
    const validationRaw = await callGemini(`Validate this ${table} record for a ${action}: ${JSON.stringify(data)}`, system);

  let validation: any;
    try {
          const cleaned = validationRaw.replace(/^```json\s*|```\s*$/g, "").trim();
          validation = JSON.parse(cleaned);
    } catch {
          validation = { valid: true, issues: ["AI validation response could not be parsed; proceeding without enrichment"], enriched: data };
    }

  if (!confirmed) {
        return { preview: true, table, action, validation, original: data };
  }

  const writeData = validation.enriched && typeof validation.enriched === "object" ? validation.enriched : data;
    let result, error;
    if (action === "insert") {
          ({ data: result, error } = await supabase.from(table).insert(writeData).select());
    } else {
          if (!writeData.id) throw Error("update requires an id field in data");
          const { id, ...rest } = writeData;
          ({ data: result, error } = await supabase.from(table).update(rest).eq("id", id).select());
    }
    if (error) throw Error(`Write failed: ${error.message}`);
    return { written: true, table, action, result };
}

Deno.serve(async (req: Request) => {
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const isAnonAuth = secret && secret === anonKey;

             let verifiedUser: any = null;
    if (!isSecretAuth && !isAnonAuth && secret) {
          const { data: userData } = await authClient.auth.getUser(secret);
          verifiedUser = userData?.user || null;
    }

             if (!isSecretAuth && !isAnonAuth && !verifiedUser) {
                   return j({ ok: false, error: "Unauthorized" }, 401);
             }

             try {
                   const body = await req.json();
                   const { type, client_id, visit_id, assessor_id, programme_id, learner_id, kma_domain, score, table, action, data, confirmed } = body;

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
                     case "smart_write": {
                               if (!table || !action || !data) return j({ ok: false, error: "table, action, data required" }, 400);
                               if (!verifiedUser) {
                                           return j({ ok: false, error: "smart_write requires a signed-in admin user token" }, 403);
                               }
                               const role = verifiedUser.app_metadata?.role;
                               if (role !== "admin") return j({ ok: false, error: "smart_write is admin-only" }, 403);
                               result = await smartWrite(table, action, data, !!confirmed);
                               break;
                     }
                     default:
                               return j({ ok: false, error: `Unknown type: ${type}` }, 400);
                   }

      return j({ ok: true, type, ...result });
             } catch (err) {
                   console.error("AI generate error:", err);
                   return j({ ok: false, error: String(err) }, 500);
             }
});

function j(b: any, s = 200) {
    return new Response(JSON.stringify(b), {
          status: s,
          headers: {
                  "Content-Type": "application/json",
                  "Access-Control-Allow-Origin": "*",
          },
    });
}
