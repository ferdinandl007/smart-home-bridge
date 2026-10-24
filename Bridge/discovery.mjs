import dgram from 'node:dgram';
import os from 'node:os';
import crypto from 'node:crypto';
import parserModule from 'tuyapi/lib/message-parser.js';
const {MessageParser:Parser}=parserModule;

const key = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();
export function discoveryRequest(ip) {
  const payload = Buffer.from(JSON.stringify({from:'app', ip}));
  const iv = crypto.randomBytes(12);
  const header = Buffer.alloc(18);
  header.writeUInt32BE(0x6699, 0);
  header.writeUInt32BE(0, 6);
  header.writeUInt32BE(0x25, 10);
  header.writeUInt32BE(12 + payload.length + 16, 14);
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv);
  cipher.setAAD(header.subarray(4));
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([header, iv, encrypted, cipher.getAuthTag(), Buffer.from('00009966','hex')]);
}
export function decodeAnnouncement(packet, address) {
  const data = new Parser({key,version:'3.3'}).parse(packet)[0]?.payload;
  if (!data || typeof data !== 'object' || typeof data.gwId !== 'string') return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return null;
  return {id:data.gwId, ip:address, version:String(data.version || '3.3'), productKey:data.productKey || '', lastSeen:new Date().toISOString()};
}
export class Discovery {
  devices = new Map(); sockets = []; timer;
  constructor(onDevice, onError) { this.onDevice = onDevice; this.onError = onError; }
  async start() {
    try {
      for (const port of [6666,6667,7000]) {
        const socket = dgram.createSocket({type:'udp4',reuseAddr:true});
        this.sockets.push(socket);
        socket.on('message',(packet,remote)=>{
          try {
            const device = decodeAnnouncement(packet, remote.address);
            if (device) { this.devices.set(device.id,device); this.onDevice(device); }
          } catch { /* Other LAN applications also use these ports. */ }
        });
        await new Promise((resolve,reject)=>{
          socket.once('error',reject);
          socket.bind(port,()=>{socket.removeListener('error',reject); resolve();});
        });
        socket.on('error',()=>this.onError('Network discovery encountered a socket error. Check Local Network access.'));
      }
      this.probe();
      this.timer = setInterval(()=>this.probe(),60000);
    } catch (error) { this.stop(); throw error; }
  }
  probe() {
    for (const addresses of Object.values(os.networkInterfaces())) {
      for (const address of addresses || []) {
        if (address.family !== 'IPv4' || address.internal) continue;
        const parts=address.address.split('.').map(Number), mask=address.netmask.split('.').map(Number);
        const broadcast=parts.map((value,i)=>value | (255 ^ mask[i])).join('.');
        const socket=dgram.createSocket('udp4');
        socket.on('error',()=>socket.close());
        socket.bind(0,address.address,()=>{
          socket.setBroadcast(true);
          socket.send(discoveryRequest(address.address),7000,broadcast,()=>socket.close());
        });
      }
    }
  }
  stop() { clearInterval(this.timer); for (const s of this.sockets) { try { s.close(); } catch {} } this.sockets=[]; }
}
