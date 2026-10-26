import {createHash} from 'node:crypto';
import {id,now,InputError,str,sourceUrl,dateParts,dailyKey,validateSettings,checks} from './content.mjs';
import {TREND_PLATFORMS,isOfficialTrendUrl,safeTrendFailure} from './trend-sources.mjs';
import {DAILY_REPORT_SCHEDULE,defaultReportSettings} from './accounts.mjs';

export const editorialActive=job=>['queued','running'].includes(job.status);
export const titleKey=value=>String(value||'').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,'');
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function reportSettings(input={},current={}) {
  const settings=validateSettings({...DAILY_REPORT_SCHEDULE,...input,mode:'review'});
  if(Object.entries(DAILY_REPORT_SCHEDULE).some(([key,value])=>settings[key]!==value))throw new InputError('日报固定于每天北京时间 09:00 自动生成，无需调整',409);
  return defaultReportSettings(current);
}
export function reportDate(value,timezone='Asia/Shanghai') {
  const date=value??dailyKey(new Date(),timezone);
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new InputError('日期格式应为有效的 YYYY-MM-DD');
  return date;
}
export function initEditorial(state) {
  state.trendBoards ||= [];state.trendRefreshJobs ||= [];state.topicPool ||= [];state.operationReports ||= [];state.reportJobs ||= [];state.discussions ||= [];
  state.inspirations ||= [];
  for(const topic of state.topicPool)if(!topic.referenceId)linkTopicReference(state,topic);
  const previousSchedule=state.trendSchedule||{};
  state.trendSchedule={status:'idle',lastJobId:null,lastAttemptAt:null,lastCompletedAt:null,lastError:null,...previousSchedule,...reportSettings({},previousSchedule)};
  if(!state.trendBoards.length)state.trendBoards=TREND_PLATFORMS.map(p=>({platformId:p.id,name:p.name,boardName:p.boardName,sourceUrl:p.url,status:'unavailable',items:[],fetchedAt:null,stale:false,error:'尚未刷新'}));
  for(const a of state.accounts)a.reportSettings=reportSettings({},a.reportSettings);
  for(const job of [...state.trendRefreshJobs,...state.reportJobs])if(editorialActive(job)){
    Object.assign(job,{status:'failed',error:'服务已重启，请重新生成',completedAt:now()});
    if(job.id===state.trendSchedule.lastJobId)Object.assign(state.trendSchedule,{status:'failed',lastError:'服务重启前的热榜刷新未完成，可手动刷新或等待下次定时更新',lastCompletedAt:job.completedAt});
  }
  for(const chat of state.discussions)if(chat.status==='waiting')Object.assign(chat,{status:'failed',lastError:'服务已重启，讨论结果未知；未自动重试'});
}
export function normalizeBoards(raw,previous=[]) {
  if(!Array.isArray(raw))throw new InputError('热点采集器未返回榜单列表');
  return TREND_PLATFORMS.map(platform=>{
    const value=raw.find(b=>b?.platformId===platform.id),old=previous.find(b=>b.platformId===platform.id);
    const attemptedAt=now(),status=['ready','partial','needs_login','blocked','unavailable'].includes(value?.status)?value.status:'unavailable';
    const trusted=value&&isOfficialTrendUrl(platform.id,value.sourceUrl||platform.url);
    const success=trusted&&['ready','partial'].includes(status)&&Array.isArray(value.items);
    const reasonValue=value&&(value.reasonCode!==undefined||value.error!==undefined)?value:undefined;
    if(!success)return {platformId:platform.id,name:platform.name,boardName:platform.boardName,sourceUrl:old?.sourceUrl||platform.url,
      status:trusted?status:'unavailable',items:old?.items||[],fetchedAt:old?.fetchedAt||null,attemptedAt,stale:Boolean(old?.items?.length),
      ...safeTrendFailure(value&&!trusted?'invalid_source':reasonValue,status)};
    const items=[],seen=new Set();
    for(const item of value.items.slice(0,60)){
      if(!item||typeof item.title!=='string'||!item.title.trim()||item.title.length>500||!Number.isInteger(item.rank)||item.rank<1||item.rank>10000||!isOfficialTrendUrl(platform.id,item.url))continue;
      const key=item.rank+':'+titleKey(item.title);if(seen.has(key))continue;seen.add(key);
      items.push({id:hash(platform.id+'|'+titleKey(item.title)+'|'+item.url),title:item.title.trim().slice(0,200),url:sourceUrl(item.url),rank:item.rank,heatText:typeof item.heatText==='string'?item.heatText.slice(0,120):''});
      if(items.length===30)break;
    }
    items.sort((a,b)=>a.rank-b.rank);
    if(!items.length)return {platformId:platform.id,name:platform.name,boardName:platform.boardName,sourceUrl:old?.sourceUrl||platform.url,status:'unavailable',items:old?.items||[],fetchedAt:old?.fetchedAt||null,attemptedAt,stale:Boolean(old?.items?.length),...safeTrendFailure(reasonValue||'invalid_response',status)};
    return {platformId:platform.id,name:platform.name,boardName:typeof value.boardName==='string'?value.boardName.slice(0,80):platform.boardName,
      sourceUrl:value.sourceUrl||platform.url,status:items.length===value.items.length?status:'partial',items,
      fetchedAt:validTime(value.fetchedAt)?value.fetchedAt:attemptedAt,attemptedAt,stale:false,scope:typeof value.scope==='string'?value.scope.slice(0,500):'当前可读取的榜单前30条',...(reasonValue?safeTrendFailure(reasonValue,status):{})};
  });
}

