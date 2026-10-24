import {test} from 'node:test';
import assert from 'node:assert/strict';
import {profileFor,readValue,writeValues} from '../Bridge/light.mjs';
import {discoveryRequest,decodeAnnouncement} from '../Bridge/discovery.mjs';
import {mobileHash,encryptPassword,sign} from '../Bridge/cloud.mjs';
const white={'20':false,'21':'white','22':1000};
const rgb={...white,'21':'colour','24':'011203e803e8'};
test('a white-only light never advertises unsupported RGB or temperature',()=>{
 const p=profileFor(white);assert.equal(p.color,null);assert.equal(p.temperature,null);assert.equal(readValue(white,p,'on'),false);assert.equal(readValue(white,p,'brightness'),100);
 assert.throws(()=>writeValues(white,p,'hue',60));
});
test('unknown switches cannot be silently treated as lights',()=>{
 assert.throws(()=>profileFor({'1':true}));assert.throws(()=>profileFor({}));
});
test('brightness preserves RGB mode and current hue/saturation',()=>{
 const p=profileFor(rgb);const changes=writeValues(rgb,p,'brightness',25);
 assert.deepEqual(changes,{'24':'011203e800fa'});assert.equal(readValue({...rgb,...changes},p,'brightness'),25);
});
test('color edits preserve the other color components',()=>{
 const p=profileFor(rgb);assert.deepEqual(writeValues(rgb,p,'hue',60),{'21':'colour','24':'003c03e803e8'});
 assert.deepEqual(writeValues(rgb,p,'saturation',50),{'21':'colour','24':'011201f403e8'});
});
test('zero brightness turns the light off without changing its remembered level',()=>{
 const p=profileFor(white);assert.deepEqual(writeValues(white,p,'brightness',0),{'20':false});
 assert.deepEqual(writeValues(white,p,'brightness',1),{'22':10});
});
test('missing telemetry is unknown and does not become a false off state',()=>{
 const p=profileFor(white);assert.throws(()=>readValue({},p,'on'));assert.throws(()=>readValue({},p,'brightness'));
});
test('NaN and invalid power values are rejected',()=>{
 const p=profileFor(white);assert.throws(()=>writeValues(white,p,'brightness',NaN));assert.throws(()=>writeValues(white,p,'on','true'));
});
test('legacy brightness scales correctly',()=>{
 const d={'1':true,'2':'white','3':255},p=profileFor(d);assert.equal(readValue(d,p,'brightness'),100);assert.deepEqual(writeValues(d,p,'brightness',50),{'3':128});
});
test('temperature switches to white mode with valid bounds',()=>{
 const d={...rgb,'23':0},p=profileFor(d);assert.deepEqual(writeValues(d,p,'temperature',370),{'21':'white','23':1});assert.equal(readValue(d,p,'temperature'),370);
});
test('Tuya 3.5 discovery packet uses authenticated GCM framing',async()=>{
 const crypto=await import('node:crypto');const packet=discoveryRequest('192.0.2.1');
 assert.equal(packet.readUInt32BE(0),0x6699);assert.equal(packet.readUInt32BE(10),0x25);
 const key=crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
 const decipher=crypto.createDecipheriv('aes-128-gcm',key,packet.subarray(18,30));decipher.setAAD(packet.subarray(4,18));decipher.setAuthTag(packet.subarray(-20,-4));
 const plain=Buffer.concat([decipher.update(packet.subarray(30,-20)),decipher.final()]);
 assert.deepEqual(JSON.parse(plain),{from:'app',ip:'192.0.2.1'});
 assert.equal(packet.readUInt32BE(packet.length-4),0x9966);
});
test('unrelated LAN data is rejected',()=>{assert.throws(()=>decodeAnnouncement(Buffer.from('garbage'),'192.0.2.1'));});
test('mobile password encoding matches modular RSA and avoids plaintext',()=>{
 assert.equal(encryptPassword('example','999999999999999999999999999999999989','65537').startsWith('0'.repeat(64)),true);
 assert.equal(mobileHash('abc'),'3cd24fb09001509828e17f72d6963f7d');
 assert.equal(sign({a:'test',time:'1',ignored:'a'}),sign({a:'test',time:'1',ignored:'b'}));
});

