import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCreatorPerformance} from '../app/publisher-performance.mjs';

test('official visible counters keep their own seven-day window and unknowns remain null',()=>{
 const result=parseCreatorPerformance('1 关注数 16 粉丝数 45 获赞与收藏\n笔记数据总览\n直播数据总览\n统计周期 10-21 至 10-27\n近7日\n曝光数 1,621 环比 +12369%\n观看数 313 环比 +6160%\n封面点击率 13.6\n%\n环比 -50%\n点赞数 9 环比 +800%\n评论数 6 环比 -\n收藏数 5 环比 -\n净涨粉 8 环比 -\n取消关注 0 环比 -\n最新笔记',{readAt:'2026-10-28T06:00:00Z'});
 assert.equal(result.status,'partial');assert.deepEqual(result.period,{start:'2026-10-21',end:'2026-10-27'});
 assert.equal(result.summary.impressions,1621);assert.equal(result.summary.views,313);assert.equal(result.summary.coverClickRate,13.6);assert.equal(result.summary.followers,16);
 assert.equal(result.summary.unfollows,0);assert.equal(result.summary.shares,null);assert.deepEqual(result.notes,[]);
});
test('year rollover, compact counts, duplicate labels and malformed dates are handled',()=>{
 const result=parseCreatorPerformance('笔记数据总览\n统计周期 12-27 至 01-02\n观看数 1.2万 环比 -\n点赞数 1\n点赞数 2\n最新笔记',{readAt:'2027-01-03T00:00:00Z'});
 assert.deepEqual(result.period,{start:'2026-12-27',end:'2027-01-02'});assert.equal(result.summary.views,12000);assert.equal(result.summary.likes,null);
 assert.equal(parseCreatorPerformance('笔记数据总览\n统计周期 99-99 至 99-99\n观看数 1\n最新笔记').status,'unavailable');
 assert.equal(parseCreatorPerformance('扫码登录').status,'unavailable');
});
