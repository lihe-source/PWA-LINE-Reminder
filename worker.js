// Cloudflare Worker. Set GEMINI_API_KEY, LINE_CHANNEL_ACCESS_TOKEN and LINE_CHANNEL_SECRET as secrets.
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
});
const fail = (status, message) => json({ error: message }, status);
const now = () => new Date().toISOString();
const date = value => Number.isFinite(Date.parse(value || '')) ? new Date(value).toISOString() : null;
const clean = value => String(value || '').trim();
const hex = bytes => Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
const fromHex = s => new Uint8Array(s.match(/../g).map(v=>parseInt(v,16)));
const digest = async text => hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
const authVersion = env => digest(env.LOGIN_USERNAME+'\n'+env.LOGIN_PASSWORD_HASH);
async function passwordMatches(password, stored) {
  const parts = stored.split('$');
  if (parts.length!==4 || parts[0]!=='pbkdf2-sha256' || parts[1]!=='100000' || !/^[a-f0-9]{32}$/.test(parts[2]) || !/^[a-f0-9]{64}$/.test(parts[3])) return false;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const actual = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',salt:fromHex(parts[2]),iterations:100000,hash:'SHA-256'},key,256));
  const expected = fromHex(parts[3]);
  let difference=0;for(let i=0;i<32;i++)difference|=actual[i]^expected[i];
  return difference===0;
}
async function login(request,env) {
  if (!env.LOGIN_USERNAME || !/^pbkdf2-sha256\$100000\$[a-f0-9]{32}\$[a-f0-9]{64}$/.test(env.LOGIN_PASSWORD_HASH||'')) return fail(503,'尚未設定登入帳號或密碼驗證資料。請依使用說明設定 Cloudflare Secret。');
  const b = await body(request);
  if (typeof b.username!=='string'||typeof b.password!=='string'||b.username.length>64||b.password.length>256) return fail(400,'請輸入帳號與密碼。');
  const time = Date.now(), cutoff=time-15*60000;
  const ip = await digest(request.headers.get('CF-Connecting-IP')||'unknown');
  for (const [key,limit] of [[ip,5],['global',20]]) {
    await env.DB.prepare(`INSERT INTO auth_limits (key,window_start,attempts) VALUES (?,?,1)
      ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END`).bind(key,time,cutoff,cutoff).run();
    const row=await env.DB.prepare('SELECT attempts FROM auth_limits WHERE key=?').bind(key).first();
    if(row.attempts>limit) return json({error:'嘗試次數過多，請稍候 15 分鐘再登入。'},429,{'retry-after':'900'});
  }
  const matched = await passwordMatches(b.password,env.LOGIN_PASSWORD_HASH);
  if (b.username.trim()!==env.LOGIN_USERNAME || !matched) return fail(401,'帳號或密碼不正確。');
  const token=hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(time+(b.remember===true?7:1)*86400000).toISOString();
  await env.DB.prepare('INSERT INTO auth_sessions (token_hash,auth_version,created_at,expires_at) VALUES (?,?,?,?)')
    .bind(await digest(token),await authVersion(env),now(),expires).run();
  await env.DB.prepare('DELETE FROM auth_limits WHERE key=?').bind(ip).run();
  return json({token,expires_at:expires});
}

