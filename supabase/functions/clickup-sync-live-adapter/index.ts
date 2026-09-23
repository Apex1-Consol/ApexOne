import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
// v15 auth: WEBHOOK_SECRET is REQUIRED on every request (x-webhook-secret header or Bearer).
// Callers: pg_cron clickup-outbox-live-adapter-poll and trigger notify_live_adapter(), both send
// Vault clickup_sync_secret (= WEBHOOK_SECRET). The service-role key is no longer accepted.
const SECRETS=[Deno.env.get("WEBHOOK_SECRET")].filter(Boolean) as string[];
const supabase=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);const CLICKUP_TOKEN=Deno.env.get("CLICKUP_API_TOKEN");const CLICKUP_BASE="https://api.clickup.com/api/v2";const MAX_ATTEMPTS=5;
const DC:Record<string,{list:string;type:string;enabled:boolean}>={
  clients:{list:"1200620000006159",type:"Client",enabled:true},
  programmes:{list:"1200620000006161",type:"Programme",enabled:true},
  program_modules:{list:"1200620000006172",type:"Module",enabled:true},
  learners:{list:"1200620000006162",type:"Learner",enabled:true},
  enrolments:{list:"1200620000006163",type:"Enrolment",enabled:true},
  attendance:{list:"1200620000006166",type:"Task",enabled:true},
  attendance_sessions:{list:"1200620000006166",type:"Task",enabled:true},
  poe_checklist:{list:"1200620000006166",type:"Task",enabled:true},
  monitoring_visits:{list:"1200620000006168",type:"Monitoring Visit",enabled:true},
  recommendations:{list:"1200620000006169",type:"Task",enabled:true},
  eisa:{list:"1200620000006170",type:"EISA Record",enabled:true},
  unit_standards:{list:"1200620000006171",type:"Assessment",enabled:true},
  assessors:{list:"1200620000006174",type:"Assessor",enabled:true},
  audit_log:{list:"1200620000006176",type:"Audit Event",enabled:true}
};
const FID={rid:"e7934dac-3578-4e7d-a460-4ec5af0f6756",rtype:"94f50f7b-d328-4500-9bcc-040adff626cd",parent:"1faca38e-d453-4255-a86e-bd42d358e147",schema:"3ac54c4b-c0bd-4934-833d-d40096173df0"};
const SYNC_EX="1200620000006175";
async function cu(path:string,init:RequestInit={}){if(!CLICKUP_TOKEN)throw Error("CLICKUP_API_TOKEN not configured");const r=await fetch(CLICKUP_BASE+path,{...init,headers:{Authorization:CLICKUP_TOKEN,"Content-Type":"application/json",...(init.headers||{})}});const b=await r.text();if(!r.ok)throw Error(`ClickUp API ${r.status}: ${b}`);return b?JSON.parse(b):null}
// v15: ClickUp status names differ per list ("completed" on Programmes, "complete" on Clients, never
// "Closed"), so pick the list's status whose TYPE is "closed", else "done". Cached per run.
async function closedStatus(listId:string,cache:Map<string,string>):Promise<string>{
  if(cache.has(listId))return cache.get(listId)!;
  const l=await cu(`/list/${listId}`);const st:any[]=l?.statuses||[];
  const pick=st.find((x:any)=>x.type==="closed")||st.find((x:any)=>x.type==="done");
  if(!pick?.status)throw Error(`ClickUp list ${listId} has no closed/done status`);
  cache.set(listId,pick.status);return pick.status}
