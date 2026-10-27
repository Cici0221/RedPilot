import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
const definitions=source.slice(0,source.indexOf("document.addEventListener('click'"));
const listeners=source.slice(source.indexOf("document.addEventListener('click'"),source.indexOf("window.addEventListener('pageshow'"));
const clone=value=>structuredClone(value);
const reply=value=>({ok:true,status:200,json:async()=>clone(value)});
class CalendarClock extends Date{constructor(...args){super(...(args.length?args:['2026-10-27T02:00:00Z']));}static now(){return new Date('2026-10-27T02:00:00Z').valueOf();}}
function fixture(){
  const draft={id:'draft-1',accountId:'official',title:'备用号的新安排',contentMode:'image',body:'正文',tags:[],gaps:[],slides:[],history:[],referenceIds:[],productAssetIds:['cover'],revision:1};
  const job=(id,scheduledAt,status='scheduled',extra={})=>({id,scheduledAt,status,accountId:'official',draftId:'draft-1',title:'任务 '+id,contentMode:'image',attempts:0,...extra});
  return {workspaceAccountId:'official',defaultAccountId:'official',accounts:[{id:'official',name:'人类补丁',enabled:true},{id:'secondary',name:'生活小号',enabled:true}],
    product:{name:'RingHi',facts:[],conditions:[],restrictions:[],sources:[]},productAssets:[{id:'cover',name:'封面',kind:'image',mime:'image/png',fileUrl:'/api/product-assets/cover/file',metadata:{}}],drafts:[draft],
    jobs:[job('before-midnight','2026-10-26T15:55:00Z'),job('after-midnight','2026-10-26T16:05:00Z'),job('midday','2026-10-27T04:00:00Z'),job('blocked','2026-10-27T05:00:00Z','blocked',{error:'连接待恢复'}),job('unknown','2026-10-27T06:00:00Z','uncertain'),job('published','2026-10-27T07:00:00Z','published',{noteUrl:'https://www.xiaohongshu.com/explore/example'}),job('cancelled','2026-10-27T08:00:00Z','cancelled'),job('failed','2026-10-27T09:00:00Z','failed',{attempts:1}),job('next-month','2026-11-02T01:00:00Z'),job('other-account','2026-10-27T01:00:00Z','scheduled',{accountId:'secondary',title:'不能出现的小号排期'}),job('invalid','bad-date')],
    inspirations:[],creators:[],events:[],discussions:[],draftGenerationJobs:[],imageJobs:[],capabilities:{accounts:{official:{publisher:false}}},imageProvider:{ready:false}};
}
function node(extra={}){return {innerHTML:'',textContent:'',hidden:false,disabled:false,open:false,dataset:{},classList:{add(){},remove(){},toggle(){}},close(){this.open=false;},querySelector(){return null;},querySelectorAll(){return [];},...extra};}
function ui({state=fixture(),handle}={}){
  const nodes={'#app':node(),'#modal':node(),'#modal-content':node(),'#toast':node(),'#draft-generation-status':node()},requests=[],events={};
  class FormDataMock{constructor(form){this.entries=Object.entries(form.values||{});}[Symbol.iterator](){return this.entries[Symbol.iterator]();}has(key){return this.entries.some(([name])=>name===key);}getAll(key){return this.entries.filter(([name])=>name===key).map(([,value])=>value);}}
  const context=vm.createContext({Date:CalendarClock,Intl,URL,Math,structuredClone,AbortSignal,console,FormData:FormDataMock,setTimeout:()=>1,clearTimeout(){},confirm:()=>true,
    document:{querySelector:s=>nodes[s]||null,querySelectorAll:()=>[],activeElement:{id:''},addEventListener:(type,handler)=>{events[type]=handler;}},location:{hash:'#calendar',replace(){}},window:{scrollTo(){}},
    fetch:async(url,options={})=>{const request={url,method:options.method||'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);const custom=await handle?.(request,state);if(custom)return custom;if(url==='/api/state')return reply(state);throw Error('Unexpected mock request '+url);}
  });
  vm.runInContext(definitions,context);context.initial=clone(state);vm.runInContext("S=initial;workspaceId='official';accountFilter='official';render=()=>{};",context);vm.runInContext(listeners,context);
  return {context,state,nodes,requests,run:code=>vm.runInContext(code,context),submit:form=>events.submit({target:form,submitter:node(),preventDefault(){}})};
}
function dayButtons(html){return [...html.matchAll(/<button\b[^>]*data-action="calendar-day"[^>]*>/g)].map(([tag])=>({tag,key:tag.match(/data-date="([^"]+)"/)?.[1]}));}

test('calendar dates use Beijing time across UTC midnight and invalid dates are excluded',()=>{
  const view=ui();assert.equal(view.run("calendarDateKey('2026-10-26T15:55:00Z')"),'2026-10-26');assert.equal(view.run("calendarDateKey('2026-10-26T16:05:00Z')"),'2026-10-27');assert.equal(view.run("calendarDateKey('not-a-date')"),'');
  const ids=Array.from(view.run("calendarJobsForDate('2026-10-27',{includeCancelled:false}).map(j=>j.id)"));
  assert.deepEqual(ids,['after-midnight','midday','blocked','unknown','published','failed']);assert.equal(view.run("calendarJobsForDate('2026-10-27').some(j=>j.id==='cancelled')"),true);
  assert.equal(view.run("calendarJobsForDate('2026-10-27').some(j=>j.id==='other-account')"),false);
});

test('month view has Monday-first natural week rows, all leap days and an actionable date grid',()=>{
  const view=ui();view.run("calendarMonth='2026-10';calendarDate='2026-10-27'");let days=dayButtons(view.run('calendar()'));assert.equal(days.length,35);assert.equal(days[0].key,'2026-09-28');assert.equal(days.at(-1).key,'2026-11-01');assert.equal(new Set(days.map(d=>d.key)).size,35);
  view.run("calendarMonth='2024-02';calendarDate='2024-02-29'");days=dayButtons(view.run('calendar()'));assert.equal(days.length,35);assert.ok(days.some(d=>d.key==='2024-02-29'));
  view.run("calendarMonth='2026-03';calendarDate='2026-03-01'");assert.equal(dayButtons(view.run('calendar()')).length,42);
});

test('selecting a day shows cover, time and valid existing job actions without cross-account content',async()=>{
  const view=ui();view.context.button={dataset:{action:'calendar-day',date:'2026-10-27'}};await view.run('action(button)');
  assert.equal(view.run('calendarDate'),'2026-10-27');const html=view.run('calendar()');
  assert.match(html,/00:05/);assert.match(html,/\/api\/product-assets\/cover\/file\?workspace=official/);assert.match(html,/data-publication-id="after-midnight"/);assert.doesNotMatch(html,/不能出现的小号排期|NaN|Invalid Date|按浏览器时区显示/);
  for(const [id,action] of [['after-midnight','job-cancel'],['blocked','job-retry'],['unknown','job-verify']])assert.match(html,new RegExp('data-action="'+action+'"[^>]*data-id="'+id+'"'));
  assert.doesNotMatch(html,/data-action="job-(?:retry|cancel)"[^>]*data-id="(?:unknown|published|cancelled|failed)"/);assert.match(html,/查看笔记/);
});

test('month navigation clamps the selected day and today returns to the Beijing current date',async()=>{
  const view=ui();view.run("calendarMonth='2026-01';calendarDate='2026-01-31'");view.context.next={dataset:{action:'calendar-month',offset:'1'}};await view.run('action(next)');assert.equal(view.run('calendarMonth'),'2026-02');assert.equal(view.run('calendarDate'),'2026-02-28');
  view.context.today={dataset:{action:'calendar-today'}};await view.run('action(today)');assert.equal(view.run('calendarMonth'),'2026-10');assert.equal(view.run('calendarDate'),'2026-10-27');
  view.context.invalid={dataset:{action:'calendar-day',date:'bad-date'}};await view.run('action(invalid)');assert.equal(view.run('calendarDate'),'2026-10-27');
});

test('report publication links select the task actual month and date, without accepting another account job',async()=>{
  const view=ui();await view.run("openReportAction({type:'publication',id:'next-month'},'official')");assert.equal(view.run('page'),'calendar');assert.equal(view.run('calendarMonth'),'2026-11');assert.equal(view.run('calendarDate'),'2026-11-02');assert.equal(view.run('calendarFocusJobId'),'next-month');
  assert.equal(view.run("focusCalendarJob('other-account')"),false);assert.equal(view.run('calendarDate'),'2026-11-02');assert.equal(view.run("focusCalendarJob('invalid')"),false);
});

test('an empty selected day is an empty calendar agenda and never borrows another date tasks',()=>{
  const view=ui();view.run("calendarMonth='2026-10';calendarDate='2026-10-30'");const html=view.run('calendar()');assert.match(html,/暂无排期/);assert.doesNotMatch(html,/data-publication-id=/);assert.match(html,/data-page="studio"/);
});

test('cancelling keeps the selected day, removes the active calendar count and retains its cancelled record',async()=>{
  const view=ui({handle:(request,state)=>{if(request.url==='/api/jobs/after-midnight/cancel'){state.jobs.find(j=>j.id==='after-midnight').status='cancelled';return reply({ok:true});}}});view.run("calendarMonth='2026-10';calendarDate='2026-10-27'");view.context.cancel={dataset:{action:'job-cancel',id:'after-midnight'},disabled:false};await view.run('action(cancel)');assert.equal(view.run('calendarDate'),'2026-10-27');assert.equal(view.run("calendarJobsForDate('2026-10-27',{includeCancelled:false}).some(j=>j.id==='after-midnight')"),false);const html=view.run('calendar()');assert.match(html,/已取消/);assert.match(html,/data-publication-id="after-midnight"/);
});

test('successful scheduling focuses the new task instead of returning to an unrelated current day',async()=>{
  const view=ui({handle:(request,state)=>{if(request.url==='/api/drafts/draft-1/schedule'){const job={id:'created-job',accountId:'official',draftId:'draft-1',title:'新排期',scheduledAt:'2026-12-05T13:30:00Z',status:'scheduled'};state.jobs.push(job);return reply(job);}}});
  await view.submit(node({id:'schedule-form',dataset:{id:'draft-1',account:'official',revision:'1'},values:{scheduledAt:'2026-12-05T21:30'}}));assert.equal(view.requests.find(r=>r.url==='/api/drafts/draft-1/schedule').body.scheduledAt,'2026-12-05T13:30:00.000Z');assert.equal(view.run('page'),'calendar');assert.equal(view.run('calendarMonth'),'2026-12');assert.equal(view.run('calendarDate'),'2026-12-05');assert.equal(view.run('calendarFocusJobId'),'created-job');
});

test('switching accounts resets calendar focus and never carries previous account tasks to the new agenda',()=>{
  const view=ui();view.run("calendarMonth='2026-11';calendarDate='2026-11-02';calendarFocusJobId='next-month'");view.context.other={...fixture(),workspaceAccountId:'secondary',jobs:fixture().jobs.filter(j=>j.accountId==='secondary')};view.run("applyWorkspaceState('secondary',other)");const html=view.run('calendar()');assert.equal(view.run('calendarFocusJobId'),'');assert.equal(view.run('calendarDate'),'2026-10-27');assert.doesNotMatch(html,/data-publication-id="next-month"/);assert.match(html,/不能出现的小号排期/);
});
