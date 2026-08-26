(() => {
'use strict';
class IncentifyApiBridge {
  constructor(url){
    this.baseUrl=url;this.seq=0;this.pending=new Map();this.ready=false;this.readyWaiters=[];this.iframe=null;this.port=null;
    this.channel=(globalThis.crypto&&crypto.randomUUID)?crypto.randomUUID():('ch-'+Date.now()+'-'+Math.random().toString(36).slice(2));
    this._onMessage=this._onMessage.bind(this);window.addEventListener('message',this._onMessage);this._mount();
  }
  _mount(){
    const f=document.createElement('iframe');
    const sep=this.baseUrl.includes('?')?'&':'?';
    f.src=this.baseUrl+sep+'channel='+encodeURIComponent(this.channel);
    f.title='INCENTIFY secure API bridge';
    f.setAttribute('aria-hidden','true');
    f.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;border:0;left:-10000px;top:-10000px';
    document.documentElement.appendChild(f);this.iframe=f;
  }
  _isGoogleBridgeOrigin(origin){return /^https:\/\/([a-z0-9-]+\.)*(googleusercontent\.com|google\.com)$/i.test(String(origin||''));}
  _onMessage(event){
    const d=event.data||{};
    if(d.type==='INCENTIFY_BRIDGE_READY'&&d.channel===this.channel&&this._isGoogleBridgeOrigin(event.origin)){
      const p=event.ports&&event.ports[0];
      if(p){this.port=p;this.port.onmessage=e=>this._onPortMessage(e);if(this.port.start)this.port.start();}
      else if(!this.iframe||event.source!==this.iframe.contentWindow)return;
      this.ready=true;this.readyWaiters.splice(0).forEach(x=>x());return;
    }
    if(this.iframe&&event.source===this.iframe.contentWindow)this._handleResponse(d);
  }
  _onPortMessage(event){this._handleResponse(event.data||{});}
  _handleResponse(d){
    if(d.type!=='INCENTIFY_API_RESPONSE'||!d.id||d.channel!==this.channel)return;
    const p=this.pending.get(String(d.id));if(!p)return;
    this.pending.delete(String(d.id));clearTimeout(p.timer);const r=d.result||{};
    if(r.success===false){const e=new Error(r.message||r.error||'Server request failed');e.code=r.error||'SERVER_ERROR';e.details=r;p.reject(e);}else p.resolve(r);
  }
  waitReady(timeout=20000){if(this.ready)return Promise.resolve();return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error('Backend bridge did not become ready. Verify Apps Script deployment and Bridge.html.')),timeout);this.readyWaiters.push(()=>{clearTimeout(t);resolve();});});}
  async call(action,payload={},timeout=45000){
    await this.waitReady();const id='req-'+Date.now()+'-'+(++this.seq)+'-'+Math.random().toString(36).slice(2);const request={action,...payload};
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('Backend request timed out: '+action));},timeout);this.pending.set(id,{resolve,reject,timer});const msg={type:'INCENTIFY_API_REQUEST',id,request,channel:this.channel};if(this.port)this.port.postMessage(msg);else this.iframe.contentWindow.postMessage(msg,'*');});
  }
  destroy(){window.removeEventListener('message',this._onMessage);if(this.port)this.port.close();if(this.iframe)this.iframe.remove();}
}
window.IncentifyApiBridge=IncentifyApiBridge;
window.incentifyApi=new IncentifyApiBridge(window.INCENTIFY_CONFIG.BRIDGE_URL);
})();
