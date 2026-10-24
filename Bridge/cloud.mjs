// LEDVANCE mobile API interoperability, adapted from FlagX's MIT-licensed
// ha-ledvance-tuya-resync-localkey. See THIRD-PARTY-NOTICES.md.
import crypto from 'node:crypto';
const clientId='fx3fvkvusmw45d7jn8xh';
const sdkKey='A_armptsqyfpxa4ftvtc739ardncett3uy_cgqx3ku34mh5qdesd7fcaru3gx7tyurr';
const signed=new Set(['a','v','lat','lon','lang','deviceId','imei','imsi','appVersion','ttid','isH5','h5Token','os','clientId','postData','time','requestId','n4h5','sid','sp','et']);
const md5=s=>crypto.createHash('md5').update(s).digest('hex');
export function mobileHash(data) { const h=md5(data); return h.slice(8,16)+h.slice(0,8)+h.slice(24,32)+h.slice(16,24); }
export function sign(data) {
  const input=Object.keys(data).sort().filter(k=>signed.has(k) && data[k]!==undefined && String(data[k]).length)
    .map(k=>`${k}=${k==='postData'?mobileHash(data[k]):data[k]}`).join('||');
  return crypto.createHmac('sha256',sdkKey).update(input).digest('hex');
}
function modPow(base,exp,mod) { let r=1n; while(exp>0n){if(exp&1n)r=r*base%mod;base=base*base%mod;exp>>=1n;}return r; }
export function encryptPassword(password,publicKey,exponent) {
  const value=BigInt('0x'+Buffer.from(md5(password)).toString('hex'));
  let encrypted=modPow(value,BigInt(exponent),BigInt(publicKey)).toString(16);
  if(encrypted.length%2)encrypted='0'+encrypted;
  return '0'.repeat(64)+encrypted;
}
export function createAccountSession({email,password,countryCode='41',region='EU'}) {
  const endpoints={EU:'https://a1.tuyaeu.com/api.json',US:'https://a1.tuyaus.com/api.json',CN:'https://a1.tuyacn.com/api.json',IN:'https://a1.tuyain.com/api.json'};
  if (!endpoints[region] || !email || !password || !/^\d{1,4}$/.test(countryCode)) throw new Error('Enter your SMART+ email, app password, and country calling code.');
  let sid;
  const api=async(a,data,extra={})=>{
    const params={appVersion:'1.1.6',appRnVersion:'5.14',channel:'oem',deviceId:'5fe5abb36728cce7b9cd2185625edccbd6d9bd787e40',platform:'Linux',requestId:crypto.randomUUID(),lang:'en',clientId,osSystem:'9',os:'Android',timeZoneId:'Europe/Zurich',ttid:'sdk_tuya@'+clientId,et:'0.0.1',v:'1.0',sdkVersion:'3.10.0',time:String(Math.floor(Date.now()/1000)),a,...extra};
    if(sid)params.sid=sid;
    const body=data===undefined?{}:{postData:JSON.stringify(data)};
    params.sign=sign({...params,...body});
    let response;
    try { response=await fetch(endpoints[region]+'?'+new URLSearchParams(params),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'TY-UA=APP/Android/1.1.6/SDK/null'},body:new URLSearchParams(body),signal:AbortSignal.timeout(20000)}); }
    catch { throw new Error('Could not reach the LEDVANCE account service. Check your connection and region.'); }
    if(!response.ok)throw new Error('The LEDVANCE account service returned an HTTP error.');
    const result=await response.json();
    if(!result.success) {
      if(result.errorCode==='USER_SESSION_INVALID')sid=undefined;
      const code=String(result.errorCode || 'UNKNOWN').replace(/[^A-Z0-9_]/g,'').slice(0,80);
      throw new Error(`LEDVANCE sign-in failed (${code}). Apple sign-in tokens are not supported. Use a SMART+ app password or enter local keys.`);
    }
    return result.result;
  };
  return async function devices() {
  if (!sid) {
  const token=await api('tuya.m.user.email.token.create',{countryCode:Number(countryCode),email});
  const login=await api('tuya.m.user.email.password.login',{countryCode,email,ifencrypt:1,options:'{"group": 1}',passwd:encryptPassword(password,token.publicKey,token.exponent),token:token.token});
  sid=login.sid;
  }
  const groups=await api('tuya.m.location.list');
  const devices=new Map();
  for(const group of groups) {
    const list=await api('tuya.m.my.group.device.list',undefined,{gid:String(group.groupId)});
    for(const entry of list) {
      const info=await api('tuya.m.device.get',{devId:entry.devId});
      if(info.localKey)devices.set(info.devId,{id:info.devId,name:info.name,key:info.localKey,schema:typeof info.schema==='string'?JSON.parse(info.schema):info.schema || []});
    }
  }
  return [...devices.values()];
  };
}
export async function importAccount(options) { return createAccountSession(options)(); }

