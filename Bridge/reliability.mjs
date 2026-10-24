import fs from 'node:fs';
export async function deadline(operation, milliseconds=7000) {
 let timer;
 try{return await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The light did not respond in time. Try Recover Connection.')),milliseconds);})]);}
 finally{clearTimeout(timer);}
}
export function acquireEngineLock(file) {
 for(let attempt=0;attempt<2;attempt++){
  try{const fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,String(process.pid));fs.closeSync(fd);return ()=>{try{if(fs.readFileSync(file,'utf8')===String(process.pid))fs.unlinkSync(file);}catch{}};}
  catch(error){if(error.code!=='EEXIST')throw error;const pid=Number(fs.readFileSync(file,'utf8'));if(!Number.isInteger(pid)||pid<=0)throw new Error('The bridge lock is invalid. Close other bridge apps before recovery.');try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){fs.unlinkSync(file);continue;}throw e;}throw new Error('Another bridge engine is already running. Quit the other copy first.');}
 }
 throw new Error('Could not acquire the bridge lock.');
}
export async function setAll(lights,on){
 return Promise.all(lights.map(async light=>{try{await light.write('on',on);return {id:light.config.id,name:light.config.name,success:true};}catch(error){return {id:light.config.id,name:light.config.name,success:false,error:error.message};}}));
}
