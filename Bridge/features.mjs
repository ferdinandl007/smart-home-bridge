// Standard lighting feature encodings documented by Tuya:
// https://developer.tuya.com/en/docs/iot/product-function-definition?id=K9s9rhj576ypf
const titles={work_mode:'Light mode',countdown:'Countdown (seconds)',do_not_disturb:'Do not disturb after power loss',remote_switch:'Remote control',scene_data:'Scene settings',rhythm_mode:'Circadian rhythm',sleep_mode:'Sleep schedule',wakeup_mode:'Wake-up schedule',power_memory:'Power-on behavior',cycle_timing:'Repeating timer',random_timing:'Vacation timer',music_data:'Music stream',control_data:'Realtime color stream'};
export function properties(feature){return typeof feature.property==='string'?JSON.parse(feature.property):feature.property || {};}
export function featuresFor(config,dps){
 const basic=new Set(['switch_led','bright_value','bright_value_v2','temp_value','temp_value_v2','colour_data','colour_data_v2']);
 return (config.schema || []).filter(x=>!basic.has(x.code)).map(x=>{
  const p=properties(x);
  return {id:String(x.id),code:x.code,title:titles[x.code] || x.code.replaceAll('_',' '),type:p.type || x.type,editable:String(x.mode).includes('w'),value:dps[x.id] ?? null,min:p.min ?? 0,max:p.max ?? 1000,step:p.step ?? 1,options:p.range || [],maxlen:p.maxlen ?? 255};
 });
}
export function validateFeature(config,id,value){
 const feature=config.schema?.find(x=>String(x.id)===String(id));
 if(!feature || !String(feature.mode).includes('w'))throw new Error('This feature is not writable.');
 const p=properties(feature),type=p.type || feature.type;
 if(type==='bool' && typeof value!=='boolean')throw new Error('Expected an on/off value.');
 if(type==='enum' && !p.range?.includes(value))throw new Error('Unsupported mode.');
 if(type==='value' && (typeof value!=='number' || !Number.isFinite(value) || value<(p.min ?? 0) || value>(p.max ?? 1000) || !Number.isInteger((value-(p.min ?? 0))/(p.step ?? 1))))throw new Error('Value is outside this light’s supported range.');
 if(['string','raw'].includes(type) && (typeof value!=='string' || value.length>(p.maxlen ?? 255)))throw new Error('Invalid encoded setting length.');
 if(!['bool','enum','value','string','raw'].includes(type))throw new Error('Unsupported feature data type.');
 return {[String(id)]:value};
}
const hex=n=>Math.round(n).toString(16).padStart(4,'0');
export function sceneValues(config,profile,preset){
 const scene=config.schema?.find(x=>x.code==='scene_data' || x.code==='scene_data_v2');
 if(!scene)throw new Error('This light does not advertise scene support.');
 const unit=(speed,mode,h,s,v,b,t)=>speed.toString(16).padStart(2,'0').repeat(2)+mode.toString(16).padStart(2,'0')+[h,s,v,b,t].map(hex).join('');
 let encoded;
 switch(preset){
  case 'soft':encoded='00'+unit(15,0,0,0,0,200,0);break;
  case 'breathe':encoded='00'+unit(60,2,0,0,0,50,0)+unit(60,2,0,0,0,800,0);break;
  case 'rainbow':if(!profile.color)throw new Error('Color scenes require an RGB light.');encoded='00'+[0,60,120,180,240,300].map(h=>unit(50,2,h,1000,700,0,0)).join('');break;
  default:throw new Error('Unknown scene.');
 }
 validateFeature(config,scene.id,encoded);
 return {[profile.mode]:'scene',[scene.id]:encoded};
}
