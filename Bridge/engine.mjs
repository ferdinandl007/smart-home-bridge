import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import readline from 'node:readline';
import TuyaDevice from 'tuyapi';
import hap from 'hap-nodejs';
import {Discovery} from './discovery.mjs';
import {profileFor,readValue,writeValues} from './light.mjs';
import {featuresFor,validateFeature,sceneValues} from './features.mjs';
import {createAccountSession} from './cloud.mjs';
import {deadline,acquireEngineLock,setAll} from './reliability.mjs';

process.umask(0o077);
const root=process.env.SHB_DATA_DIR || path.join(os.homedir(),'Library/Application Support/Smart Home Bridge');
fs.mkdirSync(root,{recursive:true,mode:0o700});
const releaseLock=acquireEngineLock(path.join(root,'engine.pid'));
process.on('exit',releaseLock);
hap.HAPStorage.setCustomStoragePath(path.join(root,'pairing'));
const identityPath=path.join(root,'identity.json');
let identity;
if(fs.existsSync(identityPath))identity=JSON.parse(fs.readFileSync(identityPath,'utf8'));
else {
  const code=String(crypto.randomInt(10000000,99999999));
  identity={username:[...crypto.randomBytes(6)].map(x=>x.toString(16).padStart(2,'0')).join(':').toUpperCase(),pincode:`${code.slice(0,3)}-${code.slice(3,5)}-${code.slice(5)}`,setupID:crypto.randomBytes(3).toString('hex').slice(0,4).toUpperCase()};
  fs.writeFileSync(identityPath,JSON.stringify(identity),{mode:0o600});
}
const emit=(event,data={})=>process.stdout.write('@SHB@'+JSON.stringify({event,...data})+'\n');
const {Bridge,Accessory,Service,Characteristic,Categories,HapStatusError,HAPStatus,uuid}=hap;
let bridge, published=false, stopping=false;
let accountSession, accountTimer, refreshingAccount=false;
async function refreshAccount() {
 if(!accountSession || refreshingAccount)return [];
 refreshingAccount=true;
 try {const devices=await accountSession();emit('accountDevices',{devices});return devices;}
 finally {refreshingAccount=false;}
}

const lights=new Map();
const discovery=new Discovery(device=>{
  const light=lights.get(device.id);
  if(light && light.config.ip!==device.ip){light.config.ip=device.ip;light.resetConnection();}
  emit('discovered',{device});
},message=>emit('notice',{message}));

