import {InputError} from './content.mjs';

export function publicOrigin(value) {
  if(!value)return null;
  let url;try{url=new URL(value);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('REDPILOT_PUBLIC_URL 必须是完整 HTTPS 域名');
  return url.origin;
}

export function requestOrigin(host,configured) {
  if(typeof host!=='string')throw new InputError('访问地址不正确',403);
  if(configured&&host===new URL(configured).host)return configured;
  if(/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))return `http://${host}`;
  throw new InputError('访问地址未配置',403);
}
