import http from 'node:http';

// A healthy HAP endpoint rejects unauthenticated requests with its protocol status.
// Test the listener, never read accessory data or change a light.
export function probeHomeKit(host,port=51847,timeout=2000) {
  return new Promise(resolve=>{
    let settled=false;
    let timer;
    const finish=value=>{if(!settled){settled=true;clearTimeout(timer);resolve(value);}};
    const request=http.get({host,port,path:'/accessories',agent:false},response=>{
      response.resume();finish(response.statusCode===470);
    });
    timer=setTimeout(()=>{request.destroy();finish(false);},timeout);
    request.on('error',()=>finish(false));
  });
}
