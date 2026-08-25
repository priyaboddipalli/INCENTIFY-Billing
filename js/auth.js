(() => {
'use strict';
const C=window.INCENTIFY_CONFIG,A=window.incentifyApi;
function token(){return localStorage.getItem(C.SESSION_KEY)||'';}
function user(){try{return JSON.parse(localStorage.getItem(C.USER_KEY)||'null')}catch(_){return null}}
function saveSession(t,u){localStorage.setItem(C.SESSION_KEY,t);localStorage.setItem(C.USER_KEY,JSON.stringify(u||{}));}
function clearSession(){localStorage.removeItem(C.SESSION_KEY);localStorage.removeItem(C.USER_KEY);}
async function validate(){const t=token();if(!t)return null;try{const r=await A.call('bootstrap',{token:t});localStorage.setItem(C.USER_KEY,JSON.stringify(r.user||{}));return r.user||null;}catch(_){clearSession();return null;}}
async function logout(){const t=token();try{if(t)await A.call('logout',{token:t,userAgent:navigator.userAgent});}catch(_){}clearSession();location.href='index.html';}
window.IncentifyAuth={token,user,saveSession,clearSession,validate,logout,require:async()=>{const u=await validate();if(!u){location.replace('index.html');throw new Error('Authentication required');}return u;},requireAdmin:async()=>{const u=await validate();if(!u||u.role!=='ADMIN'){location.replace(u?'erp.html':'index.html');throw new Error('Administrator access required');}return u;}};
})();
