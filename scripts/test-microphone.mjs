import assert from 'node:assert/strict';
import { createMicrophone } from '../pico-ui/src/microphone.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { handleVoice } from '../bridge/voice.mjs';

let recorder, stopped=0, uploads=0;
class Recorder {
  static isTypeSupported(type) { return type.startsWith('audio/webm'); }
  constructor(stream, {mimeType}) { this.mimeType=mimeType;this.state='inactive';recorder=this; }
  start() { this.state='recording'; }
  stop() { this.state='inactive';this.ondataavailable({data:new Blob(['audio'])});queueMicrotask(()=>this.onstop()); }
}
const stream=()=>({getTracks:()=>[{stop:()=>stopped++}]});
const states=[], transcripts=[];
const mic=createMicrophone({Recorder,mediaDevices:{getUserMedia:async()=>stream()},onState:s=>states.push(s),onTranscript:t=>transcripts.push(t),fetchImpl:async(_, options)=>{
  uploads++;assert.equal(options.body.type,'audio/webm;codecs=opus');return Response.json({text:'Open the test page'});
}});
await mic.start();assert.equal(states.at(-1).phase,'recording');
mic.finish();await new Promise(r=>setTimeout(r,20));
assert.deepEqual(transcripts,['Open the test page']);assert.equal(stopped,1);
let speaking = true;
class AudioContext {
  createMediaStreamSource() { return {connect(){}}; }
  createAnalyser() { return {fftSize:1024,getByteTimeDomainData(samples){samples.fill(speaking ? 155 : 128);}}; }
  close() { return Promise.resolve(); }
}
const voiceTurns=[];
let speechTicks=0;
const handsFree=createMicrophone({Recorder,AudioContext,silenceMs:140,mediaDevices:{getUserMedia:async()=>stream()},
  onLevel:l=>{if(speaking&&l>0)speechTicks++;},
  onTranscript:t=>voiceTurns.push(t),fetchImpl:async()=>Response.json({text:'Find the test project'})});
await handsFree.start();
// Speech for as long as the detector needs to hear it (four of its ticks is 240ms or more),
// then silence until it sends: waited for, not timed, so a busy machine cannot fail it.
for(let w=0;speechTicks<4&&w<3000;w+=20)await new Promise(r=>setTimeout(r,20));
speaking=false;
for(let w=0;!voiceTurns.length&&w<3000;w+=20)await new Promise(r=>setTimeout(r,20));
assert.deepEqual(voiceTurns,['Find the test project'],'Speech ending in silence must send without a click');
await mic.start();mic.cancel();await new Promise(r=>setTimeout(r,20));
assert.equal(uploads,1,'Cancelled recordings must never upload');assert.equal(stopped,4);
let grant;
const pending=createMicrophone({Recorder,mediaDevices:{getUserMedia:()=>new Promise(r=>grant=r)}});
const starting=pending.start();pending.cancel();grant(stream());await starting;
assert.equal(stopped,5,'Permission granted after cancellation must immediately release its tracks');
const denied=[];
await createMicrophone({Recorder,mediaDevices:{getUserMedia:async()=>{throw Object.assign(new Error(),{name:'NotAllowedError'});}},onState:s=>denied.push(s)}).start();
assert.match(denied.at(-1).message,/permission was denied/);
let resolveTranscript;
const delayed=createMicrophone({Recorder,mediaDevices:{getUserMedia:async()=>stream()},onTranscript:t=>transcripts.push(t),fetchImpl:()=>new Promise(r=>resolveTranscript=r)});
await delayed.start();delayed.finish();await new Promise(r=>setTimeout(r,10));delayed.cancel();resolveTranscript(Response.json({text:'stale request'}));await new Promise(r=>setTimeout(r,20));
assert.equal(transcripts.length,1,'Transcription completed in an old chat must not submit');

let seen=0;
const server=createServer((req,res)=>handleVoice(req,res,req.url,{
  config:async()=>({key:'test'}),fetchImpl:async(url,options)=>{
    seen++;assert.equal(url,'https://api.elevenlabs.io/v1/speech-to-text');
    assert.equal(options.body.get('model_id'),'scribe_v2');assert.equal(options.body.get('file').type,'audio/webm');
    return Response.json({text:'Find the test project'});
  },
}));
server.listen(0,'127.0.0.1');await once(server,'listening');
const base=`http://127.0.0.1:${server.address().port}`;
try {
  const post=(type,body,headers={})=>fetch(`${base}/voice/transcribe`,{method:'POST',headers:{'Content-Type':type,...headers},body});
  assert.equal((await post('text/plain','audio')).status,415);
  assert.equal((await post('audio/webm','')).status,400);
  assert.equal((await post('audio/webm','audio',{Origin:'https://another.example'})).status,403);
  assert.deepEqual(await (await post('audio/webm;codecs=opus','audio')).json(),{text:'Find the test project'});
  assert.equal(seen,1);
} finally {server.close();server.closeAllConnections();}
console.log('Microphone recording, permissions, cleanup, cancellation, stale transcript isolation and transcription proxy passed.');
