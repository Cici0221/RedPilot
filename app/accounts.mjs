import { id, now, InputError, str, sourceUrl, validateSettings } from './content.mjs';

export const defaultSettings = () => ({ enabled: false, time: '10:00', timezone: 'Asia/Shanghai', mode: 'automatic', imageShare: 70 });
export const defaultReportSettings = () => ({ enabled:true,time:'09:00',timezone:'Asia/Shanghai',lastDailyKey:null });
export const unfinished = job => ['scheduled', 'blocked', 'publishing', 'uncertain'].includes(job.status);

export function accountById(state, accountId = state.defaultAccountId, allowArchived = false) {
  const account = state.accounts.find(item => item.id === accountId);
  if (!account) throw new InputError('账号不存在', 404);
  if (account.archived && !allowArchived) throw new InputError('账号已归档，请选择其他账号', 409);
  return account;
}

export function syncDefaultSettings(state) {
  const account = accountById(state, state.defaultAccountId);
  state.settings = account.settings;
  state.lastDailyKey = account.lastDailyKey;
}

export function migrateAccounts(state, legacyBridgeAccountId = '') {
  if (!Array.isArray(state.accounts) || !state.accounts.length) {
    const account = {
      id: id(), name: '官方账号', type: 'official', handle: '', profileUrl: '', notes: '',
      bridgeAccountId: legacyBridgeAccountId, enabled: true, archived: false,
      settings: state.settings || defaultSettings(), lastDailyKey: state.lastDailyKey || null,
      createdAt: now(), updatedAt: now()
    };
    state.accounts = [account];
    state.defaultAccountId = account.id;
    // Submitted jobs retain the original external account instead of following an env change.
    for (const job of state.jobs) {
      let target = account;
      if (job.account) {
        target = state.accounts.find(item => item.bridgeAccountId === job.account);
        if (!target) {
          target = { ...account, id: id(), name: '历史账号', type: 'personal',
            bridgeAccountId: job.account, enabled: false, settings: defaultSettings(), lastDailyKey: null };
          state.accounts.push(target);
        }
      }
      job.accountId = target.id;
      job.accountName = target.name;
    }
    for (const draft of state.drafts) {
      const priorJob = state.jobs.find(job => job.draftId === draft.id && job.status !== 'cancelled');
      draft.accountId = priorJob?.accountId || account.id;
    }
  }
  for (const account of state.accounts) {
    account.settings = { ...defaultSettings(), ...account.settings };
    account.dailyHistory ||= [];
    account.contentMix ||= { imageShare: account.settings.imageShare, total: 0, imageCount: 0 };
    account.reportSettings = {...defaultReportSettings(),...account.reportSettings};
  }
  state.schemaVersion = 3;
  syncDefaultSettings(state);
  return state;
}

export function validateAccount(input, current = null) {
  const value = { ...current, ...input };
  const type = value.type ?? 'personal';
  if (!['official', 'personal'].includes(type)) throw new InputError('账号类型不正确');
  const enabled = value.enabled ?? true;
  if (typeof enabled !== 'boolean') throw new InputError('账号启停状态不正确');
  return {
    name: str(value.name, 80, true), type,
    handle: str(value.handle || '', 100), profileUrl: sourceUrl(value.profileUrl || ''),
    notes: str(value.notes || '', 2000), bridgeAccountId: str(value.bridgeAccountId || '', 200), enabled
  };
}

export function createAccount(state, input) {
  const account = { ...validateAccount(input), id: id(), archived: false,
    settings: defaultSettings(), reportSettings:defaultReportSettings(), dailyHistory: [], contentMix: { imageShare: 70, total: 0, imageCount: 0 }, lastDailyKey: null, createdAt: now(), updatedAt: now() };
  ensureUniqueMapping(state, account);
  state.accounts.push(account);
  return account;
}

function ensureUniqueMapping(state, account) {
  if (account.bridgeAccountId && state.accounts.some(item => item.id !== account.id && item.bridgeAccountId === account.bridgeAccountId)) {
    throw new InputError('这个发布账号 ID 已被其他记录使用，请检查现有账号', 409);
  }
}

export function updateAccount(state, accountId, input) {
  const account = accountById(state, accountId);
  const updated = { ...account, ...validateAccount(input, account), updatedAt: now() };
  ensureUniqueMapping(state, updated);
  if (updated.bridgeAccountId !== account.bridgeAccountId && state.jobs.some(job =>
    job.accountId === account.id && ((account.bridgeAccountId && unfinished(job)) || job.attempts > 0 || job.account))) {
    throw new InputError('账号存在排期或已提交的发布记录，不能更换发布账号 ID；请新建账号', 409);
  }
  Object.assign(account, updated);
  return account;
}

export function setDefaultAccount(state, accountId) {
  accountById(state, accountId);
  state.defaultAccountId = accountId;
  syncDefaultSettings(state);
}

export function archiveAccount(state, accountId) {
  const account = accountById(state, accountId);
  if (state.defaultAccountId === accountId) throw new InputError('请先设置其他默认账号', 409);
  if (state.jobs.some(job => job.accountId === accountId && unfinished(job))) {
    throw new InputError('账号有未完成的发布任务，请先取消排期或核对结果', 409);
  }
  account.archived = true;
  account.enabled = false;
  account.settings.enabled = false;
  account.updatedAt = now();
  return account;
}

export function saveAccountSettings(state, accountId, input) {
  const account = accountById(state, accountId);
  const setting = validateSettings({ ...account.settings, ...input });
  if (setting.imageShare !== account.settings.imageShare) account.contentMix = { imageShare: setting.imageShare, total: 0, imageCount: 0 };
  account.settings = setting;
  account.updatedAt = now();
  syncDefaultSettings(state);
  return account.settings;
}