const GROUPS=[
  ['AI与智能产品',['AI','人工智能','大模型','智能体','ChatGPT','机器人','具身智能']],
  ['手机与通信',['手机','iPhone','苹果','Android','安卓','双卡','SIM','eSIM','备用号','电话','短信','通信','通话']],
  ['出境与旅行',['出国','海外','漫游','留学','出境','旅行','旅游']],
  ['消费数码',['数码','耳机','电脑','Mac','科技','硬件','智能设备']],
  ['咖啡与饮品',['咖啡','拿铁','手冲','咖啡机','茶饮']],
  ['健身与运动',['健身','跑步','运动','减脂','瑜伽']],
  ['美妆与护肤',['美妆','护肤','化妆','穿搭']],
  ['宠物',['宠物','猫咪','狗狗','养猫','养狗']],
  ['游戏',['游戏','电竞','主机']],
  ['职场与效率',['职场','办公','效率','工作','打工人']]
];
const contains=(text,term)=>/^[a-z\d]+$/i.test(term)?new RegExp('\\b'+term+'\\b','i').test(text):text.toLowerCase().includes(term.toLowerCase());
function words(value){const stop=new Set(['我们','账号','产品','内容','宣传','运营','用户','需要','使用','公司','官方','当前','方向','平台','通过','正在']);return [...new Set([...new Intl.Segmenter('zh',{granularity:'word'}).segment(value)].filter(x=>x.isWordLike&&x.segment.length>=2&&!stop.has(x.segment)).map(x=>x.segment.toLowerCase()))].slice(0,80);}
export function rankedTrends(state,account) {
  const accountText=[account.name,account.notes||''].join(' '),productText=[state.product.name,state.product.summary,...state.product.facts].join(' ');
  const accountWords=words(accountText),productWords=words(productText),groups=new Map();
  for(const board of state.trendBoards)for(const item of board.items||[]){
    const key=titleKey(item.title);if(!key)continue;
    let group=groups.get(key);if(!group){group={id:hash('trend|'+key),title:item.title,appearances:[],sources:[],sourceIds:[],updatedAt:board.fetchedAt,stale:true};groups.set(key,group);}
    const appearance={platformId:board.platformId,boardName:board.boardName,rank:item.rank,url:item.url,stale:board.stale===true,fetchedAt:board.fetchedAt};
    if(!group.appearances.some(x=>x.platformId===board.platformId&&x.url===item.url)){
      group.appearances.push(appearance);group.sources.push({title:item.title,url:item.url,platformId:board.platformId,rank:item.rank,fetchedAt:board.fetchedAt,stale:board.stale===true});group.sourceIds.push(item.id);
    }
    if(!board.stale)group.stale=false;
    if(board.fetchedAt>group.updatedAt)group.updatedAt=board.fetchedAt;
  }
  return [...groups.values()].map(group=>{
    const accountGroups=GROUPS.filter(([,terms])=>terms.some(t=>contains(accountText,t))&&terms.some(t=>contains(group.title,t))).map(([label])=>label);
    const productGroups=GROUPS.filter(([,terms])=>terms.some(t=>contains(productText,t))&&terms.some(t=>contains(group.title,t))).map(([label])=>label);
    const direct=accountWords.filter(w=>contains(group.title,w)),facts=productWords.filter(w=>contains(group.title,w));
    const score=Math.min(10,Math.min(5,accountGroups.length*2.5)+Math.min(2.5,direct.length*1.5)+Math.min(2,productGroups.length*1)+Math.min(1,facts.length*.5));
    const current=group.appearances.filter(a=>!a.stale),positions=current.length?current:group.appearances;
    return {...group,platformCount:new Set(current.map(a=>a.platformId)).size,bestRank:Math.min(...positions.map(a=>a.rank)),score:Math.round(score*10)/10,reason:accountGroups.length?'命中账号方向：'+accountGroups.join('、'):direct.length?'命中账号关键词：'+direct.slice(0,3).join('、'):productGroups.length?'关联产品资料：'+productGroups.join('、'):'与当前账号方向关联较弱',scoreMethod:'规则匹配；不是平台热度、曝光预测或AI评分'};
  }).sort((a,b)=>b.score-a.score||b.appearances.length-a.appearances.length||Math.min(...a.appearances.map(x=>x.rank))-Math.min(...b.appearances.map(x=>x.rank))||a.title.localeCompare(b.title));
}

