// Standing provider policy; mutations require separately enabled action receipts. Provider protocols belong here, not in core routing.
const { getGymConfig } = require('../gyms.config');
const denied = () => Object.assign(new Error('Provider route is not permitted'), { code:'PROVIDER_WORK_DISABLED',status:403 });
const tools = Object.freeze({search_classes:'schedule:read',get_class_details:'schedule:read',get_my_bookings:'account:read',get_credits:'account:read'});
function dates(a,b,max){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(a||'')||!/^\d{4}-\d{2}-\d{2}$/.test(b||''))return false;
  const start=Date.parse(a),end=Date.parse(b);
  return Number.isFinite(start)&&new Date(start).toISOString().slice(0,10)===a&&Number.isFinite(end)&&new Date(end).toISOString().slice(0,10)===b&&end>=start&&end-start<=max*864e5;
}
function query(q,required,optional=[]){const keys=[...q.keys()];return keys.length===new Set(keys).size&&required.every(k=>q.has(k))&&keys.every(k=>required.includes(k)||optional.includes(k));}
const actionTools = new Set(['prepare_booking','prepare_booking_edit','prepare_booking_cancel','execute_booking_action','get_booking_action']);
const id = v => (typeof v === 'string' || Number.isSafeInteger(v)) && /^[A-Za-z0-9_-]{1,100}$/.test(String(v));
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k=>Object.hasOwn(v,k));
function actionClaims(input) {
  const a=input.action, auth=input.authorization;
  if(!actionTools.has(input.tool)||input.scope!=='bookings:write'||!exact(a,['id','operation','input','eventId','submitted'])||
    typeof a.id!=='string'||!/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/.test(a.id)||!['book','edit','cancel'].includes(a.operation)||
    !exact(auth,['grant','client','scopes','credential','bodyHash'])||!['grant','client','credential','bodyHash'].every(k=>/^[a-f0-9]{64}$/.test(auth[k]||''))||
    !Array.isArray(auth.scopes)||auth.scopes.length>4||new Set(auth.scopes).size!==auth.scopes.length||
    !['bookings:write','account:read','schedule:read'].every(s=>auth.scopes.includes(s))||typeof a.submitted!=='boolean')throw denied();
  const fields=a.operation==='book'?['eventId',...(a.input?.slotId!==undefined?['slotId']:[])]:a.operation==='edit'?['bookingId','currentSlotId','slotId']:['bookingId'];
  if(!exact(a.input,fields)||!Object.values(a.input).every(id)||a.eventId!==null&&!id(a.eventId))throw denied();
  const expected={prepare_booking:'book',prepare_booking_edit:'edit',prepare_booking_cancel:'cancel'}[input.tool];
  if(expected&&a.operation!==expected)throw denied();
  if(a.operation==='book'&&a.eventId!==a.input.eventId)throw denied();
  if(auth.credential!==require('node:crypto').createHash('sha256').update(new Headers(input.headers).get('authorization')||'').digest('hex')||
    auth.bodyHash!==require('node:crypto').createHash('sha256').update(input.body||'').digest('hex'))throw denied();
  return a;
}
function validate(input){
  const action=actionTools.has(input.tool)?actionClaims(input):null;
  if(!action&&(!tools[input.tool]||input.scope!==tools[input.tool]||input.method!=='GET'||input.body!==null))throw denied();
  if(action&&(input.method==='GET'?input.body!==null:input.tool!=='execute_booking_action'||!action.submitted))throw denied();
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
    allowed=under(base)&&((input.tool==='get_credits'&&path==='/me/credits'&&noQuery())||
      (input.tool==='get_class_details'&&detail&&noQuery())||
      (input.tool==='get_my_bookings'&&path==='/me/reservations'&&query(q,['is_upcoming','page_size'])&&q.get('is_upcoming')==='true'&&q.get('page_size')==='100')||
      (['search_classes','get_my_bookings'].includes(input.tool)&&path==='/classes'&&query(q,['min_start_date','max_start_date','page_size'],['page'])&&
       dates(q.get('min_start_date'),q.get('max_start_date'),13)&&/^([1-9]\d?|100)$/.test(q.get('page_size'))&&(!q.has('page')||/^[1-6]$/.test(q.get('page')))));
  }
  if(action) {
    const a=action, ownEvent=a.eventId&&path===(gym.provider==='codexfit'?'/events/':'/classes/')+a.eventId;
    if(input.method==='GET') {
      if(!noQuery() && !(gym.provider==='codexfit'&&path==='/bookings'&&query(q,['limit','page'])&&q.get('limit')==='100'&&q.get('page')==='1') &&
        !(gym.provider==='marianatek'&&path==='/me/reservations'&&query(q,['is_upcoming','page_size'])&&q.get('is_upcoming')==='true'&&q.get('page_size')==='100'))throw denied();
      allowed=under(base)&&(gym.provider==='codexfit' ? ownEvent||['/profile','/heartbeat','/studios','/bookings'].includes(path) :
        ownEvent||path==='/me/reservations'||a.operation==='book'&&path===`/classes/${a.eventId}/payment_options`||a.operation==='cancel'&&path===`/me/reservations/${a.input.bookingId}/cancel_penalty`);
    } else {
      if(!noQuery())throw denied();
      let body=null;if(input.body!==null){if(typeof input.body!=='string'||Buffer.byteLength(input.body)>8192)throw denied();try{body=JSON.parse(input.body);if(JSON.stringify(body)!==input.body)throw denied();}catch(_){throw denied();}}
      const match=(wire,wanted)=>id(wire)&&String(wire)===String(wanted);
      if(gym.provider==='codexfit') {
        allowed=a.operation==='book'&&under(base)&&path==='/bookings'&&input.method==='POST'&&exact(body,['event_id','slots'])&&match(body.event_id,a.input.eventId)&&Array.isArray(body.slots)&&body.slots.length===1&&id(body.slots[0])&&(!a.input.slotId||match(body.slots[0],a.input.slotId))||
          a.operation==='cancel'&&under(base)&&path===`/bookings/${a.input.bookingId}`&&input.method==='DELETE'&&body===null||
          a.operation==='edit'&&under(v2)&&path===`/bookings/${a.input.bookingId}`&&input.method==='PATCH'&&exact(body,['slot'])&&match(body.slot,a.input.slotId);
      } else if(gym.provider==='marianatek') {
        allowed=under(base)&&(a.operation==='book'&&path==='/me/reservations'&&input.method==='POST'&&exact(body,['class_session','is_booked_for_me','reservation_type','payment_option',...(a.input.slotId?['spot']:[])])&&
          exact(body.class_session,['id'])&&match(body.class_session.id,a.input.eventId)&&body.is_booked_for_me===true&&body.reservation_type==='standard'&&exact(body.payment_option,['id'])&&id(body.payment_option.id)&&
          (!a.input.slotId||exact(body.spot,['id'])&&match(body.spot.id,a.input.slotId))||
          a.operation==='cancel'&&path===`/me/reservations/${a.input.bookingId}/cancel`&&input.method==='POST'&&body===null||
          a.operation==='edit'&&path===`/me/reservations/${a.input.bookingId}/swap_spots`&&input.method==='POST'&&exact(body,['spot'])&&match(body.spot,a.input.slotId));
      }
    }
  }
  if(!allowed)throw denied();
  const headers=new Headers(input.headers);
  const accepted=new Set(['accept','authorization','origin','referer','x-organisation','user-agent','accept-language',...(action&&input.body!==null?['content-type']:[])]);
  for(const [name,value]of headers)if(!accepted.has(name)||value.length>8192)throw denied();
  if(action&&input.body!==null&&headers.get('content-type')!=='application/json')throw denied();
  if((action||path==='/profile'||path.startsWith('/me/'))&&!/^Bearer [^\s]{1,8192}$/.test(headers.get('authorization')||''))throw denied();
  return {target,headers};
}
// The only action GETs eligible for same-execution reuse. Reservation snapshots
// are deliberately excluded, including cancellation and reconciliation reads.
function cacheableActionRead(gymId,url,action){
  const gym=getGymConfig(gymId);if(!gym||!id(action?.eventId))return false;
  const target=new URL(url),base=new URL(gym.apiBaseUrl);
  if(target.origin!==base.origin||target.search||target.hash||target.username||target.password)return false;
  const detail=base.pathname+(gym.provider==='codexfit'?'/events/':'/classes/')+action.eventId;
  return target.pathname===detail||gym.provider==='marianatek'&&action.operation==='book'&&target.pathname===detail+'/payment_options';
}
module.exports={validate,tools,cacheableActionRead};
