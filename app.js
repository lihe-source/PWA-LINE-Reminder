import { LiveConversation } from './live.js';
const $ = id => document.getElementById(id);
const C = window.REMINDER_CONFIG;
const ZONE = 'Asia/Taipei', VERSION = '1.0.2';
const state = { token:null, contacts:[],tasks:[],quota:null, draft:null, month:new Date(), day:null, live:null, editing:null };
let toastTimer;
function toast(message) { const el=$('toast');el.textContent=message;el.classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.add('hidden'),message.includes('Google ')?45000:4500); }
function fmt(iso,opts={}) { return new Intl.DateTimeFormat('zh-TW',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23',...opts}).format(new Date(iso)); }
function dayKey(iso) { const parts=new Intl.DateTimeFormat('en-US',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(iso));const get=t=>parts.find(p=>p.type===t).value;return `${get('year')}-${get('month')}-${get('day')}`; }
function taipeiNow() { return new Date(Date.now()+8*3600000).toISOString().slice(0,16); }
function taipeiToISO(local) { if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(local)) return null;const d=new Date(local+':00+08:00');return Number.isNaN(d.getTime())?null:d.toISOString(); }
function localFromISO(iso) { return new Date(Date.parse(iso)+8*3600000).toISOString().slice(0,16); }
function configured() { return C.API_URL.startsWith('https://')&&!C.API_URL.includes('REPLACE_'); }
async function api(path,method='GET',data) {
  const r=await fetch(C.API_URL.replace(/\/$/,'')+path,{method,headers:{Authorization:'Bearer '+state.token,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,cache:'no-store'});
  const result=await r.json().catch(()=>({}));
  if(r.status===401){logout('登入已過期，請重新登入。');throw new Error('登入已過期');}
  if(!r.ok) throw new Error((result.error||`服務回應 ${r.status}`)+(result.details?'\n'+result.details:''));
  return result;
}
function logout(message='已登出') {
  state.live?.stop();state.live=null;state.token=null;state.contacts=[];state.tasks=[];state.quota=null;closeDraft();
  sessionStorage.removeItem('rex-login-session');localStorage.removeItem('rex-login-session');
  $('login-password').value='';$('app').classList.add('hidden');$('login').classList.remove('hidden');$('login-error').textContent=message;
}
async function authenticate(token) { state.token=token;try { await refresh();$('login').classList.add('hidden');$('app').classList.remove('hidden');$('login-error').textContent='';render();return true; }catch(e){logout(e.message);return false;} }
async function submitLogin(event) {
  event.preventDefault();if(!configured())return;
  const button=$('login-submit');button.disabled=true;button.textContent='登入中…';$('login-error').textContent='';
  try {
    const remember=$('remember-login').checked;
    const r=await fetch(C.API_URL.replace(/\/$/,'')+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({username:$('login-username').value.trim(),password:$('login-password').value,remember})});
    const result=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(result.error||'登入失敗，請稍後再試。');
    sessionStorage.removeItem('rex-login-session');localStorage.removeItem('rex-login-session');
    if(await authenticate(result.token))(remember?localStorage:sessionStorage).setItem('rex-login-session',JSON.stringify({token:result.token,expires_at:result.expires_at}));
    $('login-password').value='';
  }catch(e){$('login-error').textContent=e.message==='Failed to fetch'?'無法連接服務，請確認網路與雲端網址。':e.message;}
  finally{button.disabled=false;button.textContent='登入';}
}
function loginInit() {
  sessionStorage.removeItem('rex-id-token');
  $('login-form').addEventListener('submit',submitLogin);
  $('show-password').onclick=()=>{const visible=$('login-password').type==='password';$('login-password').type=visible?'text':'password';$('show-password').textContent=visible?'隱藏':'顯示';$('show-password').setAttribute('aria-pressed',String(visible));};
  if(!configured()){ $('login-error').textContent='尚未完成設定。請先依安裝說明填寫 config.js，並部署雲端服務。';$('login-submit').disabled=true;return; }
  try {
    const saved=JSON.parse(localStorage.getItem('rex-login-session')||sessionStorage.getItem('rex-login-session')||'null');
    if(saved?.token&&Date.parse(saved.expires_at)>Date.now())authenticate(saved.token);
    else{sessionStorage.removeItem('rex-login-session');localStorage.removeItem('rex-login-session');}
  }catch{sessionStorage.removeItem('rex-login-session');localStorage.removeItem('rex-login-session');}
}
async function refresh(){const data=await api('/api/state');state.tasks=data.tasks||[];state.contacts=data.contacts||[];state.quota=data.quota;render();}
function textNode(tag,text,className){const el=document.createElement(tag);el.textContent=text;if(className)el.className=className;return el;}
function taskCard(task){
  const node=textNode('div','','task'),left=document.createElement('div'),right=document.createElement('div');
  left.append(textNode('strong',task.message),textNode('small',`${task.recipient_name} · ${statusName(task.status)}${task.sent_at?' · 實際送出 '+fmt(task.sent_at):''}${task.last_error?' · '+task.last_error:''}`));
  if(task.status==='pending'){
    const actions=textNode('div','','actions');
    const edit=textNode('button','修改'),cancel=textNode('button','取消','danger');
    edit.onclick=()=>openDraft({recipient_name:task.recipient_name,recipient_id:task.recipient_id,message:task.message,taipei_time:localFromISO(task.due_at)},task.id);
    cancel.onclick=async()=>{if(!confirm('確定取消這項提醒？'))return;try{await api('/api/tasks/'+task.id,'DELETE');toast('已取消');await refresh();}catch(e){toast(e.message);}};
    actions.append(edit,cancel);left.append(actions);
  }
  right.append(textNode('span',fmt(task.due_at,{year:undefined,month:'2-digit',day:'2-digit'}),'date'));
  node.append(left,right);return node;
}
function statusName(status){return {pending:'待發送',processing:'處理中',sent:'已送出至 LINE',failed:'發送失敗',cancelled:'已取消'}[status]||status;}
function fillList(el,tasks,empty){el.replaceChildren();if(!tasks.length){el.append(textNode('div',empty,'empty'));return;}tasks.forEach(t=>el.append(taskCard(t)));}
function render(){
  $('today-label').textContent=fmt(new Date(),{weekday:'long',hour:undefined,minute:undefined})+' · 台灣時間';
  fillList($('upcoming'),state.tasks.filter(t=>t.status==='pending'&&Date.parse(t.due_at)>=Date.now()).sort((a,b)=>a.due_at.localeCompare(b.due_at)).slice(0,5),'目前沒有待發送提醒');
  const contacts=$('contacts');contacts.replaceChildren();
  if(!state.contacts.length)contacts.append(textNode('div','尚未配對收件人。先把自己加進來，就能測試提醒。','empty'));
  for(const person of state.contacts){const node=textNode('div','','task'),left=textNode('strong',person.name),remove=textNode('button','移除','text-button');remove.onclick=async()=>{if(!confirm(`移除「${person.name}」？已排程提醒到期時將發送失敗。`))return;try{await api('/api/contacts/'+person.id,'DELETE');await refresh();}catch(e){toast(e.message);}};node.append(left,remove);contacts.append(node);}
  const q=state.quota;$('quota-label').textContent=q?(q.type==='limited'?`本月已用 ${q.totalUsage??'—'}／${q.value??'—'} 則。${Number(q.totalUsage)>=Number(q.value)*.8?'即將達到額度，請留意待發送提醒。':'額滿後 LINE 會拒絕發送。'}`:`本月已用 ${q.totalUsage??'—'} 則；方案：${q.type||'未知'}`):'尚無法讀取 LINE 用量，請確認官方帳號設定。';
  if($('page-calendar').classList.contains('active'))renderCalendar();
}
function renderCalendar(){
  const m=state.month.getUTCMonth(),y=state.month.getUTCFullYear();$('calendar-title').textContent=`${y} 年 ${m+1} 月`;
  const today=dayKey(new Date()),first=new Date(Date.UTC(y,m,1)),offset=first.getUTCDay(),grid=$('calendar-grid');grid.replaceChildren();
  const marked=new Set(state.tasks.filter(t=>t.status!=='cancelled').map(t=>dayKey(t.due_at)));
  for(let i=0;i<42;i++){
    const d=new Date(Date.UTC(y,m,1+i-offset)),key=d.toISOString().slice(0,10),button=textNode('button',String(d.getUTCDate()));
    if(d.getUTCMonth()!==m)button.classList.add('other');if(key===today)button.classList.add('today');if(key===state.day)button.classList.add('selected');if(marked.has(key))button.classList.add('has');
    button.onclick=()=>{state.day=key;renderCalendar();};grid.append(button);
  }
  $('selected-date-title').textContent=(state.day||today).replaceAll('-','/')+' 的提醒';
  fillList($('day-tasks'),state.tasks.filter(t=>dayKey(t.due_at)===(state.day||today)).sort((a,b)=>a.due_at.localeCompare(b.due_at)),'這天沒有提醒');
}
function page(name){document.querySelectorAll('.page').forEach(x=>x.classList.toggle('active',x.id==='page-'+name));document.querySelectorAll('.bottom-nav button').forEach(x=>x.classList.toggle('active',x.dataset.page===name));if(name==='calendar')renderCalendar();window.scrollTo({top:0,behavior:'smooth'});}
function openDraft(data={},editing=null){
  state.editing=editing;state.draft=data;$('draft').classList.remove('hidden');$('draft-recipient').replaceChildren();
  $('draft-recipient').append(new Option('請選擇收件人',''));
  state.contacts.forEach(c=>$('draft-recipient').append(new Option(c.name,c.id)));
  $('draft-recipient').value=data.recipient_id||state.contacts.find(c=>c.name===data.recipient_name)?.id||'';
  $('draft-message').value=data.message||'';
  $('draft-due').value=data.taipei_time||taipeiNow();
  $('draft-hint').textContent='台灣時間（UTC+8）。請確認完整日期及 24 小時制時間，按「確認建立」才會儲存。';
  $('confirm-btn').textContent=editing?'儲存修改':'確認建立';$('draft').scrollIntoView({behavior:'smooth',block:'center'});
}
function closeDraft(){state.draft=null;state.editing=null;$('draft').classList.add('hidden');}
async function confirmDraft(){
  const recipient_id=$('draft-recipient').value,message=$('draft-message').value.trim(),due_at=taipeiToISO($('draft-due').value);
  if(!recipient_id||!message||!due_at||Date.parse(due_at)<=Date.now()+15000){toast('請確認已配對的收件人、內容與未來的台灣時間。');return;}
  const el=$('confirm-btn');el.disabled=true;
  try {await api(state.editing?'/api/tasks/'+state.editing:'/api/tasks',state.editing?'PATCH':'POST',{recipient_id,message,due_at,source_text:state.draft?.source_text||''});closeDraft();toast(state.editing?'提醒已修改':'提醒已建立');await refresh();}
  catch(e){toast(e.message);}finally{el.disabled=false;}
}
function transcript(role,text){if(!text)return;const p=document.createElement('p');p.append(textNode('b',role+'：'),document.createTextNode(text));$('conversation').append(p);$('conversation').classList.remove('hidden');$('conversation').scrollTop=$('conversation').scrollHeight;}
function voiceStatus(text,on){$('voice-status').textContent=text;$('mic-btn').classList.toggle('listening',!!on);}
async function startLive(voice,initialText){
  if(state.live){if(voice){state.live.stop();state.live=null;voiceStatus('點一下，開始語音對話',false);return;}state.live.stop();}
  $('conversation').replaceChildren();$('conversation').classList.remove('hidden');voiceStatus('正在連接 Gemini…',false);
  const live=new LiveConversation({
    api,contacts:state.contacts,voice,
    onStatus:s=>voiceStatus(s,live.micOn),
    onTranscript:transcript,
    onDraft:proposed=>{openDraft({...proposed,source_text:initialText||proposed.source_text||''});},
    onConfirm:()=>{if(!$('draft').classList.contains('hidden'))confirmDraft();},
    onError:e=>{toast(e);voiceStatus('連線中斷，請重試或使用鍵盤',false);},
    onStop:()=>{if(state.live===live){state.live=null;voiceStatus('點一下，開始語音對話',false);}}
  });state.live=live;
  try{await live.start(initialText);}catch(e){live.stop();if(state.live===live)state.live=null;voiceStatus('點一下，開始語音對話',false);toast(e.message);}
}
async function updateCheck(force=false){try{
  const r=await fetch(C.VERSION_URL+'?t='+Date.now(),{cache:'no-store'});const v=(await r.json()).version;
  $('latest-version').textContent=v;
  if(v!==VERSION){toast('有新版，正在更新…');const reg=await navigator.serviceWorker?.getRegistration();await reg?.update();setTimeout(()=>location.reload(),1600);}
  else if(force)toast('目前已是最新版本');
}catch{ $('latest-version').textContent='無法檢查';if(force)toast('無法檢查更新，請稍後重試');}}
function wire(){
  document.querySelectorAll('.bottom-nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));
  $('mic-btn').onclick=()=>startLive(true);
  $('keyboard-btn').onclick=()=>{$('text-panel').classList.toggle('hidden');$('typed-input').focus();};
  $('interpret-btn').onclick=()=>{const t=$('typed-input').value.trim();if(!t){toast('請先輸入想提醒的內容');return;}startLive(false,t);};
  $('manual-btn').onclick=()=>openDraft();$('discard-btn').onclick=closeDraft;$('confirm-btn').onclick=confirmDraft;
  $('prev-month').onclick=()=>{state.month=new Date(Date.UTC(state.month.getUTCFullYear(),state.month.getUTCMonth()-1,1));renderCalendar();};
  $('next-month').onclick=()=>{state.month=new Date(Date.UTC(state.month.getUTCFullYear(),state.month.getUTCMonth()+1,1));renderCalendar();};
  $('pair-btn').onclick=async()=>{try{const name=$('pair-name').value.trim();const p=await api('/api/pair','POST',{name});const result=$('pair-result');result.replaceChildren(textNode('span',p.code,'pair-code'),textNode('div',`請「${name}」先加入你的 LINE 官方帳號，在對話中傳送：綁定 ${p.code}`),textNode('small','配對碼 10 分鐘內有效。收到 LINE 的配對完成回覆後，按設定頁重新整理。'));result.classList.remove('hidden');}catch(e){toast(e.message);}};
  $('theme-btn').onclick=()=>{document.body.classList.toggle('light');localStorage.setItem('rex-theme',document.body.classList.contains('light')?'light':'dark');};
  $('update-btn').onclick=()=>updateCheck(true);$('refresh-btn').onclick=async()=>{try{await refresh();toast('資料已更新');}catch(e){toast(e.message);}};
  $('logout-btn').onclick=async()=>{try{await api('/api/logout','POST');logout();}catch{logout('已清除此裝置的登入狀態。');}};
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.token)refresh().catch(()=>{});});
}
if(localStorage.getItem('rex-theme')==='light')document.body.classList.add('light');
wire();loginInit();updateCheck();
if('serviceWorker' in navigator){navigator.serviceWorker.register('./sw.js').catch(()=>{});}
