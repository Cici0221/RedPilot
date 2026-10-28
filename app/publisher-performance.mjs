const fields = {
  impressions: '曝光数', views: '观看数', likes: '点赞数', comments: '评论数',
  collects: '收藏数', shares: '分享数', netFollowers: '净涨粉', newFollowers: '新增关注',
  unfollows: '取消关注', profileViews: '主页访客', coverClickRate: '封面点击率', videoCompletionRate: '视频完播率'
};
const number = value => {
  if (typeof value !== 'string' || !/^-?[\d,]+(?:\.\d+)?(?:万|亿)?$/.test(value)) return null;
  const multiplier = value.endsWith('万') ? 10000 : value.endsWith('亿') ? 100000000 : 1;
  const result = Number(value.replace(/[,万亿]/g,'')) * multiplier;
  return Number.isFinite(result) ? result : null;
};
const validDate = value => {try {return /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T00:00:00Z').toISOString().slice(0,10) === value;} catch {return false;}};

// Parse the displayed official dashboard only. Empty, ambiguous, or unavailable
// counters remain null; the dashboard's seven-day window is never called today.
export function parseCreatorPerformance(text, {readAt = new Date().toISOString()} = {}) {
  const body = String(text || '').slice(0,25000), summary = Object.fromEntries(Object.keys(fields).map(key => [key,null]));
  const section = body.match(/笔记数据总览([\s\S]*?)(?:最新笔记|创作话题|$)/)?.[1] || '';
  for (const [key,label] of Object.entries(fields)) {
    const matches = [...section.matchAll(new RegExp(label + '\\s*(-?[\\d,]+(?:\\.\\d+)?(?:万|亿)?)\\s*(%|％)?(?=\\s|环比|$)','g'))];
    if (matches.length === 1) {
      const value = number(matches[0][1]), rate = key.endsWith('Rate');
      if (value !== null && (value >= 0 || key === 'netFollowers') && (!rate || matches[0][2] && value <= 100)) summary[key] = value;
    }
  }
  const followers = [...body.matchAll(/(?:^|\s)([\d,]+(?:\.\d+)?(?:万|亿)?)\s*粉丝数(?=\s|$)/g)];
  summary.followers = followers.length === 1 ? number(followers[0][1]) : null;
  let period = null;
  const dates = section.match(/统计周期\s*(\d{2})-(\d{2})\s*至\s*(\d{2})-(\d{2})/);
  if (dates && Number.isFinite(Date.parse(readAt))) {
    const today = new Date(new Date(readAt).getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0,10);
    let endYear = Number(today.slice(0,4));
    if (`${endYear}-${dates[3]}-${dates[4]}` > today) endYear--;
    const end = `${endYear}-${dates[3]}-${dates[4]}`;
    const start = `${dates[1] > dates[3] ? endYear-1 : endYear}-${dates[1]}-${dates[2]}`;
    if (validDate(start) && validDate(end) && start <= end && (new Date(end)-new Date(start)) <= 366*86400000) period = {start,end};
  }
  const meaningful = Object.values(summary).some(value => value !== null);
  return {status: meaningful && period ? 'partial' : 'unavailable', period, summary, notes:[], readAt,
    sourceUrl:'https://creator.xiaohongshu.com/new/home', ...(meaningful && period ? {} : {error:'官方数据尚未完整加载，请稍后刷新'})};
}
