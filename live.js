// Direct browser <-> Gemini Live connection using a single-use token issued by the Worker.
const ENDPOINT='wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained?access_token=';
function base64(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
function decode64(value){const str=atob(value),bytes=new Uint8Array(str.length);for(let i=0;i<str.length;i++)bytes[i]=str.charCodeAt(i);return bytes;}
function downsample(input,from,to=16000){const count=Math.round(input.length*to/from),output=new Int16Array(count);for(let i=0;i<count;i++){const x=Math.max(-1,Math.min(1,input[Math.floor(i*from/to)]||0));output[i]=x<0?x*32768:x*32767;}return new Uint8Array(output.buffer);}
function taipeiStamp(){return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date());}
function normalizedLocal(value){
  if(!value)return '';
  const s=String(value).trim().replace(' ','T');
  if(/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(s)){
    if(/[zZ]|[+-]\d\d:\d\d$/.test(s))return new Date(s).toLocaleString('sv-SE',{timeZone:'Asia/Taipei',hourCycle:'h23'}).replace(' ','T').slice(0,16);
    return s.slice(0,16);
  }
  return '';
}
export class LiveConversation {
  constructor(options){Object.assign(this,options);this.closed=false;this.micOn=false;this.inputText='';this.audioNext=0;this.draftProposed=false;}
  send(payload){if(this.ws?.readyState===WebSocket.OPEN)this.ws.send(JSON.stringify(payload));}
  async start(initialText){
    this.context=new (window.AudioContext||window.webkitAudioContext)();
    await this.context.resume();
    if(this.voice){
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('這個瀏覽器無法開啟麥克風，請改用鍵盤。');
      this.stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    }
    this.initialText=initialText||'';
    this.onStatus('正在連接 Gemini 3.8 Live…');
    const {token}=await this.api('/api/live-token','POST');
    if(this.closed)return;
    this.ws=new WebSocket(ENDPOINT+encodeURIComponent(token));
    this.ws.onopen=()=>this.setup();
    this.ws.onmessage=event=>{try{this.receive(JSON.parse(event.data));}catch(e){this.onError('語音訊息處理失敗：'+e.message);}};
    this.ws.onerror=()=>this.onError('Gemini 語音連線失敗，請檢查金鑰與免費額度。');
    this.ws.onclose=()=>{if(!this.closed){this.onError('Gemini 對話已結束，請再按麥克風重新開始。');this.stop();}};
  }
  setup(){
    const people=this.contacts.map(c=>({name:c.name,id:c.id}));
    const instructions=`你是 Rex 的繁體中文語音提醒助理。現在台灣時間是 ${taipeiStamp()}，所有相對日期與時間都依 Asia/Taipei 計算。\n`+
      `目前可選的收件人：${JSON.stringify(people)}。你要以自然口語簡短對話。當使用者提供收件人、提醒內容與明確時間，呼叫 propose_reminder，`+
      `taipei_time 格式必須是 YYYY-MM-DDTHH:mm 且使用 24 小時制（「下午三點十分」為 15:10）。「提醒我」請對應名稱 Rex 或名單中的自己；`+
      `若未能確定收件人、時間、日期或同名，先問清楚，絕不可猜。提案後口頭覆述收件人、完整台灣日期時間、訊息，請 Rex 確認。`+
      `工具只在畫面產生草稿，絕不代表建立或發送。使用者說確認後，請提醒他可按畫面「確認建立」；語音辨識到明確「確認」也會由畫面要求送出。`;
    this.send({setup:{model:'models/gemini-3.8-live',generationConfig:{responseModalities:['AUDIO']},
      inputAudioTranscription:{},outputAudioTranscription:{},systemInstruction:{parts:[{text:instructions}]},
      tools:[{functionDeclarations:[{name:'propose_reminder',behavior:'BLOCKING',description:'建立一張待 Rex 確認的提醒草稿，絕不實際排程或發送。',
        parameters:{type:'OBJECT',properties:{recipient_name:{type:'STRING',description:'已配對的收件人名稱'},recipient_id:{type:'STRING',description:'對應名單中的 ID'},message:{type:'STRING',description:'要傳送的提醒內容，去除日期與收件人命令'},taipei_time:{type:'STRING',description:'Asia/Taipei 的 YYYY-MM-DDTHH:mm，24 小時制'}},required:['recipient_name','message','taipei_time']}}]}]
    }});
  }
  async receive(r){
    if(r.setupComplete){
      if(this.voice){this.onStatus('AI 正在打招呼…');this.send({clientContent:{turns:[{role:'user',parts:[{text:'請先簡短說：嗨，Rex，有什麼我可以幫忙的？然後等待我說提醒內容。'}]}],turnComplete:true}});}
      else{this.onStatus('AI 正在整理文字…');this.send({clientContent:{turns:[{role:'user',parts:[{text:this.initialText}]}],turnComplete:true}});}
    }
    const c=r.serverContent;
    if(c?.inputTranscription?.text){const t=c.inputTranscription.text.trim();this.onTranscript('你',t);this.inputText=t;
      if(this.draftProposed&&/^(確認|對|對的|對[，, ]?沒錯|沒錯|是的|好[，, ]?請?建立|可以[，, ]?建立|請建立)[。！! ]*$/.test(t)){this.draftProposed=false;this.onConfirm();}
    }
    if(c?.outputTranscription?.text)this.onTranscript('AI',c.outputTranscription.text);
    for(const part of c?.modelTurn?.parts||[])if(part.inlineData?.data)this.play(part.inlineData.data,part.inlineData.mimeType);
    if(c?.interrupted)this.audioNext=this.context.currentTime;
    if(c?.turnComplete&&this.voice&&!this.micOn){try{await this.startMic();}catch(e){this.onError('麥克風無法啟動：'+e.message);}}
    if(r.toolCall?.functionCalls){
      const responses=[];
      for(const call of r.toolCall.functionCalls){
        if(call.name==='propose_reminder'){
          const args=call.args||{},time=normalizedLocal(args.taipei_time);
          const names=this.contacts.filter(p=>p.name===args.recipient_name);
          const matched=this.contacts.find(p=>p.id===args.recipient_id)||(names.length===1?names[0]:null);
          if(matched&&time&&String(args.message||'').trim()){
            this.draftProposed=true;this.onDraft({recipient_name:matched.name,recipient_id:matched.id,message:String(args.message).trim(),taipei_time:time,source_text:this.inputText});
            responses.push({id:call.id,name:call.name,response:{result:'草稿已顯示。請口頭覆述完整台灣日期時間、收件人與內容，請使用者確認；尚未建立。'}});
          }else responses.push({id:call.id,name:call.name,response:{result:'收件人尚未配對或時間不明確；請詢問 Rex，尚未建立。'}});
        }else responses.push({id:call.id,name:call.name,response:{result:'未知功能；未執行。'}});
      }
      this.send({toolResponse:{functionResponses:responses}});
    }
  }
  async startMic(){
    if(!this.stream||this.closed)return;
    await this.context.audioWorklet.addModule('./mic-worklet.js');
    this.source=this.context.createMediaStreamSource(this.stream);
    this.worklet=new AudioWorkletNode(this.context,'mic-tap');
    const silent=this.context.createGain();silent.gain.value=0;
    this.source.connect(this.worklet);this.worklet.connect(silent);silent.connect(this.context.destination);
    let chunks=[],length=0;
    this.worklet.port.onmessage=event=>{
      chunks.push(event.data);length+=event.data.length;
      if(length<4096)return;
      const merged=new Float32Array(length);let n=0;for(const part of chunks){merged.set(part,n);n+=part.length;}chunks=[];length=0;
      if(this.ws?.readyState===WebSocket.OPEN&&this.ws.bufferedAmount<300000)this.send({realtimeInput:{audio:{data:base64(downsample(merged,this.context.sampleRate)),mimeType:'audio/pcm;rate=16000'}}});
    };
    this.micOn=true;this.onStatus('正在聆聽 · 再按一次麥克風可結束');
  }
  play(value,mime){
    if(!this.context||this.closed)return;
    const raw=decode64(value),rate=Number(/rate=(\d+)/.exec(mime||'')?.[1])||24000;
    if(raw.byteLength<2)return;
    const pcm=new DataView(raw.buffer,raw.byteOffset,raw.byteLength),audio=this.context.createBuffer(1,Math.floor(raw.length/2),rate),dest=audio.getChannelData(0);
    for(let i=0;i<dest.length;i++)dest[i]=pcm.getInt16(i*2,true)/32768;
    const source=this.context.createBufferSource();source.buffer=audio;source.connect(this.context.destination);
    this.audioNext=Math.max(this.audioNext||0,this.context.currentTime+.035);source.start(this.audioNext);this.audioNext+=audio.duration;
  }
  stop(){
    if(this.closed)return;this.closed=true;
    if(this.ws?.readyState===WebSocket.OPEN){this.send({realtimeInput:{audioStreamEnd:true}});this.ws.close();}
    this.worklet?.disconnect();this.source?.disconnect();this.stream?.getTracks().forEach(t=>t.stop());this.context?.close().catch(()=>{});
    this.micOn=false;this.onStop();
  }
}