const DELETED_TAG="deleted-in-apexone";
function resolveTitle(p:any,t:string):string{
  if(t==='learners'){const fn=p.first_name||p.fields?.['First Name']||'';const ln=p.last_name||p.fields?.['Last Name']||'';const name=(fn+' '+ln).trim();return name||`Learner ${p.id||'unknown'}`}
  if(t==='enrolments'){const ln=p.fields?.['Learner']||p.learner_id||'';const pn=p.fields?.['Programme']||p.programme_id||'';return `Enrolment: L${ln} → P${pn}`}
  if(t==='assessors')return p.full_name||p.fields?.['Full Name']||`Assessor ${p.id||'unknown'}`;
  if(t==='clients')return p.client_name||p.fields?.['Company Name']||`Client ${p.id||'unknown'}`;
  if(t==='programmes')return p.programme_name||p.fields?.['Qualification']||p.fields?.['Prog ID']||`Programme ${p.id||'unknown'}`;
  if(t==='eisa')return `EISA: L${p.learner_id||'?'} P${p.programme_id||'?'} M${p.module_number||'?'}`;
  if(t==='monitoring_visits')return p.fields?.['Visit Title']||`Monitoring Visit ${p.id||'unknown'}`;
  if(t==='attendance'||t==='attendance_sessions')return `Attendance ${p.session_date||p.id||'unknown'}`;
  if(t==='poe_checklist')return `PoE ${p.id||'unknown'}`;
  if(t==='program_modules')return p.title||`Module ${p.module_number||p.id||'unknown'}`;
  if(t==='recommendations')return p.fields?.['Text']||`Recommendation ${p.id||'unknown'}`;
  if(t==='unit_standards')return p.us_title||`US ${p.us_id||p.id||'unknown'}`;
  if(t==='audit_log')return `Audit: ${p.action||'?'} ${p.table_name||'?'}:${p.record_id||'?'}`;
  return p.name||`${t}:${p.id||'unknown'}`
}
function parentId(p:any,t:string):string|null{if(t==='programmes'&&p.client_id)return `clients:${p.client_id}`;if(t==='enrolments'&&p.programme_id)return `programmes:${p.programme_id}`;if(['attendance','attendance_sessions','poe_checklist','monitoring_visits','recommendations','eisa','program_modules'].includes(t)&&p.programme_id)return `programmes:${p.programme_id}`;return null}
async function exception(id:string,e:any,msg:string){const k=`sync-exception:${id}:${e.event_key}`;const old=await supabase.from("clickup_record_links").select("clickup_task_id").eq("source_table","sync_exceptions").eq("source_record_id",k).maybeSingle();if(old.data?.clickup_task_id)return old.data.clickup_task_id;const t=await cu(`/list/${SYNC_EX}/task`,{method:"POST",body:JSON.stringify({name:`Sync Exception: ${id}`,description:`Source: ${id}\nEvent: ${e.event_key}\nAttempts: ${e.attempts}\nError: ${msg}`})});await supabase.from("clickup_record_links").upsert({source_table:"sync_exceptions",source_record_id:k,clickup_task_id:t.id,destination_list_id:SYNC_EX,sync_state:"synced",schema_version:"v1",last_synced_at:new Date().toISOString()},{onConflict:"source_table,source_record_id"});return t.id}
Deno.serve(async(req:Request)=>{if(req.method!=="POST")return j({ok:false,error:"POST required"},405);
// Fail closed: no secret, or an unknown one, is always rejected.
const authHeader=req.headers.get("authorization");const s=req.headers.get("x-webhook-secret")||authHeader?.replace(/^Bearer\s+/i,"")||"";
if(!SECRETS.length||!s||!SECRETS.includes(s))return j({ok:false,error:"Unauthorized"},401);
const closedCache=new Map<string,string>();
const{data:es,error}=await supabase.from("clickup_sync_outbox").select("id,event_key,source_table,source_record_id,operation,payload,status,attempts").in("status",["queued","retrying"]).not("source_table","like","fam_%").order("created_at",{ascending:true}).limit(20);if(error)return j({ok:false,error:error.message},500);const out:any[]=[];for(const e of es||[]){const c=DC[e.source_table];const id=`${e.source_table}:${e.source_record_id}`;if(!c?.enabled){out.push({event_key:e.event_key,action:"held_domain_paused"});continue}if(Number(e.attempts||0)>=MAX_ATTEMPTS){const x=await exception(id,e,"Retry ceiling");await supabase.from("clickup_sync_outbox").update({status:"quarantined",last_error:"Retry ceiling",updated_at:new Date().toISOString()}).eq("id",e.id);await supabase.from("clickup_sync_attempts").insert({outbox_id:e.id,outcome:"quarantine",error_message:"Retry ceiling",clickup_task_id:x});out.push({event_key:e.event_key,action:"quarantined"});continue}
const{data:link}=await supabase.from("clickup_record_links").select("clickup_task_id").eq("source_table",e.source_table).eq("source_record_id",e.source_record_id).maybeSingle();const p=e.payload||{};const now=new Date().toISOString();await supabase.from("clickup_sync_outbox").update({status:"processing",attempts:Number(e.attempts||0)+1,locked_at:now,locked_by:"live-adapter",updated_at:now}).eq("id",e.id);
try{let taskId=link?.clickup_task_id;const name=resolveTitle(p,e.source_table);
if(e.operation==="DELETE"){
  // v15: close the linked task in its own list's closed status and tag it. Tasks are never deleted
  // in ClickUp (irreversible). A record that never got a task needs no ClickUp change.
  if(taskId){const t=await cu(`/task/${taskId}`);const lid=t?.list?.id||c.list;const cs=await closedStatus(lid,closedCache);
    await cu(`/task/${taskId}`,{method:"PUT",body:JSON.stringify({status:cs})});
    try{await cu(`/task/${taskId}/tag/${encodeURIComponent(DELETED_TAG)}`,{method:"POST"})}catch(te){console.error("tag failed",taskId,String(te))}
    out.push({event_key:e.event_key,action:"closed_deleted_task",clickup_task_id:taskId,status:cs})}
  else out.push({event_key:e.event_key,action:"delete_no_task"});
  const done=new Date().toISOString();await supabase.from("clickup_sync_outbox").update({status:"succeeded",processed_at:done,locked_at:null,locked_by:null,last_error:null,updated_at:done}).eq("id",e.id);
  if(taskId)await supabase.from("clickup_record_links").update({last_synced_at:done,last_error:null,updated_at:done}).eq("source_table",e.source_table).eq("source_record_id",e.source_record_id);
  await supabase.from("clickup_sync_attempts").insert({outbox_id:e.id,outcome:"success",clickup_task_id:taskId||null});continue}
if(!taskId){const task=await cu(`/list/${c.list}/task`,{method:"POST",body:JSON.stringify({name,description:`Source: ${id}\nParent: ${parentId(p,e.source_table)||'none'}\nFramework: ${p.programme_type||'inherited'}`})});taskId=task.id;await supabase.from("clickup_record_links").upsert({source_table:e.source_table,source_record_id:e.source_record_id,clickup_task_id:taskId,destination_list_id:c.list,sync_state:"synced",schema_version:"v1",source_url:p.source_url||null,last_synced_at:now},{onConflict:"source_table,source_record_id"});out.push({event_key:e.event_key,action:"created_new_task",clickup_task_id:taskId})}else{const patch:any={name};await cu(`/task/${taskId}`,{method:"PUT",body:JSON.stringify(patch)});out.push({event_key:e.event_key,action:"updated_existing_task",clickup_task_id:taskId})}
try{await cu(`/task/${taskId}/field/${FID.rid}`,{method:"POST",body:JSON.stringify({value:id})})}catch(e){}
try{await cu(`/task/${taskId}/field/${FID.rtype}`,{method:"POST",body:JSON.stringify({value:c.type})})}catch(e){}
try{await cu(`/task/${taskId}/field/${FID.schema}`,{method:"POST",body:JSON.stringify({value:"v1"})})}catch(e){}
const pid=parentId(p,e.source_table);if(pid){try{await cu(`/task/${taskId}/field/${FID.parent}`,{method:"POST",body:JSON.stringify({value:pid})})}catch(e){}}
const done=new Date().toISOString();await supabase.from("clickup_sync_outbox").update({status:"succeeded",processed_at:done,locked_at:null,locked_by:null,last_error:null,updated_at:done}).eq("id",e.id);await supabase.from("clickup_record_links").update({sync_state:"synced",last_synced_at:done,last_error:null,updated_at:done}).eq("source_table",e.source_table).eq("source_record_id",e.source_record_id);await supabase.from("clickup_sync_attempts").insert({outbox_id:e.id,outcome:"success",clickup_task_id:taskId})}catch(err){const msg=String(err);const n=Number(e.attempts||0)+1;const perm=n>=MAX_ATTEMPTS||msg.includes("API 400")||msg.includes("API 401")||msg.includes("API 403");let x=null;if(perm)x=await exception(id,e,msg);await supabase.from("clickup_sync_outbox").update({status:perm?"quarantined":"retrying",attempts:n,last_error:msg,locked_at:null,locked_by:null,updated_at:new Date().toISOString()}).eq("id",e.id);await supabase.from("clickup_sync_attempts").insert({outbox_id:e.id,outcome:perm?"quarantine":"retry",error_message:msg,clickup_task_id:x||link?.clickup_task_id});out.push({event_key:e.event_key,action:perm?"quarantined":"retrying",error:msg})}}
return j({ok:true,mode:"all-domains-v15-realtime",events_seen:es?.length||0,results:out})});function j(b:any,s=200){return new Response(JSON.stringify(b),{status:s,headers:{"Content-Type":"application/json"}})}
