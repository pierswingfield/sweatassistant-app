// Standing read-only policy. Provider protocols belong here, not in core routing.
const { getGymConfig } = require('../gyms.config');
const denied = () => Object.assign(new Error('Provider route is not permitted'), { code:'PROVIDER_WORK_DISABLED',status:403 });
const tools = Object.freeze({search_classes:'schedule:read',get_class_details:'schedule:read',get_my_bookings:'account:read',get_credits:'account:read'});
function dates(a,b,max){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(a||'')||!/^\d{4}-\d{2}-\d{2}$/.test(b||''))return false;
  const start=Date.parse(a),end=Date.parse(b);
  return Number.isFinite(start)&&new Date(start).toISOString().slice(0,10)===a&&Number.isFinite(end)&&new Date(end).toISOString().slice(0,10)===b&&end>=start&&end-start<=max*864e5;
}
function query(q,required,optional=[]){const keys=[...q.keys()];return keys.length===new Set(keys).size&&required.every(k=>q.has(k))&&keys.every(k=>required.includes(k)||optional.includes(k));}
function validate(input){
  if(!tools[input.tool]||input.scope!==tools[input.tool]||input.method!=='GET'||input.body!==null)throw denied();
  // Eligibility is attested by the app after current grant/admin checks; the
  // broker receives no duplicate feature-flag or account-secret environment.
  const gym=getGymConfig(input.gymId);if(!gym)throw denied();
  const target=new URL(input.url);
  if(target.protocol!=='https:'||target.username||target.password||target.hash||/%|\/\/|\\/.test(target.pathname))throw denied();
  const canonical=new URL(target);canonical.searchParams.sort();if(canonical.href!==input.url)throw denied();
  const q=target.searchParams, noQuery=()=>!target.search;
  const base=new URL(gym.apiBaseUrl), v2=gym.v2ApiBaseUrl&&new URL(gym.v2ApiBaseUrl);
  const under=origin=>origin&&target.origin===origin.origin&&target.pathname.startsWith(origin.pathname+'/');
  let path,allowed=false;
  if(under(base))path=target.pathname.slice(base.pathname.length);
  else if(under(v2))path=target.pathname.slice(v2.pathname.length);
  else throw denied();
  const detail=/^\/(?:events|classes)\/[A-Za-z0-9_-]{1,100}$/.test(path);
  if(gym.provider==='codexfit'){
    if(under(base))allowed=(path==='/profile'&&noQuery())||(path==='/heartbeat'&&noQuery())||
      (input.tool==='get_class_details'&&(detail||path==='/studios')&&noQuery())||
      (input.tool==='get_my_bookings'&&path==='/bookings'&&query(q,['limit','page'])&&q.get('limit')==='100'&&q.get('page')==='1');
    else allowed=input.tool==='search_classes'&&path==='/events'&&query(q,['filter[between]','sort'])&&q.get('sort')==='start_at'&&
      q.get('filter[between]').split(',').length===2&&dates(...q.get('filter[between]').split(','),7);
  } else if(gym.provider==='marianatek'){
    allowed=under(base)&&((input.tool==='get_credits'&&path==='/me/account'&&noQuery())||
      (input.tool==='get_class_details'&&detail&&noQuery())||
      (input.tool==='get_my_bookings'&&path==='/me/reservations'&&query(q,['is_upcoming','page_size'])&&q.get('is_upcoming')==='true'&&q.get('page_size')==='100')||
      (['search_classes','get_my_bookings'].includes(input.tool)&&path==='/classes'&&query(q,['min_start_date','max_start_date','page_size'],['page'])&&
       dates(q.get('min_start_date'),q.get('max_start_date'),13)&&/^([1-9]\d?|100)$/.test(q.get('page_size'))&&(!q.has('page')||/^[1-6]$/.test(q.get('page')))));
  }
  if(!allowed)throw denied();
  const headers=new Headers(input.headers);
  const accepted=new Set(['accept','authorization','origin','referer','x-organisation','user-agent','accept-language']);
  for(const [name,value]of headers)if(!accepted.has(name)||value.length>8192)throw denied();
  if((path==='/profile'||path.startsWith('/me/'))&&!/^Bearer [^\s]{1,8192}$/.test(headers.get('authorization')||''))throw denied();
  return {target,headers};
}
module.exports={validate,tools};
