import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {probeHomeKit} from '../Bridge/connectivity.mjs';

test('connection check requires an actual HomeKit authorization response',async()=>{
  const server=http.createServer((req,res)=>{res.writeHead(req.url==='/accessories'?470:200);res.end();});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {assert.equal(await probeHomeKit('127.0.0.1',server.address().port),true);}
  finally {await new Promise(resolve=>server.close(resolve));}
});
test('a closed or unrelated listener is not reported as working HomeKit',async()=>{
  const server=http.createServer((req,res)=>{res.end('unrelated');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  assert.equal(await probeHomeKit('127.0.0.1',port),false);
  await new Promise(resolve=>server.close(resolve));
  assert.equal(await probeHomeKit('127.0.0.1',port),false);
});
test('an unresponsive listener fails within the deadline',async()=>{
  const server=http.createServer(()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {assert.equal(await probeHomeKit('127.0.0.1',server.address().port,25),false);}
  finally {await new Promise(resolve=>server.close(resolve));}
});