test('schema validation rejects read-only, out-of-range, and unsupported values',async()=>{
 const {validateFeature}=await import('../Bridge/features.mjs');
 const config={schema:[{id:26,code:'countdown',mode:'rw',property:{type:'value',min:0,max:86400,step:1}},{id:21,code:'work_mode',mode:'rw',property:{type:'enum',range:['white','scene']}},{id:30,code:'rhythm_mode',mode:'ro',property:{type:'raw'}}]};
 assert.deepEqual(validateFeature(config,'26',300),{'26':300});assert.throws(()=>validateFeature(config,26,90000));assert.throws(()=>validateFeature(config,21,'music'));assert.throws(()=>validateFeature(config,30,'AAAA'));assert.throws(()=>validateFeature(config,26,NaN));
});
test('scene encodings preserve white-only device limitations',async()=>{
 const {sceneValues}=await import('../Bridge/features.mjs');
 const config={schema:[{id:25,code:'scene_data',mode:'rw',property:{type:'string',maxlen:255}}]};
 const profile=profileFor(white),soft=sceneValues(config,profile,'soft');
 assert.equal(soft['21'],'scene');assert.equal(soft['25'],'000f0f0000000000000000c80000');assert.throws(()=>sceneValues(config,profile,'rainbow'));
 const rainbow=sceneValues(config,profileFor(rgb),'rainbow');assert.equal(rainbow['25'].length,158);
});

test('RGBW zero saturation selects the dedicated white channel',()=>{
 const schema=[{id:21,code:'work_mode',property:{range:['white','colour','scene','music']}}];
 const p=profileFor(rgb,schema);assert.equal(p.whiteMode,true);
 assert.deepEqual(writeValues({...rgb,'24':'011203e801f4'},p,'saturation',0),{'21':'white','22':500});
 assert.equal(readValue({...rgb,'21':'white','22':250},p,'saturation'),0);
 assert.equal(readValue({...rgb,'21':'white','22':250},p,'brightness'),25);
});
test('RGBW nonzero saturation returns to color mode without changing white channel level',()=>{
 const schema=[{id:21,code:'work_mode',property:{range:['white','colour']}}];const p=profileFor(rgb,schema);
 assert.deepEqual(writeValues({...rgb,'21':'white','22':250},p,'saturation',50),{'21':'colour','24':'011201f403e8'});
});
test('RGB-only zero saturation remains an RGB control',()=>{
 const p=profileFor(rgb,[{id:21,code:'work_mode',property:{range:['colour','scene']}}]);
 assert.deepEqual(writeValues(rgb,p,'saturation',0),{'21':'colour','24':'0112000003e8'});
});

test('unresponsive operations time out instead of blocking the command queue',async()=>{
 const {deadline}=await import('../Bridge/reliability.mjs');await assert.rejects(deadline(()=>new Promise(()=>{}),10),/did not respond/);assert.equal(await deadline(()=>42,100),42);
});
test('all-lights commands report individual failures without hiding successful lights',async()=>{
 const {setAll}=await import('../Bridge/reliability.mjs');let value;
 const result=await setAll([{config:{id:'a',name:'Working'},write:async(p,v)=>{value=v;}},{config:{id:'b',name:'Offline'},write:async()=>{throw Error('offline');}}],false);
 assert.equal(value,false);assert.equal(result[0].success,true);assert.equal(result[1].success,false);
});

test('engine ownership lock rejects a second owner and releases cleanly',async()=>{
 const {acquireEngineLock}=await import('../Bridge/reliability.mjs');const fs=await import('node:fs');const os=await import('node:os');const path=await import('node:path');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shb-lock-'));const file=path.join(dir,'engine.pid');
 try {const release=acquireEngineLock(file);assert.throws(()=>acquireEngineLock(file),/already running/);release();assert.equal(fs.existsSync(file),false);const again=acquireEngineLock(file);again();}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