export function editorialSources(state,input,accountId) {
  if(!Array.isArray(input)||input.length>20)throw new InputError('来源列表最多20条');
  const out=[];
  for(const value of input){
    if(!value||typeof value!=='object')throw new InputError('来源需要标题与链接');
    const title=str(value.title||'来源',200,true),url=str(value.url,4000,true);
    const internal=url.match(/^#(draft|reference)\/([a-zA-Z0-9-]+)$/);
    if(internal){const record=state[internal[1]==='draft'?'drafts':'inspirations'].find(r=>r.id===internal[2]);if(!record)throw new InputError('来源记录不存在',404);if(record.accountId&&record.accountId!==accountId||Array.isArray(record.accountIds)&&record.accountIds.length&&!record.accountIds.includes(accountId))throw new InputError('来源属于其他账号',409);out.push({title,url,kind:internal[1],id:record.id});continue;}
    const safe=sourceUrl(url);
    const trusted=TREND_PLATFORMS.some(p=>isOfficialTrendUrl(p.id,safe))||state.product.sources.includes(safe)||state.inspirations.some(r=>r.url===safe||r.canonicalUrl===safe);
    if(!trusted)throw new InputError('来源必须是已验证的平台或资料库链接');
    const source={title,url:safe};
    if(value.platformId!==undefined){if(!TREND_PLATFORMS.some(p=>p.id===value.platformId)||!isOfficialTrendUrl(value.platformId,safe))throw new InputError('来源平台与链接不匹配');source.platformId=value.platformId;}
    if(value.rank!==undefined){if(!Number.isInteger(value.rank)||value.rank<1||value.rank>10000)throw new InputError('榜单位置不正确');source.rank=value.rank;}
    if(validTime(value.fetchedAt))source.fetchedAt=value.fetchedAt;
    if(typeof value.stale==='boolean')source.stale=value.stale;
    out.push(source);
  }
  return [...new Map(out.map(s=>[(s.platformId||'')+'|'+s.url,s])).values()];
}
function linkTopicReference(state,topic) {
  // Keep legacy topic records intact. Their linked collection is account-scoped;
  // shared manual references must never be silently reassigned to one account.
  const sameAccount=reference=>reference.accountId===topic.accountId;
  let reference=state.inspirations.find(r=>sameAccount(r)&&(r.id===topic.referenceId||r.topicId===topic.id));
  if(!reference)reference=state.inspirations.find(r=>sameAccount(r)&&r.kind==='topic'&&titleKey(r.title)===titleKey(topic.title));
  const before=reference?JSON.stringify({text:reference.text,sourceLinks:reference.sourceLinks||[]}):null;
  const sources=[];
  for(const source of topic.sources||[])try{sources.push(...editorialSources(state,[source],topic.accountId));}catch{}
  const sourceLinks=[...new Map([...(reference?.sourceLinks||[]),...sources].map(source=>[(source.platformId||'')+'|'+source.url,source])).values()];
  const text='选题：'+topic.title+'\n以下仅为保存的选题和来源索引，未读取来源全文，不能据此编造事件细节、数据或产品功能。'+(sourceLinks.length?'\n'+sourceLinks.map(source=>source.title+'：'+source.url).join('\n'):'');
  if(!reference){
    reference={id:id(),kind:'topic',topicId:topic.id,accountId:topic.accountId,title:topic.title,url:'',note:'',text,tags:[],assets:[],manualAssets:[],hashes:[],creatorIds:[],userFields:{title:false,text:false,tags:false},pool:typeof topic.pool==='boolean'?topic.pool:true,status:'ready',analysis:null,method:null,scope:'已收藏选题及来源链接，未读取来源全文',uses:0,createdAt:topic.createdAt||now(),updatedAt:topic.updatedAt||now()};
    state.inspirations.unshift(reference);
  }else if(reference.kind==='topic'&&!reference.userFields?.text)reference.text=text;
  reference.sourceLinks=sourceLinks;
  if(before!==null&&before!==JSON.stringify({text:reference.text,sourceLinks}))Object.assign(reference,{analysis:null,analysisFingerprint:null,method:null,status:'ready',updatedAt:now()});
  reference.sourceIds=[...new Set([...(reference.sourceIds||[]),...(topic.sourceIds||[])])];
  reference.topicId ||= topic.id;
  topic.referenceId=reference.id;
  return reference;
}
export function addTopic(state,account,input) {
  const match=input.matchId?rankedTrends(state,account).find(m=>m.id===input.matchId):null;
  if(input.matchId&&!match)throw new InputError('热点已变化，请刷新后选择',409);
  const title=str(match?.title||input.title,200,true),sources=editorialSources(state,match?.sources||input.sources||[],account.id);
  const sourceIds=match?.sourceIds||input.sourceIds||[];
  if(!Array.isArray(sourceIds)||sourceIds.length>30||sourceIds.some(v=>typeof v!=='string'||v.length>200))throw new InputError('来源标识列表不正确');
  let topic=state.topicPool.find(t=>t.accountId===account.id&&titleKey(t.title)===titleKey(title));
  if(topic){topic.sources=[...new Map([...topic.sources,...sources].map(s=>[(s.platformId||'')+'|'+s.url,s])).values()].slice(0,20);topic.sourceIds=[...new Set([...(topic.sourceIds||[]),...sourceIds])].slice(0,30);topic.updatedAt=now();linkTopicReference(state,topic);return topic;}
  topic={id:id(),accountId:account.id,title,sources,sourceIds:[...new Set(sourceIds)],status:'saved',createdAt:now(),updatedAt:now()};state.topicPool.unshift(topic);linkTopicReference(state,topic);return topic;
}
export function queueReport(state,account,date,reason='manual',requestedAt=now()) {
  const day=reportDate(date,account.reportSettings.timezone);
  let job=state.reportJobs.find(j=>j.accountId===account.id&&j.date===day&&editorialActive(j));if(job)return job;
  job={id:id(),accountId:account.id,date:day,timezone:account.reportSettings.timezone,status:'queued',phase:'queued',reason,requestedAt:validTime(requestedAt)?requestedAt:now(),createdAt:now()};state.reportJobs.unshift(job);return job;
}
function internalSource(kind,record){return {title:(kind==='draft'?'草稿：':'参考：')+record.title,url:'#'+kind+'/'+record.id,kind,id:record.id};}
export function buildReport(state,account,day,{asOf=now()}={}) {
  const timezone=account.reportSettings.timezone,capturedAt=validTime(asOf)?new Date(asOf).toISOString():now(),cutoff=Date.parse(capturedAt),today=dailyKey(new Date(capturedAt),timezone),plans=[],discoveries=[],issues=[];
  const prior=state.operationReports.find(r=>r.accountId===account.id&&r.date===day);
  if(prior&&day<today)return structuredClone(prior);
  const mode=day<today?'historical':day>today?'future':'live';
  const snapshot={date:day,timezone,asOf:capturedAt,generatedAt:capturedAt,mode,draftCount:0,jobCount:0,referenceCount:0,sourceCount:0,readableBoardCount:0,boardCount:TREND_PLATFORMS.length,productVersion:state.product.version};
  if(mode!=='live')return {id:prior?.id||id(),accountId:account.id,date:day,timezone,status:'partial',plans:prior?.plans?.filter(p=>p.done).map(p=>structuredClone(p))||[],discoveries:[],metrics:[],issues:[mode==='historical'?'未保存该日期的日报快照，无法用当前状态还原当日运营数据':'该日期尚未到来，未生成未来的运营事实'],accountDirection:account.notes||'',method:'verified-data-rules',generatedAt:capturedAt,productVersion:state.product.version,snapshot};
  const before=value=>!validTime(value)||Date.parse(value)<=cutoff;
  const visible=record=>before(record.createdAt)&&before(record.updatedAt);
  const sameDay=value=>validTime(value)&&dailyKey(new Date(value),timezone)===day;
  const onDay=value=>sameDay(value)&&Date.parse(value)<=cutoff;
  const drafts=state.drafts.filter(d=>d.accountId===account.id&&visible(d));
  const jobs=state.jobs.filter(j=>j.accountId===account.id&&visible(j));
  const scheduled=jobs.filter(j=>j.status!=='cancelled'&&sameDay(j.scheduledAt));
  const published=jobs.filter(j=>j.status==='published'&&onDay(j.publishedAt)&&isOfficialTrendUrl('xiaohongshu',j.noteUrl));
  const pending=drafts.filter(d=>d.status==='draft'&&!d.approved);
  const publishingIssues=jobs.filter(j=>['blocked','failed','uncertain'].includes(j.status));
  const generations=(state.draftGenerationJobs||[]).filter(j=>j.accountId===account.id&&visible(j));
  const latestGenerations=new Map();for(const job of [...generations].sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))))if(!latestGenerations.has(job.requestFingerprint||job.id))latestGenerations.set(job.requestFingerprint||job.id,job);
  const generationIssues=[...latestGenerations.values()].filter(j=>j.status==='failed');
  const ownedReferences=new Set(drafts.flatMap(d=>d.referenceIds||[]));
  for(const record of [...(state.topicPool||[]),...(state.discussions||[])].filter(r=>r.accountId===account.id&&visible(r)))for(const source of record.sources||[])if(source.kind==='reference'&&source.id)ownedReferences.add(source.id);
  const direction=[account.name,account.notes||'',state.product.name,state.product.summary,...state.product.facts].join(' '),keywords=words(direction);
  const relatedReference=reference=>{
    if(reference.accountId&&reference.accountId!==account.id)return false;
    if(Array.isArray(reference.accountIds)&&reference.accountIds.length&&!reference.accountIds.includes(account.id))return false;
    if(reference.accountId===account.id||reference.accountIds?.includes(account.id)||ownedReferences.has(reference.id))return true;
    const text=[reference.title,...(reference.tags||[]),reference.analysis?.topic||'',reference.text?.slice(0,500)||''].join(' ');
    return keywords.some(word=>contains(text,word))||GROUPS.some(([,terms])=>terms.some(term=>contains(direction,term))&&terms.some(term=>contains(text,term)));
  };
  const references=state.inspirations.filter(r=>visible(r)&&before(r.pageContent?.readAt)&&relatedReference(r));
  const newReferences=references.filter(r=>onDay(r.createdAt));
  const readableBoards=state.trendBoards.filter(b=>!b.stale&&['ready','partial'].includes(b.status)&&b.items?.length&&onDay(b.fetchedAt));
  const metrics=[
    {key:'scheduled_today',label:'今日排期',value:scheduled.length,unit:'篇',detail:'本账号当天的本地发布任务，含待处理与已完成',route:'#queue'},
    {key:'published_today',label:'今日已发布',value:published.length,unit:'篇',detail:'以当天已核验的官方笔记发布记录为准',route:'#queue'},
    {key:'pending_review',label:'待核对草稿',value:pending.length,unit:'篇',detail:'本账号当前未核对的草稿',route:'#write'},
    {key:'publishing_issues',label:'发布待处理',value:publishingIssues.length,unit:'项',detail:'阻塞、失败或提交结果待核对的任务',route:'#queue'},
    {key:'generation_issues',label:'生成待处理',value:generationIssues.length,unit:'项',detail:'按相同生成请求的最新一次任务统计，已重试成功的不再计入',route:'#write'},
    {key:'new_references',label:'关联新收藏',value:newReferences.length,unit:'条',detail:'当天入库且已引用或与账号方向、产品资料相关的收藏',route:'#library'}
  ];
  const oldDone=new Map((prior?.plans||[]).map(p=>[p.key,p.done]));
  const plan=(key,title,detail,sources,extra={})=>plans.push({id:prior?.plans.find(p=>p.key===key)?.id||id(),key,title,detail,sources,done:oldDone.get(key)||false,kind:'review',priority:'normal',blockers:[],...extra});
  const action=(type,objectId,route,label)=>({type,...(objectId?{id:objectId}:{}),route,label});
  const draftForJob=job=>drafts.find(d=>d.id===job.draftId);
  const failureText={uncertain:'已提交但发布结果待核对，不能直接重发',blocked:'发布前检查未通过，需要先处理阻碍',failed:'发布任务失败，请打开记录核对原因'};
  for(const job of publishingIssues.slice(0,6)){
    const draft=draftForJob(job);
    plan('job:'+job.id,(job.status==='uncertain'?'核对发布结果：':'处理发布任务：')+(draft?.title||job.title||'未命名任务'),failureText[job.status],draft?[internalSource('draft',draft)]:[],{kind:'publishing',priority:'high',blockers:[failureText[job.status]],jobId:job.id,...(draft?{draftId:draft.id}:{}),action:action('publication',job.id,'#queue','查看发布任务')});
  }
  const generationReasons={source_failed:'链接读取失败或缺少正文截图',source_changed:'生成期间资料发生变化',ai_timeout:'AI 生成超时',ai_unconfigured:'AI 尚未配置',asset_unavailable:'所选素材不可读取',interrupted:'服务重启中断了任务',provider_error:'AI 服务未完成本次生成'};
  for(const job of generationIssues.slice(0,4)){
    const reference=references.find(r=>r.id===job.referenceId),reason=generationReasons[job.reasonCode]||'生成任务未完成';
    plan('generation:'+job.id,'重新生成：'+(reference?.title||'产品草稿'),reason+'；原收藏与输入已保留，可在创作台重试。',reference?[internalSource('reference',reference)]:[],{kind:'generation',priority:'high',blockers:[reason],generationJobId:job.id,action:action('generation',job.id,'#write','查看生成任务')});
  }
  for(const draft of pending.slice(0,6)){
    let blockers;try{blockers=checks(draft,state.product,state.productAssets||[]);}catch{blockers=['请打开草稿核对资料与格式'];}
    plan('draft:'+draft.id,'核对草稿：'+draft.title,blockers.length?`有 ${blockers.length} 项需要核对，处理后再排期。`:'已具备核对条件，确认正文和图片后再排期。',[internalSource('draft',draft)],{kind:'review',priority:blockers.length?'high':'normal',blockers,draftId:draft.id,action:action('draft',draft.id,'#draft/'+draft.id,'打开草稿')});
  }
  for(const job of scheduled.filter(j=>!['published','cancelled','blocked','failed','uncertain'].includes(j.status)).slice(0,4)){
    const draft=draftForJob(job);if(!draft)continue;const time=dateParts(new Date(job.scheduledAt),timezone);
    plan('job:'+job.id,'确认今日排期：'+draft.title,'计划 '+time.hour+':'+time.minute+'；以发布任务的实际状态为准。',[internalSource('draft',draft)],{kind:'publishing',priority:'normal',jobId:job.id,draftId:draft.id,action:action('publication',job.id,'#queue','查看发布任务')});
  }
  const needsRead=newReferences.filter(r=>r.url&&(!r.text&&!r.assets?.length||['failed','needs_login','blocked','unavailable'].includes(r.linkRead?.status)));
  for(const reference of needsRead.slice(0,3))plan('source:'+reference.id,'补齐参考内容：'+reference.title,'链接已收藏，读取完整正文或补充截图后即可直接生成草稿。',[internalSource('reference',reference)],{kind:'source',priority:'normal',blockers:[reference.linkRead?.status==='needs_login'?'需要登录来源平台':'参考正文或截图尚未就绪'],referenceId:reference.id,action:action('reference',reference.id,'#reference/'+reference.id,'打开收藏')});
  const sync=state.feishuSync,latestSync=(state.feishuJobs||[]).find(j=>visible(j)&&before(j.completedAt));
  if(sync&&['partial','failed','needs_login','blocked','unavailable'].includes(sync.status)&&before(sync.lastAttemptAt)){
    issues.push('共用产品资料同步尚未完整完成，旧快照不会被当作新实测依据');
    plan('sync:feishu','核对产品资料同步',latestSync?.documentCount?`最近一次读取了 ${latestSync.documentCount} 份文档，仍有资料需要核对。`:'检查文档登录与访问权限，补齐可供创作的产品事实。',(state.product.sources||[]).slice(0,2).map(url=>({title:'产品资料',url})),{kind:'sync',priority:'high',blockers:['部分资料未完整同步'],action:action('product',null,'#product','查看产品资料')});
  }
  const recentReferences=references.filter(r=>onDay(r.createdAt)||r.creatorIds?.length&&onDay(r.pageContent?.readAt)).sort((a,b)=>String(b.pageContent?.readAt||b.createdAt||'').localeCompare(String(a.pageContent?.readAt||a.createdAt||''))).slice(0,5);
  for(const reference of recentReferences){const creator=reference.creatorIds?.length?(state.creators||[]).find(c=>reference.creatorIds.includes(c.id)&&visible(c)):null,readable=Boolean(reference.text||reference.assets?.length);
    const reason=ownedReferences.has(reference.id)?'已被本账号的草稿或收藏引用':'按共享资料库中的账号方向与产品关键词关联';
    discoveries.push({id:hash(day+'|ref|'+reference.id),kind:creator?'creator':'reference',title:(creator?'博主动态：':'新收藏：')+reference.title,detail:(creator?creator.name+' 的关联参考已入库。':'关联参考已保存。')+(readable?'可直接结合产品事实创作，无需先做额外拆解。':'先读取链接或补充截图，再生成草稿。'),reason,nextAction:readable?'结合自有产品事实生成原创草稿':'补齐参考正文或截图',sources:[internalSource('reference',reference)],referenceId:reference.id,...(creator?{creatorId:creator.id}:{}),action:action('reference',reference.id,'#reference/'+reference.id,'打开收藏')});
  }
  for(const match of rankedTrends(state,account).filter(m=>m.score>0)){
    const sources=match.sources.filter(source=>!source.stale&&onDay(source.fetchedAt));if(!sources.length)continue;
    discoveries.push({id:hash(day+'|'+match.id),kind:'trend',title:match.title,detail:match.reason+'。先核对与 '+state.product.name+' 的实际关联，再决定是否创作。',reason:match.reason,nextAction:'收藏或直接生成草稿',score:match.score,scoreMethod:match.scoreMethod,sources,matchId:match.id,action:action('trends',match.id,'#trends','查看热点')});
    if(discoveries.filter(item=>item.kind==='trend').length>=5)break;
  }
  if(!plans.length&&discoveries.length){const first=discoveries[0];plan('topic:'+first.id,'评估选题：'+first.title,'核对账号方向与产品资料，确定一个具体使用场景。',first.sources,{discoveryId:first.id});}
  if(!plans.length&&state.product.sources.length)plan('product:'+state.product.version,'核对 '+state.product.name+' 产品资料','当前阶段：'+state.product.stage+'；确认资料是否需要更新。',state.product.sources.slice(0,2).map(url=>({title:'产品资料',url})),{kind:'source',priority:'low',action:action('product',null,'#product','查看产品资料')});
  const priority={high:0,normal:1,low:2};plans.sort((a,b)=>priority[a.priority]-priority[b.priority]);
  const visiblePlans=plans.slice(0,12);for(const previous of prior?.plans||[])if(previous.done&&!visiblePlans.some(p=>p.key===previous.key))visiblePlans.push({...structuredClone(previous),retained:true});
  if(!readableBoards.length)issues.push('该日期没有可用的热榜快照，日报仅使用本地资料');
  if(state.trendBoards.some(b=>b.stale||!['ready','partial'].includes(b.status)))issues.push('部分平台榜单未能读取，未补造数据');
  if(publishingIssues.length)issues.push(`有 ${publishingIssues.length} 个发布任务需要处理，未自动重发`);
  if(generationIssues.length)issues.push(`有 ${generationIssues.length} 个草稿生成任务未完成，原输入仍保留`);
  Object.assign(snapshot,{draftCount:drafts.length,jobCount:jobs.length,referenceCount:references.length,sourceCount:new Set([...visiblePlans,...discoveries].flatMap(item=>(item.sources||[]).map(source=>source.url))).size,readableBoardCount:readableBoards.length});
  return {id:prior?.id||id(),accountId:account.id,date:day,timezone,status:issues.length?'partial':'ready',plans:visiblePlans,discoveries,metrics,issues,
    accountDirection:account.notes||'',method:'verified-data-rules',generatedAt:capturedAt,productVersion:state.product.version,snapshot};
}