function cors(request, env, response) {
  const origin = request.headers.get('Origin');
  if (!origin || origin !== env.APP_ORIGIN) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  headers.set('vary', 'Origin');
  return new Response(response.body, { status: response.status, headers });
}
async function owner(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /i, '');
  if (!/^[a-f0-9]{64}$/.test(token) || !env.LOGIN_USERNAME || !env.LOGIN_PASSWORD_HASH) return false;
  const session=await env.DB.prepare('SELECT auth_version FROM auth_sessions WHERE token_hash=? AND expires_at>?').bind(await digest(token),now()).first();
  return !!session && session.auth_version===await authVersion(env);
}
async function body(request) {
  if (Number(request.headers.get('Content-Length') || 0) > 16000) throw new Error('內容過長');
  return request.json();
}
async function state(env) {
  const [tasks, contacts] = await Promise.all([
    env.DB.prepare('SELECT id,recipient_id,recipient_name,message,source_text,due_at,status,attempts,sent_at,last_error,created_at FROM tasks ORDER BY due_at DESC').all(),
    env.DB.prepare('SELECT id,name,created_at FROM contacts WHERE active=1 ORDER BY created_at DESC').all()
  ]);
  let quota = null;
  if (env.LINE_CHANNEL_ACCESS_TOKEN) {
    try {
      const h = { Authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}` };
      const [q, u] = await Promise.all([
        fetch('https://api.line.me/v2/bot/message/quota', { headers: h }),
        fetch('https://api.line.me/v2/bot/message/quota/consumption', { headers: h })
      ]);
      if (q.ok && u.ok) quota = { ...await q.json(), ...await u.json() };
    } catch { /* UI still works when LINE quota service is unavailable. */ }
  }
  return json({ tasks: tasks.results, contacts: contacts.results, quota, serverTime: now() });
}
async function createTask(request, env) {
  const b = await body(request);
  const message = clean(b.message), due = date(b.due_at), id = clean(b.recipient_id);
  if (!message || message.length > 500 || !due || !id || due <= new Date(Date.now() + 15000).toISOString()) {
    return fail(400, '請確認收件人、內容與未來的台灣時間（至少 15 秒後）。');
  }
  const recipient = await env.DB.prepare('SELECT id,name FROM contacts WHERE id=? AND active=1').bind(id).first();
  if (!recipient) return fail(400, '這位收件人尚未完成 LINE 配對。');
  const taskId = crypto.randomUUID(), t = now();
  await env.DB.prepare(`INSERT INTO tasks (id,recipient_id,recipient_name,message,source_text,due_at,status,retry_key,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'pending',?,?,?)`).bind(taskId,id,recipient.name,message,clean(b.source_text).slice(0,1000),due,crypto.randomUUID(),t,t).run();
  return json({ id: taskId, status: 'pending' }, 201);
}
async function editTask(request, env, id) {
  const b = await body(request), message = clean(b.message), due = date(b.due_at);
  if (!message || message.length > 500 || !due || due <= new Date(Date.now() + 15000).toISOString()) return fail(400, '請填寫未來的時間與 500 字以內的內容。');
  const recipient = await env.DB.prepare('SELECT id,name FROM contacts WHERE id=? AND active=1').bind(clean(b.recipient_id)).first();
  if (!recipient) return fail(400, '收件人未完成配對。');
  const result = await env.DB.prepare(`UPDATE tasks SET recipient_id=?,recipient_name=?,message=?,due_at=?,updated_at=?
    WHERE id=? AND status='pending' AND attempts=0`).bind(recipient.id,recipient.name,message,due,now(),id).run();
  return result.meta.changes ? json({ ok: true }) : fail(409, '任務已在發送或已結束，無法修改。');
}
async function cancelTask(env, id) {
  const result = await env.DB.prepare(`UPDATE tasks SET status='cancelled',updated_at=? WHERE id=? AND status='pending' AND attempts=0`)
    .bind(now(),id).run();
  return result.meta.changes ? json({ ok: true }) : fail(409, '任務已在發送或已結束，無法取消。');
}
async function pair(request, env) {
  const name = clean((await body(request)).name);
  if (!name || name.length > 40) return fail(400, '請輸入 1 至 40 字的收件人名稱。');
  const duplicate = await env.DB.prepare('SELECT id FROM contacts WHERE name=? AND active=1').bind(name).first();
  if (duplicate) return fail(409, '這個稱呼已使用，請加上可區分的名稱，例如「小明（表弟）」。');
  await env.DB.prepare('DELETE FROM pairing WHERE expires_at < ? OR used_at IS NOT NULL').bind(now()).run();
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
    try {
      await env.DB.prepare('INSERT INTO pairing (code,name,expires_at) VALUES (?,?,?)')
        .bind(code,name,new Date(Date.now()+10*60000).toISOString()).run();
      return json({ code, expires_at: new Date(Date.now()+10*60000).toISOString() });
    } catch { /* Rare collision. */ }
  }
  return fail(503, '配對碼暫時無法建立，請稍後重試。');
}
async function removeContact(env, id) {
  const result = await env.DB.prepare('UPDATE contacts SET active=0 WHERE id=? AND active=1').bind(id).run();
  return result.meta.changes ? json({ ok: true }) : fail(404, '找不到收件人。');
}
async function token(env) {
  const apiKey = clean(env.GEMINI_API_KEY);
  if (!apiKey) return fail(503, '尚未設定 Gemini 金鑰。');
  const t = Date.now();
  let r;
  try { r = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
    method: 'POST', headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ uses: 1, expireTime: new Date(t+15*60000).toISOString(),
      newSessionExpireTime: new Date(t+60000).toISOString(),
      // REST AuthToken fields differ from the Google SDK's liveConnectConstraints.
      // Lock only the model so the browser's audio, tools and instructions still apply.
      bidiGenerateContentSetup: { model: 'models/gemini-3.8-live' }, fieldMask: 'model' })
  }); } catch { return fail(502, '雲端暫時無法連接 Google，請稍後重試。'); }
  const result = await r.json().catch(()=>null);
  if (r.ok && typeof result?.name === 'string' && result.name) return json({ token: result.name });
  const hints = {
    400: 'Google 無法接受語音連線設定，請確認雲端已更新至 V1.0.2。',
    401: 'Gemini 金鑰未通過驗證，請重新複製金鑰到 Cloudflare Secret。',
    403: 'Google 拒絕存取，請確認金鑰專案已啟用 Gemini API，且具有使用權限。',
    404: 'Google 找不到指定的語音服務或模型，請確認該專案可以使用 Gemini 3.8 Live。',
    429: 'Google 使用額度或請求頻率已達限制，請先到 AI Studio 查看用量；不用立即啟用付款。'
  };
  const status = /^[A-Z_]+$/.test(result?.error?.status||'') ? result.error.status : '';
  const raw = String(result?.error?.message||'').split(apiKey).join('[已隱藏金鑰]')
    .replace(/AIza[\w-]+/g,'[已隱藏金鑰]').replace(/auth_tokens\/[^\s"']+/g,'[已隱藏連線資格]')
    .replace(/[\r\n]+/g,' ').slice(0,300);
  const hint = hints[r.status] || (r.ok ? 'Google 沒有回傳有效的語音連線資格。' : 'Google 服務暫時無法使用，請稍後重試。');
  return json({ error: hint, details: `Google ${r.status}${status?'（'+status+'）':''}${raw?'：'+raw:''}` },502);
}
async function webhook(request, env) {
  if (!env.LINE_CHANNEL_SECRET) return fail(503, 'LINE 尚未設定。');
  const raw = await request.text();
  if (raw.length > 100000) return fail(413, '內容過長');
  const signature = request.headers.get('x-line-signature') || '';
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(env.LINE_CHANNEL_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const signed = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(signed)));
  let mismatch = expected.length !== signature.length;
  for (let i=0;i<expected.length;i++) mismatch ||= expected.charCodeAt(i) !== signature.charCodeAt(i);
  if (mismatch) return fail(401, '簽章不符');
  const events = JSON.parse(raw).events || [];
  for (const event of events) {
    if (event.type !== 'message' || event.message?.type !== 'text' || event.source?.type !== 'user') continue;
    const code = /^綁定\s*(\d{6})$/.exec(event.message.text.trim())?.[1];
    if (!code) continue;
    const t = now();
    const claim = await env.DB.prepare('UPDATE pairing SET used_at=? WHERE code=? AND used_at IS NULL AND expires_at>?').bind(t,code,t).run();
    if (!claim.meta.changes) continue;
    const entry = await env.DB.prepare('SELECT name FROM pairing WHERE code=?').bind(code).first();
    await env.DB.prepare(`INSERT INTO contacts (id,name,line_user_id,active,created_at) VALUES (?,?,?,?,?)
      ON CONFLICT(line_user_id) DO UPDATE SET name=excluded.name,active=1`).bind(crypto.randomUUID(),entry.name,event.source.userId,1,t).run();
    if (event.replyToken && env.LINE_CHANNEL_ACCESS_TOKEN) await fetch('https://api.line.me/v2/bot/message/reply', {
      method:'POST', headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,'content-type':'application/json'},
      body:JSON.stringify({replyToken:event.replyToken,messages:[{type:'text',text:'配對完成。Rex 現在可以選擇您作為提醒收件人。'}]})
    });
  }
  return json({ ok: true });
}
async function sendDue(env) {
  const t = now();
  const due = await env.DB.prepare(`SELECT id FROM tasks WHERE
    (status='pending' AND due_at<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR
    (status='processing' AND claimed_at<?) ORDER BY due_at LIMIT 30`)
    .bind(t,t,new Date(Date.now()-2*60000).toISOString()).all();
  for (const row of due.results) {
    const claimed = await env.DB.prepare(`UPDATE tasks SET status='processing',claimed_at=?,updated_at=?,
      first_attempt_at=COALESCE(first_attempt_at,?),attempts=attempts+1 WHERE id=? AND
      ((status='pending' AND due_at<=? AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR
      (status='processing' AND claimed_at<?))`).bind(t,t,t,row.id,t,t,new Date(Date.now()-2*60000).toISOString()).run();
    if (!claimed.meta.changes) continue;
    const task = await env.DB.prepare(`SELECT t.*,c.line_user_id,c.active FROM tasks t LEFT JOIN contacts c ON c.id=t.recipient_id WHERE t.id=?`).bind(row.id).first();
    if (!task.active || !task.line_user_id || !env.LINE_CHANNEL_ACCESS_TOKEN) {
      await markFailed(env,row.id,'收件人已移除或 LINE 金鑰未設定'); continue;
    }
    if (Date.now()-Date.parse(task.first_attempt_at)>23*3600000) {
      await markFailed(env,row.id,'LINE 重試保護已過期，請人工確認收件人是否收到'); continue;
    }
    try {
      const r = await fetch('https://api.line.me/v2/bot/message/push', {
        method:'POST', headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,'content-type':'application/json','X-Line-Retry-Key':task.retry_key},
        body:JSON.stringify({to:task.line_user_id,messages:[{type:'text',text:`提醒｜${task.message}\n預定時間：${new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(task.due_at))}（台灣時間）`}],notificationDisabled:false})
      });
      if (r.status===200 || r.status===409) {
        await env.DB.prepare(`UPDATE tasks SET status='sent',sent_at=?,updated_at=?,last_error=NULL WHERE id=? AND status='processing'`).bind(now(),now(),row.id).run();
      } else if (r.status===429 || r.status>=500) await retry(env,task,`LINE 暫時無法發送（${r.status}）`);
      else await markFailed(env,row.id,`LINE 拒絕發送（${r.status}）。請查看官方帳號額度及設定。`);
    } catch { await retry(env,task,'網路暫時中斷，等待重試'); }
  }
  const cutoff = new Date(Date.now()-30*86400000).toISOString();
  await env.DB.prepare(`DELETE FROM tasks WHERE (status='sent' AND sent_at<?) OR (status IN ('cancelled','failed') AND updated_at<?)`).bind(cutoff,cutoff).run();
  await env.DB.prepare('DELETE FROM pairing WHERE expires_at<?').bind(t).run();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at<?').bind(t).run();
  await env.DB.prepare('DELETE FROM auth_limits WHERE window_start<?').bind(Date.now()-86400000).run();
}
async function markFailed(env,id,why) {
  await env.DB.prepare(`UPDATE tasks SET status='failed',last_error=?,updated_at=? WHERE id=? AND status='processing'`).bind(why,now(),id).run();
}
async function retry(env,task,why) {
  if (task.attempts>=6) return markFailed(env,task.id,why+'；已達重試上限');
  const delay = Math.min(30,2**Math.min(task.attempts,4));
  await env.DB.prepare(`UPDATE tasks SET status='pending',next_attempt_at=?,last_error=?,updated_at=? WHERE id=? AND status='processing'`)
    .bind(new Date(Date.now()+delay*60000).toISOString(),why,now(),task.id).run();
}
export default {
  async fetch(request,env) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (request.method==='OPTIONS') return cors(request,env,new Response(null,{status:204}));
      if (path==='/webhook/line' && request.method==='POST') return webhook(request,env);
      if (!path.startsWith('/api/')) return fail(404,'不存在的路徑');
      if (request.headers.get('Origin') && request.headers.get('Origin')!==env.APP_ORIGIN) return fail(403,'來源不符');
      if (path==='/api/login' && request.method==='POST') return cors(request,env,await login(request,env));
      if (!await owner(request,env)) return cors(request,env,fail(401,'登入已過期，請輸入帳號與密碼重新登入。'));
      let result;
      if (path==='/api/logout' && request.method==='POST') {
        const token=(request.headers.get('Authorization')||'').replace(/^Bearer /i,'');
        await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash=?').bind(await digest(token)).run();
        result=json({ok:true});
      }
      else if (path==='/api/state' && request.method==='GET') result=await state(env);
      else if (path==='/api/tasks' && request.method==='POST') result=await createTask(request,env);
      else if (/^\/api\/tasks\/[\w-]+$/.test(path) && request.method==='PATCH') result=await editTask(request,env,path.split('/')[3]);
      else if (/^\/api\/tasks\/[\w-]+$/.test(path) && request.method==='DELETE') result=await cancelTask(env,path.split('/')[3]);
      else if (path==='/api/pair' && request.method==='POST') result=await pair(request,env);
      else if (/^\/api\/contacts\/[\w-]+$/.test(path) && request.method==='DELETE') result=await removeContact(env,path.split('/')[3]);
      else if (path==='/api/live-token' && request.method==='POST') result=await token(env);
      else result=fail(404,'不存在的路徑');
      return cors(request,env,result);
    } catch (error) {
      console.error('Request failed',error);
      return cors(request,env,fail(500,'服務暫時無法處理，請稍後再試。'));
    }
  },
  async scheduled(_controller,env,ctx) { ctx.waitUntil(sendDue(env)); }
};