class Light {
  queue=Promise.resolve(); dps={}; updated=0; online=false; client; service; accessory; error='';
  constructor(config){this.config=config;this.profile=config.profile;}
  serial(action){const result=this.queue.then(action);this.queue=result.catch(()=>{});return result;}
  resetConnection(){const client=this.client;this.client=undefined;if(client){client.disconnect();client.connect=async()=>{throw new Error('Connection retired.');};}this.online=false;this.updated=0;}
  async send(values){
    let timer;
    try {return await Promise.race([this.client.set({multiple:true,data:values}),new Promise((_,reject)=>{timer=setTimeout(()=>{this.resetConnection();reject(new Error('The light did not acknowledge the command.'));},8000);})]);}
    finally {clearTimeout(timer);}
  }
  async connect(){
    if(this.client?.isConnected())return;
    this.client?.disconnect();
    const client=new TuyaDevice({...this.config,issueGetOnConnect:false});
    this.client=client;
    client.on('error',()=>{if(this.client!==client)return;this.online=false;this.error='Local connection failed. Check the key, power, and whether SMART+ is holding a connection.';this.announce();});
    client.on('disconnected',()=>{if(this.client!==client)return;this.online=false;this.updated=0;this.announce();});
    client.on('data',data=>{if(this.client===client)this.ingest(data);});
    client.on('dp-refresh',data=>{if(this.client===client)this.ingest(data);});
    await deadline(()=>client.connect());
  }
  ingest(data){
    if(!data?.dps || typeof data.dps!=='object')return;
    this.dps={...this.dps,...data.dps};this.updated=Date.now();this.online=true;this.error='';
    this.sync();this.announce();
  }
  async refresh(force=false){
    try {
      await this.connect();
      if(force || Date.now()-this.updated>5000){
        const client=this.client;
        const response=await deadline(()=>client.get({schema:true}));
        if(this.client!==client)throw new Error('Connection replaced.');
        if(!response?.dps)throw new Error('No device state received.');
        this.ingest(response);
      }
      if(!this.online)throw new Error('The light is unavailable.');
      return this.dps;
    }catch(error){this.resetConnection();this.online=false;this.error='Could not read the light. Check the local key and close SMART+ temporarily.';this.announce();throw new Error(this.error);}
  }
  async verify(){return this.serial(async()=>{
    await this.refresh(true);
    this.profile=profileFor(this.dps,this.config.schema);
    this.config.profile=this.profile;
    return {...this.config};
  });}
  read(property){return this.serial(async()=>{await this.refresh();return readValue(this.dps,this.profile,property);});}
  write(property,value){return this.serial(async()=>{
    try{
      await this.refresh();
      const changes=writeValues(this.dps,this.profile,property,value);
      await this.send(changes);
      await this.refresh(true);
      for(const [key,value] of Object.entries(changes)){
        const actual=this.dps[key];
        if(typeof value==='number'?(typeof actual!=='number'||!Number.isFinite(actual)||Math.abs(actual-value)>1):actual!==value)throw new Error('The light did not confirm the requested change.');
      }
      return this.snapshot();
    }catch(error){this.error=error.message;this.announce();throw error;}
  });}
  featureState(){return {name:this.config.name,features:featuresFor(this.config,this.dps),color:!!this.profile?.color};}
  featureWrite(id,value){return this.serial(async()=>{
    await this.refresh();
    const values=validateFeature(this.config,id,value);
    await this.send(values);
    await this.refresh(true);
    // Write-only and encoded vendor DPs may acknowledge without echoing a value.
    // Keep their state unknown until the device reports it.
    return this.featureState();
  });}
  applyScene(preset){return this.serial(async()=>{
    await this.refresh();const values=sceneValues(this.config,this.profile,preset);
    await this.send(values);await this.refresh(true);return this.featureState();
  });}
  snapshot(){const state={id:this.config.id,name:this.config.name,ip:this.config.ip,online:this.online,error:this.error};
    if(this.online && this.profile)for(const prop of ['on','brightness','hue','saturation','temperature'])try{state[prop]=readValue(this.dps,this.profile,prop);}catch{}
    return state;
  }
  announce(){emit('light',{light:this.snapshot()});}
  attach(){
    if(this.accessory || !this.profile)return;
    const accessory=new Accessory(this.config.name,uuid.generate('smart-home-bridge:'+this.config.id));
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer,'LEDVANCE / OSRAM').setCharacteristic(Characteristic.Model,'SMART+ Wi-Fi').setCharacteristic(Characteristic.SerialNumber,this.config.id);
    const service=accessory.addService(Service.Lightbulb,this.config.name);
    this.service=service;this.accessory=accessory;
    const bind=(characteristic,property)=>service.getCharacteristic(characteristic)
      .onGet(async()=>{try{return await this.read(property);}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}})
      .onSet(async(value)=>{try{await this.write(property,value);}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}});
    bind(Characteristic.On,'on');
    if(this.profile.brightness)bind(Characteristic.Brightness,'brightness');
    if(this.profile.temperature){service.getCharacteristic(Characteristic.ColorTemperature).setProps({minValue:154,maxValue:370});bind(Characteristic.ColorTemperature,'temperature');}
    if(this.profile.color){bind(Characteristic.Hue,'hue');bind(Characteristic.Saturation,'saturation');}
    for(const feature of featuresFor(this.config,this.dps).filter(x=>x.type==='bool' && x.editable)){
      const extra=accessory.addService(Service.Switch,feature.title,'feature-'+feature.id);
      extra.getCharacteristic(Characteristic.On)
        .onGet(async()=>{try{return await this.serial(async()=>{await this.refresh();const value=this.dps[feature.id];if(typeof value!=='boolean')throw new Error('Unknown');return value;});}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}})
        .onSet(async value=>{try{await this.featureWrite(feature.id,value);}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}});
    }
    const modes=featuresFor(this.config,this.dps).find(x=>x.code==='work_mode');
    if(modes?.options.includes('scene')){
      const sceneSwitch=accessory.addService(Service.Switch,'Scene mode','scene-mode');
      sceneSwitch.getCharacteristic(Characteristic.On)
        .onGet(async()=>{try{await this.serial(()=>this.refresh());return this.dps[this.profile.mode]==='scene';}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}})
        .onSet(async value=>{try{await this.featureWrite(modes.id,value?'scene':this.profile.color?'colour':'white');}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}});
    }
    if(this.profile.color && this.profile.whiteMode){
      const whiteSwitch=accessory.addService(Service.Switch,'White mode','white-mode');
      whiteSwitch.getCharacteristic(Characteristic.On)
        .onGet(async()=>{try{await this.serial(()=>this.refresh());return this.dps[this.profile.mode]==='white';}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}})
        .onSet(async value=>{try{const mode=featuresFor(this.config,this.dps).find(x=>x.code==='work_mode');if(!mode)throw new Error('Mode unavailable');await this.featureWrite(mode.id,value?'white':'colour');}catch{throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);}});
    }
    bridge.addBridgedAccessory(accessory);
    this.sync();
  }
  sync(){
    if(!this.service || !this.profile || !this.online)return;
    for(const feature of featuresFor(this.config,this.dps).filter(x=>x.type==='bool')){
      if(typeof this.dps[feature.id]==='boolean')this.accessory?.getServiceById(Service.Switch,'feature-'+feature.id)?.updateCharacteristic(Characteristic.On,this.dps[feature.id]);
    }
    this.accessory?.getServiceById(Service.Switch,'white-mode')?.updateCharacteristic(Characteristic.On,this.dps[this.profile.mode]==='white');
    this.accessory?.getServiceById(Service.Switch,'scene-mode')?.updateCharacteristic(Characteristic.On,this.dps[this.profile.mode]==='scene');
    for(const [type,prop] of [[Characteristic.On,'on'],[Characteristic.Brightness,'brightness'],[Characteristic.ColorTemperature,'temperature'],[Characteristic.Hue,'hue'],[Characteristic.Saturation,'saturation']]){
      if(!this.service.testCharacteristic(type))continue;
      try{this.service.updateCharacteristic(type,readValue(this.dps,this.profile,prop));}catch{}
    }
  }
}
function validateConfig(config){
  if(!config || typeof config.id!=='string' || !/^[a-zA-Z0-9_-]{5,80}$/.test(config.id))throw new Error('A valid device ID is required.');
  if(typeof config.key!=='string' || Buffer.byteLength(config.key)!==16)throw new Error('The local key must contain exactly 16 bytes.');
  if(!/^\d{1,3}(\.\d{1,3}){3}$/.test(config.ip || '') || config.ip.split('.').some(x=>Number(x)>255))throw new Error('A local IPv4 address is required.');
  if(!['3.1','3.2','3.3','3.4','3.5'].includes(String(config.version)))throw new Error('Unsupported Tuya protocol version.');
  if(!config.name?.trim())throw new Error('Give the light a name.');
}
function bridgeState(){return {running:published,paired:bridge?._accessoryInfo?.paired() || false,pincode:identity.pincode,uri:published?bridge.setupURI():'',count:[...lights.values()].filter(x=>x.accessory).length};}
async function startBridge(){
  if(published)return bridgeState();
  bridge ||= new Bridge('SMART+ HomeKit Bridge',uuid.generate(identity.username));
  bridge.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer,'SMART+ HomeKit Bridge').setCharacteristic(Characteristic.Model,'SMART+ HomeKit Bridge').setCharacteristic(Characteristic.SerialNumber,identity.username);
  for(const light of lights.values())light.attach();
  bridge.on('paired',()=>emit('bridge',bridgeState()));
  bridge.on('unpaired',()=>emit('bridge',bridgeState()));
  await bridge.publish({...identity,port:51847,category:Categories.BRIDGE,advertiser:hap.MDNSAdvertiser.CIAO});
  published=true;emit('bridge',bridgeState());return bridgeState();
}
async function stopBridge(){if(published)await bridge.unpublish();published=false;emit('bridge',bridgeState());return bridgeState();}
const dispatch=async(method,params={})=>{
  switch(method){
    case 'scan':discovery.probe();await new Promise(r=>setTimeout(r,12000));return [...discovery.devices.values()];
    case 'status':return {bridge:bridgeState(),devices:[...discovery.devices.values()],lights:[...lights.values()].map(x=>x.snapshot())};
    case 'account': {
      accountSession=createAccountSession(params);
      const devices=await refreshAccount();
      clearInterval(accountTimer);
      accountTimer=setInterval(()=>refreshAccount().catch(()=>emit('notice',{message:'Automatic account refresh failed. Check your login and internet connection in Setup.'})),120000);
      return devices;
    }
    case 'refreshAccount': return refreshAccount();
    case 'configure':{
      validateConfig(params);
      let light=lights.get(params.id);
      if(light){light.config={...light.config,...params};light.resetConnection();}
      else {light=new Light(params);lights.set(params.id,light);}
      try{const config=await light.verify();if(bridge)light.attach();light.announce();return config;}
      catch(error){light.resetConnection();light.error=error.message;light.announce();emit('notice',{message:params.name+': '+error.message});throw error;}
    }
    case 'restore':{
      for(const config of params.devices || []){
        try{validateConfig(config);const light=new Light(config);lights.set(config.id,light);light.announce();}catch{emit('notice',{message:'A saved light has incomplete connection details. Reconnect it from setup.'});}
      }
      return {restored:lights.size};
    }
    case 'verifyAll':{
      const verified=[];
      for(const light of lights.values())try{const config=await light.verify();if(bridge)light.attach();verified.push(config);}catch{}
      return verified;
    }
    case 'start':return startBridge();
    case 'stop':return stopBridge();
    case 'allPower':if(typeof params.on!=='boolean')throw new Error('Invalid power value.');return setAll([...lights.values()],params.on);
    case 'write':{const light=lights.get(params.id);if(!light)throw new Error('Connect this light first.');return light.write(params.property,params.value);}
    case 'features':{const light=lights.get(params.id);if(!light)throw new Error('Connect this light first.');return light.serial(async()=>{await light.refresh(true);const ids=(light.config.schema || []).filter(x=>String(x.mode).includes('r')).map(x=>Number(x.id));try{light.ingest(await light.client.refresh({requestedDPS:ids,schema:true}));}catch{}return light.featureState();});}
    case 'featureWrite':{const light=lights.get(params.id);if(!light)throw new Error('Connect this light first.');return light.featureWrite(params.featureID,params.value);}
    case 'scene':{const light=lights.get(params.id);if(!light)throw new Error('Connect this light first.');return light.applyScene(params.preset);}
    case 'remove':{const light=lights.get(params.id);if(light){light.resetConnection();if(light.accessory)bridge.removeBridgedAccessory(light.accessory);lights.delete(params.id);}return true;}
    case 'shutdown':await shutdown();return true;
    default:throw new Error('Unknown bridge operation.');
  }
};
async function shutdown(){if(stopping)return;stopping=true;setTimeout(()=>process.exit(0),3000).unref();clearInterval(parentWatch);clearInterval(accountTimer);clearInterval(poll);discovery.stop();for(const light of lights.values())light.resetConnection();await stopBridge();setTimeout(()=>process.exit(0),50);}
const parentPID=Number(process.env.SHB_PARENT_PID || 0);
const parentWatch=setInterval(()=>{if(parentPID && process.ppid!==parentPID)void shutdown();},1000);
const poll=setInterval(()=>{for(const light of lights.values())light.serial(()=>light.refresh(true)).catch(()=>{});},15000);
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>void shutdown());
const input=readline.createInterface({input:process.stdin});
input.on('line',async line=>{
  let request;
  try{request=JSON.parse(line);const result=await dispatch(request.method,request.params);emit('reply',{requestID:request.requestID,result});}
  catch(error){emit('reply',{requestID:request?.requestID,error:error.message || 'Bridge operation failed.'});}
});
input.on('close',()=>void shutdown());
process.on('uncaughtException',()=>{emit('fatal',{message:'The bridge engine stopped unexpectedly. Restart it from the app.'});void shutdown();});
await discovery.start().catch(()=>emit('notice',{message:'Discovery is unavailable. Allow Local Network access in System Settings, then restart the app.'}));
emit('ready');