export function createDiscussion(state,account,input) {
  let title=input.title,brief=input.brief||'',sources=input.sources||[],topic=null;
  if(input.matchId){const match=rankedTrends(state,account).find(m=>m.id===input.matchId);if(!match)throw new InputError('热点已变化，请刷新后选择',409);title||=match.title;sources=match.sources;}
  if(input.topicId){topic=state.topicPool.find(t=>t.id===input.topicId);if(!topic)throw new InputError('选题不存在',404);if(topic.accountId!==account.id)throw new InputError('选题属于其他账号',409);title||=topic.title;sources=topic.sources;}
  if(input.reportId){const report=state.operationReports.find(r=>r.id===input.reportId);if(!report)throw new InputError('日报不存在',404);if(report.accountId!==account.id)throw new InputError('日报属于其他账号',409);
    const item=[...report.discoveries,...report.plans].find(d=>d.id===input.discoveryId||d.id===input.planId);if(!item)throw new InputError('日报条目已变化，请刷新后选择',409);title||=item.title;brief||=item.detail;sources=item.sources;
  }
  const session={id:id(),accountId:account.id,title:str(title,200,true),brief:str(brief,6000),sources:editorialSources(state,sources,account.id),messages:[],status:'ready',createdAt:now(),updatedAt:now()};
  if(topic){session.topicId=topic.id;topic.discussionId=session.id;}
  if(input.reportId)session.reportId=input.reportId;
  state.discussions.unshift(session);return session;
}
