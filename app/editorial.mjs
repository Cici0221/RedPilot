import {createHash} from 'node:crypto';
import {id,now,InputError,str,sourceUrl,dateParts,dailyKey,validateSettings} from './content.mjs';
import {TREND_PLATFORMS,isOfficialTrendUrl,safeTrendFailure} from './trend-sources.mjs';

export const editorialActive=job=>['queued','running'].includes(job.status);
export const titleKey=value=>String(value||'').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu,'');
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
const validTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
export function reportSettings(input={},current={}) {
  const settings=validateSettings({enabled:true,time:'09:00',timezone:'Asia/Shanghai',...current,...input,mode:'review'});
  return {enabled:settings.enabled,time:settings.time,timezone:settings.timezone,lastDailyKey:current.lastDailyKey||null};
}
export function reportDate(value,timezone='Asia/Shanghai') {
  const date=value??dailyKey(new Date(),timezone);
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T12:00:00Z'))||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)throw new InputError('日期格式应为有效的 YYYY-MM-DD');
  return date;
}
export function initEditorial(state) {
  state.trendBoards ||= [];state.trendRefreshJobs ||= [];state.topicPool ||= [];state.operationReports ||= [];state.reportJobs ||= [];state.discussions ||= [];
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
    if(internal){const record=state[internal[1]==='draft'?'drafts':'inspirations'].find(r=>r.id===internal[2]);if(!record)throw new InputError('来源记录不存在',404);if(internal[1]==='draft'&&record.accountId!==accountId)throw new InputError('草稿来源属于其他账号',409);out.push({title,url,kind:internal[1],id:record.id});continue;}
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
export function addTopic(state,account,input) {
  const match=input.matchId?rankedTrends(state,account).find(m=>m.id===input.matchId):null;
  if(input.matchId&&!match)throw new InputError('热点已变化，请刷新后选择',409);
  const title=str(match?.title||input.title,200,true),sources=editorialSources(state,match?.sources||input.sources||[],account.id);
  const sourceIds=match?.sourceIds||input.sourceIds||[];
  if(!Array.isArray(sourceIds)||sourceIds.length>30||sourceIds.some(v=>typeof v!=='string'||v.length>200))throw new InputError('来源标识列表不正确');
  let topic=state.topicPool.find(t=>t.accountId===account.id&&titleKey(t.title)===titleKey(title));
  if(topic){topic.sources=[...new Map([...topic.sources,...sources].map(s=>[(s.platformId||'')+'|'+s.url,s])).values()].slice(0,20);topic.sourceIds=[...new Set([...(topic.sourceIds||[]),...sourceIds])].slice(0,30);topic.updatedAt=now();return topic;}
  topic={id:id(),accountId:account.id,title,sources,sourceIds:[...new Set(sourceIds)],status:'saved',createdAt:now(),updatedAt:now()};state.topicPool.unshift(topic);return topic;
}
export function queueReport(state,account,date,reason='manual') {
  const day=reportDate(date,account.reportSettings.timezone);
  let job=state.reportJobs.find(j=>j.accountId===account.id&&j.date===day&&editorialActive(j));if(job)return job;
  job={id:id(),accountId:account.id,date:day,status:'queued',reason,createdAt:now()};state.reportJobs.unshift(job);return job;
}
function internalSource(kind,record){return {title:(kind==='draft'?'草稿：':'参考：')+record.title,url:'#'+kind+'/'+record.id,kind,id:record.id};}
export function buildReport(state,account,day) {
  const timezone=account.reportSettings.timezone,plans=[],discoveries=[],issues=[];
  const prior=state.operationReports.find(r=>r.accountId===account.id&&r.date===day);
  // A current board cannot reconstruct a previous day's observations. Retain
  // the already saved evidence instead of erasing it during a historic refresh.
  if(prior&&day<dailyKey(new Date(),timezone))return structuredClone(prior);
  const oldDone=new Map((prior?.plans||[]).map(p=>[p.key,p.done]));
  const plan=(key,title,detail,sources,extra={})=>plans.push({id:prior?.plans.find(p=>p.key===key)?.id||id(),key,title,detail,sources,done:oldDone.get(key)||false,...extra});
  for(const job of state.jobs.filter(j=>j.accountId===account.id&&!['cancelled','published'].includes(j.status)&&dailyKey(new Date(j.scheduledAt),timezone)===day).slice(0,3)){
    const draft=state.drafts.find(d=>d.id===job.draftId);if(draft)plan('job:'+job.id,'核对发布安排：'+job.title,'计划时间 '+dateParts(new Date(job.scheduledAt),timezone).hour+':'+dateParts(new Date(job.scheduledAt),timezone).minute+'；当前状态 '+job.status,[internalSource('draft',draft)],{draftId:draft.id});
  }
  for(const draft of state.drafts.filter(d=>d.accountId===account.id&&d.status==='draft').slice(0,2))plan('draft:'+draft.id,'完善草稿：'+draft.title,'核对产品阶段、使用条件和配图，再决定是否排期。',[internalSource('draft',draft)],{draftId:draft.id});
  const matches=rankedTrends(state,account).filter(m=>m.score>0&&!m.stale&&validTime(m.updatedAt)&&dailyKey(new Date(m.updatedAt),timezone)===day).slice(0,5);
  for(const match of matches){
    discoveries.push({id:hash(day+'|'+match.id),title:match.title,detail:match.reason+'。可先讨论与 '+state.product.name+' 的实际关联，再决定是否创作。',score:match.score,sources:match.sources.filter(s=>!s.stale&&validTime(s.fetchedAt)&&dailyKey(new Date(s.fetchedAt),timezone)===day),matchId:match.id});
  }
  for(const ref of state.inspirations.filter(r=>r.creatorIds?.length&&r.pageContent&&dailyKey(new Date(r.pageContent.readAt||r.createdAt),timezone)===day).slice(0,3))discoveries.push({id:hash(day+'|ref|'+ref.id),title:'新入库参考：'+ref.title,detail:ref.analysis?.adaptation||'已保存来源资料，可先拆解选题和表达，再结合自己的产品事实。',sources:[internalSource('reference',ref)],referenceId:ref.id});
  if(!plans.length&&discoveries.length){const first=discoveries[0];plan('topic:'+first.id,'评估选题：'+first.title,'核对账号方向与产品资料，确定一个具体使用场景。',first.sources,{discoveryId:first.id});}
  if(!plans.length&&state.product.sources.length)plan('product:'+state.product.version,'核对 '+state.product.name+' 产品资料','当前阶段：'+state.product.stage+'；确认资料是否需要更新。',state.product.sources.slice(0,2).map(url=>({title:'产品资料',url})));
  if(!state.trendBoards.some(b=>!b.stale&&['ready','partial'].includes(b.status)&&b.items.length&&validTime(b.fetchedAt)&&dailyKey(new Date(b.fetchedAt),timezone)===day))issues.push('该日期没有可用的热榜快照，日报仅使用本地资料');
  if(state.trendBoards.some(b=>b.stale||!['ready','partial'].includes(b.status)))issues.push('部分平台榜单未能读取，未补造数据');
  return {id:prior?.id||id(),accountId:account.id,date:day,status:issues.length?'partial':'ready',plans,discoveries,issues,
    accountDirection:account.notes||'',method:'verified-data-rules',generatedAt:now(),productVersion:state.product.version};
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
