const clamp=(n,min,max)=>Math.min(max,Math.max(min,n));
function propertiesForMode(field){const p=field?.property;return (typeof p==='string'?JSON.parse(p):p)?.range || [];}
export function profileFor(dps, schema=[]) {
  const field=code=>schema.find(x=>x.code===code);
  const resolve=(code,fallback)=>field(code)?.id?.toString() || fallback;
  const modern=typeof dps['20']==='boolean' && (typeof dps['21']==='string' || typeof dps['22']==='number');
  const legacy=typeof dps['1']==='boolean' && (typeof dps['2']==='string' || typeof dps['3']==='number');
  if (!modern && !legacy && !field('switch_led')) throw new Error('This device does not expose a recognized light schema. It has not been added to HomeKit.');
  const power=resolve('switch_led',modern?'20':'1');
  const mode=resolve('work_mode',modern?'21':'2');
  const brightness=resolve(modern?'bright_value_v2':'bright_value',modern?'22':'3');
  const temperature=resolve(modern?'temp_value_v2':'temp_value',modern?'23':'4');
  const color=resolve(modern?'colour_data_v2':'colour_data',modern?'24':'5');
  const property=field('bright_value_v2')?.property || field('bright_value')?.property;
  const range=typeof property==='string'?JSON.parse(property):property;
  const modes=propertiesForMode(field('work_mode'));
  return {power,mode,whiteMode:modes.includes('white') && typeof dps[brightness]==='number',brightness:typeof dps[brightness]==='number'?brightness:null,
    temperature:typeof dps[temperature]==='number'?temperature:null,
    color:typeof dps[color]==='string' && /^[0-9a-f]{12}$/i.test(dps[color])?color:null,
    min:range?.min ?? (modern?10:25), max:range?.max ?? (modern?1000:255), tempMax:modern?1000:255};
}
export function colorValue(dps,p) {
  const s=dps[p.color];
  if (!s || !/^[0-9a-f]{12}$/i.test(s)) throw new Error('The light has not reported a supported color value.');
  return {h:parseInt(s.slice(0,4),16),s:parseInt(s.slice(4,8),16),v:parseInt(s.slice(8,12),16)};
}
const hex=n=>Math.round(n).toString(16).padStart(4,'0');
export function readValue(dps,p,property) {
  if (property==='on' && typeof dps[p.power]==='boolean') return dps[p.power];
  if (property==='brightness') {
    if (p.color && dps[p.mode]==='colour') return clamp(Math.round(colorValue(dps,p).v/10),0,100);
    if (p.brightness && typeof dps[p.brightness]==='number') return clamp(Math.round(dps[p.brightness]*100/p.max),0,100);
  }
  if (property==='hue' && p.color) return colorValue(dps,p).h;
  if (property==='saturation' && p.color) return p.whiteMode && dps[p.mode]==='white'?0:clamp(colorValue(dps,p).s/10,0,100);
  if (property==='temperature' && p.temperature && typeof dps[p.temperature]==='number') {
    const kelvin=2700+(dps[p.temperature]/p.tempMax)*3800;
    return clamp(Math.round(1000000/kelvin),154,370);
  }
  throw new Error('The light has not reported this value.');
}
export function writeValues(dps,p,property,value) {
  if (property==='on' && typeof value==='boolean') return {[p.power]:value};
  if (typeof value!=='number' || !Number.isFinite(value)) throw new Error('Invalid light value.');
  if (property==='brightness' && p.brightness) {
    const percent=clamp(value,0,100);
    if (percent===0) return {[p.power]:false};
    if (p.color && dps[p.mode]==='colour') {
      const c=colorValue(dps,p); return {[p.color]:hex(c.h)+hex(c.s)+hex(percent*10)};
    }
    return {[p.brightness]:clamp(Math.round(percent*p.max/100),p.min,p.max)};
  }
  if (property==='temperature' && p.temperature) {
    const kelvin=1000000/clamp(value,154,370);
    return {[p.mode]:'white',[p.temperature]:clamp(Math.round((kelvin-2700)/3800*p.tempMax),0,p.tempMax)};
  }
  if ((property==='hue' || property==='saturation') && p.color) {
    const c=colorValue(dps,p);
    if(property==='saturation' && value===0 && p.whiteMode){
      const level=readValue(dps,p,'brightness');
      return {[p.mode]:'white',[p.brightness]:clamp(Math.round(level*p.max/100),p.min,p.max)};
    }
    if (property==='hue') c.h=clamp(value,0,360); else c.s=clamp(value*10,0,1000);
    return {[p.mode]:'colour',[p.color]:hex(c.h)+hex(c.s)+hex(c.v)};
  }
  throw new Error('This light does not support that control.');
}
