const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,'../dist/session-recorder.js'),'utf8');

function fixture({supported = ['video/webm;codecs=vp8'], autoStop = true, maxBytes} = {}) {
  const recorders = [], states = [], clones = [], timers = new Map();
  let timerId = 0;
  const originalVideo = {kind:'video',readyState:'live',stopped:0,stop(){this.stopped++;},clone() {
    const track = {kind:'video',stopped:0,stop(){this.stopped++;}};
    clones.push(track);
    return track;
  }};
  const originalAudio = {kind:'audio',stopped:0,stop(){this.stopped++;},clone(){assert.fail('Never clone audio');}};
  const stream = {getVideoTracks:()=>[originalVideo],getTracks:()=>[originalVideo,originalAudio]};
  class Stream {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
  }
  class Recorder extends EventTarget {
    static isTypeSupported(type) { return supported.includes(type); }
    constructor(input, options) {
      super();
      this.input = input;
      this.options = options;
      this.mimeType = options.mimeType;
      this.state = 'inactive';
      this.calls = [];
      recorders.push(this);
    }
    start(timeslice) { this.calls.push(['start',timeslice]);this.state = 'recording'; }
    pause() { this.calls.push(['pause']);this.state = 'paused'; }
    resume() { this.calls.push(['resume']);this.state = 'recording'; }
    stop() {
      this.calls.push(['stop']);this.state = 'inactive';
      if (autoStop) queueMicrotask(()=>this.dispatchEvent(new Event('stop')));
    }
    chunk(size) {
      const event = new Event('dataavailable');
      event.data = new Blob([new Uint8Array(size)],{type:this.mimeType});
      this.dispatchEvent(event);
    }
  }
  const context = vm.createContext({
    window:{MediaRecorder:Recorder,MediaStream:Stream}, Blob,
    setTimeout(callback,delay) { const id = ++timerId;timers.set(id,{callback,delay});return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  vm.runInContext(source,context,{filename:'session-recorder.js'});
  const recorder = new context.window.GhostingSessionRecorder({maxBytes,onState:state=>states.push(state)});
  return {recorder,recorders,states,clones,originalVideo,originalAudio,stream,context,timers};
}

test('recorder clones only existing video tracks and returns a supported WebM without touching source tracks', async () => {
  const f = fixture();
  assert.equal(f.recorder.start(f.stream),true);
  const media = f.recorders[0];
  assert.equal(media.mimeType,'video/webm;codecs=vp8');
  assert.equal(media.input.getTracks().length,1);
  assert.equal(media.input.getTracks()[0],f.clones[0]);
  assert.equal(media.options.videoBitsPerSecond,1200000);
  assert.deepEqual(media.calls,[['start',250]]);
  media.chunk(256);
  media.chunk(128);
  const blob = await f.recorder.stop();
  assert.equal(blob.size,384);
  assert.equal(blob.type,media.mimeType);
  assert.equal(f.clones[0].stopped,1);
  assert.equal(f.originalVideo.stopped,0);
  assert.equal(f.originalAudio.stopped,0);
  assert.equal(f.states.at(-1).kind,'ready');
  assert.equal(f.timers.size,0);
  assert.equal(await f.recorder.stop(),blob,'Repeated stops return the same clip');
});

test('MP4 is selected where WebM is unsupported, while unsupported or missing cameras create no tracks', async () => {
  const mp4 = fixture({supported:['video/mp4']});
  assert.equal(mp4.recorder.start(mp4.stream),true);
  mp4.recorders[0].chunk(100);
  assert.equal((await mp4.recorder.stop()).type,'video/mp4');
  const unsupported = fixture({supported:[]});
  const noCamera = fixture();
  noCamera.stream.getVideoTracks = () => [];
  for (const f of [unsupported,noCamera]) {
    assert.equal(f.recorder.start(f.stream),false);
    assert.equal(f.clones.length,0);
    assert.equal(f.recorders.length,0);
    assert.equal(f.states.at(-1).kind,'unsupported');
    assert.equal(await f.recorder.stop(),null);
  }
});

test('pause/resume is idempotent and keeps recording gaps out of the media session', async () => {
  const f = fixture();
  f.recorder.start(f.stream);
  const media = f.recorders[0];
  f.recorder.pause();
  f.recorder.pause();
  assert.equal(media.state,'paused');
  f.recorder.resume();
  f.recorder.resume();
  media.chunk(50);
  assert.deepEqual(media.calls,[['start',250],['pause'],['resume']]);
  await f.recorder.stop();
  f.recorder.pause();
  f.recorder.resume();
  assert.equal(media.calls.length,4);
});

test('a clip above the byte limit is discarded, never returned as a partial successful video', async () => {
  const f = fixture({maxBytes:100});
  f.recorder.start(f.stream);
  const media = f.recorders[0];
  media.chunk(80);
  media.chunk(21);
  media.chunk(50);
  const blob = await f.recorder.stop();
  assert.equal(blob,null);
  assert.equal(f.states.at(-1).kind,'too-large');
  assert.match(f.states.at(-1).message,/15MB/);
  assert.equal(f.clones[0].stopped,1);
  assert.equal(f.originalVideo.stopped,0);
});

test('empty output and recorder failures are explicit and release only the cloned tracks', async () => {
  const empty = fixture();
  empty.recorder.start(empty.stream);
  assert.equal(await empty.recorder.stop(),null);
  assert.equal(empty.states.at(-1).kind,'empty');
  const broken = fixture();
  broken.recorder.start(broken.stream);
  broken.recorders[0].chunk(100);
  broken.recorders[0].dispatchEvent(new Event('error'));
  assert.equal(await broken.recorder.stop(),null);
  assert.equal(broken.states.at(-1).kind,'error');
  assert.equal(broken.clones[0].stopped,1);
  assert.equal(broken.originalVideo.stopped,0);
});

test('aborting a take settles its stop promise and ignores late chunks from the discarded recorder', async () => {
  const f = fixture({autoStop:false});
  f.recorder.start(f.stream);
  const old = f.recorders[0];
  old.chunk(100);
  const pending = f.recorder.stop();
  f.recorder.abort();
  assert.equal(await pending,null);
  assert.equal(f.clones[0].stopped,1);
  f.recorder.start(f.stream);
  const current = f.recorders[1];
  current.chunk(40);
  const stateCount = f.states.length;
  old.chunk(999);
  old.dispatchEvent(new Event('stop'));
  assert.equal(f.states.length,stateCount,'Old recorder cannot finish or alter a new take');
  const next = f.recorder.stop();
  current.dispatchEvent(new Event('stop'));
  assert.equal((await next).size,40);
  assert.equal(f.clones[1].stopped,1);
  assert.equal(f.timers.size,0);
});

test('a stalled stop cannot hold the recording screen or camera clone indefinitely', async () => {
  const f = fixture({autoStop:false});
  f.recorder.start(f.stream);
  f.recorders[0].chunk(50);
  const pending = f.recorder.stop();
  const timeout = [...f.timers.values()][0];
  assert.equal(timeout.delay,2000);
  timeout.callback();
  assert.equal(await pending,null);
  assert.equal(f.states.at(-1).kind,'error');
  assert.equal(f.clones[0].stopped,1);
  assert.equal(f.originalVideo.stopped,0);
  assert.equal(f.timers.size,0);
});
