import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SECRETS = [
  Deno.env.get("WEBHOOK_SECRET"),f
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

  # ApexOne `ai-generate` Security Hardening and Rollout Brief

## Goal

Harden `supabase/functions/ai-generate/index.ts` before continuing front-end AI rollout. Preserve all currently working AI types, Gemini 3.5 Flash-Lite, retry/backoff, QCTO context, and trusted internal `pg_net`/cron calls.

Do not merge until the function is deployed, regression-tested, and the committed source matches the deployed source.

## Non-negotiable security rules

1. Remove the `isAnonAuth` bypass. The Supabase anon/publishable key is public and must never count as authentication.
2. Browser calls require a real Supabase access-token JWT in `Authorization: Bearer <access_token>`.
3. Trusted internal calls may use `WEBHOOK_SECRET` or `FAM_CRON_SECRET`, but only when supplied through the dedicated secret header or an exact secret bearer token.
4. Never use the service-role client for browser reads. A browser request must use a Supabase client carrying the caller's JWT so RLS applies.
5. Never trust IDs alone. RLS, tenant scope, and owner scope must decide whether the caller can access a record.
6. `smart_write` is admin-only, uses an explicit table and field allowlist, requires tenant/ownership checks, and cannot execute from `confirmed: true` alone.
7. Keep `smart_write` UI last. Every write must show a preview, then require a server-issued, one-time confirmation token.
8. The stray `f` after `Deno.env.get("WEBHOOK_SECRET"),` must not exist in the real file. Remove it if present.

## Required auth implementation

Replace the current anonymous-key auth block with this pattern:

```ts
const authClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_ANON_KEY")!,
);

type RequestAuth = {
  internal: boolean;
  user: any | null;
  userDb: ReturnType<typeof createClient>;
};

async function authenticateRequest(req: Request): Promise<RequestAuth> {
  const authHeader = req.headers.get("authorization") || "";
  const bearer = authHeader.replace(/^Bearer\\s+/i, "").trim();
  const webhookSecret = req.headers.get("x-webhook-secret")?.trim();

  const internalSecret = webhookSecret || bearer;
  if (internalSecret && SECRETS.includes(internalSecret)) {
    return { internal: true, user: null, userDb: supabase };
  }

  if (!bearer) throw new Error("A signed-in user session is required");

  const { data, error } = await authClient.auth.getUser(bearer);
  if (error || !data.user) throw new Error("Invalid or expired user session");

  const userDb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: `Bearer ${bearer}` } } },
  );

  return { internal: false, user: data.user, userDb };
}

function userRoles(user: any): string[] {
  const role = user?.app_metadata?.role;
  if (Array.isArray(role)) return role.map(String);
  return role ? [String(role)] : [];
}

function isAdmin(user: any): boolean {
  return userRoles(user).includes("admin");
}
```

Do not compare the caller's bearer token to `SUPABASE_ANON_KEY`. Delete this logic entirely:

```ts
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const isAnonAuth = secret && secret === anonKey;
```

## Read-query migration

Every generator currently using `supabase.from(...)` must be changed to accept a database client parameter and use that client for all reads:

```ts
async function generateExecutiveSummary(db = supabase) {
  const { data } = await db.from("learners").select("*");
  // ...
}
```

For browser requests, call generators with `auth.userDb`. For trusted internal calls, use the service-role `supabase` client.

Example router pattern:

```ts
const auth = await authenticateRequest(req);

if (!auth.internal && type === "smart_write" && !isAdmin(auth.user)) {
  return j({ ok: false, error: "smart_write is admin-only" }, 403);
}

if (type !== "smart_write") {
  result = await generateExecutiveSummary(auth.userDb);
}
```

Do not leave browser generators calling the service-role client. If a generator cannot yet be converted safely, return a clear 403 rather than exposing it.

## Router requirements

Preserve these types:

- `report_narrative`
- `visit_report`
- `document_extract`
- `programme_summary`
- `learner_progress`
- `risk_assessment`, with `client_id` for client scope or no ID for the system scan
- `resolution_summary`
- `recommendation_draft`
- `executive_summary`
- `attendance_analysis`
- `eisa_readiness_check`
- `poe_gap_analysis`
- `fam_compliance_digest`
- `narrative_polish`
- `smart_write`

Validate required IDs and reject malformed values before querying. Do not allow arbitrary table names, RPC names, filters, or SQL from the request body.

## Fix known data issues while touching the file

- Use `full_name` first for assessors, then JSONB fallbacks.
- Use one canonical client-name helper everywhere, including risk assessment.
- Resolve programme relationships from both typed foreign keys and `fields.Programme` string arrays.
- Do not compare a numeric client ID to a JSONB client-name field. Resolve by typed `client_id` first, then exact client-name fallback.
- Treat status from `status`, `programme_status`, or `fields.Status`, with an explicit normalisation helper.
- For system risk scans, build latest visits from both `programme_id` and every ID in `fields.Programme`.
- Count EISA module completion only for explicit accepted result values. Do not treat arbitrary non-empty values such as `Pending` or `NYC` as complete.
- Keep KMA domains exactly as follows:
  - KMA1: Programme Implementation
  - KMA2: Human Resources
  - KMA3: Assessment Strategy
  - KMA4: Progress on Implementation
  - KMA5: General Responsiveness
  - KMA6: E-learning
- Keep scores and source figures exact. AI must not invent or round facts.

## `smart_write` requirements

Use an allowlist such as:

```ts
const SMART_WRITE_RULES = {
  monitoring_visits: { insert: ["tenant_id", "programme_id", "fields"], update: ["fields"] },
  recommendations: { insert: ["tenant_id", "programme_id", "fields"], update: ["fields"] },
  fam_follow_ups: { insert: ["tenant_id", "assessor_id", "action_required", "due_date", "status"], update: ["action_required", "due_date", "status"] },
  fam_seta_registrations: { insert: ["tenant_id", "assessor_id", "seta_name", "role", "registration_status", "registration_expiry_date"], update: ["registration_status", "registration_expiry_date", "seta_name", "role"] },
  fam_documents: { insert: ["tenant_id", "assessor_id", "document_type"], update: ["document_type", "is_current"] },
  attendance: { insert: ["tenant_id", "programme_id", "learner_id", "status"], update: ["status"] },
} as const;
```

Do not accept arbitrary columns from the client. Reject unknown fields. Do not allow changing `tenant_id`, owner fields, audit fields, or record identity during updates.

Preview flow:

1. Validate the table, action, fields, role, tenant, ownership, and AI enrichment.
2. Return the proposed change and a short-lived, one-time server-issued confirmation token.
3. On the second request, require the token, bind it to the authenticated user, table, action, record, and payload hash.
4. Consume the token before performing the write.
5. Write only the allowlisted fields through the caller-scoped client where RLS must apply.
6. Return the created or updated record and an audit reference.

Do not treat `confirmed: true` as sufficient confirmation. Do not store confirmation tokens in source code or client-visible permanent storage.

## CORS and errors

Keep CORS restricted to the deployed ApexOne origins if practical. Do not use wildcard CORS for authenticated data operations unless there is a documented reason. Return generic authentication and permission errors to callers; log diagnostic detail server-side only.

## Testing checklist

Before opening or updating the PR:

- Unauthenticated request returns 401.
- Request with only the public anon key returns 401.
- Expired or invalid JWT returns 401.
- Valid user JWT can read only records permitted by RLS and owner/tenant rules.
- Cross-owner record access is rejected or returns no record.
- Internal secret calls still work for `pg_net` and cron.
- Existing AI types return 200 for an authorised test user.
- `executive_summary` and system `risk_assessment` still return valid output.
- `resolution_summary` still returns valid output.
- `smart_write` preview returns no database mutation.
- `smart_write` without a server-issued token is rejected.
- Reusing a consumed confirmation token is rejected.
- Non-admin smart writes are rejected.
- Unknown tables and fields are rejected.
- Tenant/ownership checks are enforced on insert and update.
- Retry/backoff remains active for Gemini 429 and 503 responses.
- Deployed source and committed source are byte-for-byte equivalent, or the difference is documented.

## Deployment and handoff

1. Patch the full `index.ts`, not a placeholder.
2. Run TypeScript/syntax checks.
3. Deploy the complete function.
4. Run the regression and security tests above.
5. Commit the exact deployed source to the existing branch.
6. Open a PR for review. Do not merge.
7. Report the deployed version, tests run, remaining limitations, and any frontend calls that must temporarily wait for the JWT-scoped migration.

## Important

Do not continue with new tab integrations until this hardening is complete. The current function contains a service-role client behind an anon-key bypass, which is an access-control flaw even if the current tenant is small.
