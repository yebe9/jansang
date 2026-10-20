/* 잔상: dependencies 없이 실행되는 WebGL 1.0 움직임 실험. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const stage = $('stage');
  const LIMIT = 10000;
  const ui = {
    record: $('record'), play: $('play'), timeline: $('timeline'),
    caption: $('caption'), guide: $('stage-guide'),
  };
  let points = []; // { x, y: 0..1, t: ms, speed: stage heights/s, stroke }
  let mode = 'ready'; // ready | armed | recording | playing | paused
  let isExample = true;
  let duration = LIMIT;
  let cursor = LIMIT;
  let startedAt = 0;
  let lastFrame = 0;
  let activePointer = null;
  let stroke = 0;
  let lastInput = 0;
  let strokeWidth = 3;
  let colorMode = 'speed';
  let playbackRate = 1;
  let dirty = true;
  let gl, program, buffer, position, color, edge, opacity;
  let lost = false;
  const STRIDE = 7;
  const palette = [[.56,.52,.95],[.40,.83,.77],[.95,.80,.51],[1,.42,.34]];

  function announce(message) { $('announcement').textContent = message; }
  function timestamp(ms) { return (Math.max(0, ms) / 1000).toFixed(1).padStart(4, '0'); }
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  // 속도 기준은 화면 높이/초. 창 크기 대신 동작의 상대적 빠르기를 표현한다.
  function speedColor(speed) {
    if (colorMode === 'mono') return [.64,.86,.81];
    const value = clamp(speed / 1.7, 0, 1) * (palette.length - 1);
    const low = Math.min(palette.length - 2, Math.floor(value));
    const f = value - low;
    return palette[low].map((v, i) => v + (palette[low + 1][i] - v) * f);
  }

  function shader(type, source) {
    const s = gl.createShader(type);
    gl.shaderSource(s, source);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s));
    }
    return s;
  }

  function setupGL() {
    gl = canvas.getContext('webgl', { alpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available');
    const vs = shader(gl.VERTEX_SHADER, `
      attribute vec2 a_position;
      attribute vec3 a_color;
      attribute float a_edge;
      attribute float a_opacity;
      varying vec3 v_color;
      varying float v_edge;
      varying float v_opacity;
      void main() {
        gl_Position = vec4(a_position.x * 2.0 - 1.0, 1.0 - a_position.y * 2.0, 0.0, 1.0);
        v_color = a_color;
        v_edge = a_edge;
        v_opacity = a_opacity;
      }
    `);
    const fs = shader(gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec3 v_color;
      varying float v_edge;
      varying float v_opacity;
      void main() {
        float softness = pow(max(0.0, 1.0 - abs(v_edge)), 1.5);
        gl_FragColor = vec4(v_color, softness * v_opacity);
      }
    `);
    program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.useProgram(program);
    buffer = gl.createBuffer();
    position = gl.getAttribLocation(program, 'a_position');
    color = gl.getAttribLocation(program, 'a_color');
    edge = gl.getAttribLocation(program, 'a_edge');
    opacity = gl.getAttribLocation(program, 'a_opacity');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    [[position,2,0],[color,3,2],[edge,1,5],[opacity,1,6]].forEach(([loc,size,offset]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE * 4, offset * 4);
    });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.clearColor(20/255,28/255,32/255,1);
    lost = false;
    $('stage-error').hidden = true;
    resize();
  }

  function resize() {
    if (!gl || lost) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(stage.clientWidth * ratio);
    canvas.height = Math.round(stage.clientHeight * ratio);
    gl.viewport(0, 0, canvas.width, canvas.height);
    dirty = true;
    render();
  }

  // 삼각형 2개로 선분을 만든다. 넓고 흐린 선 + 좁고 밝은 선을 겹쳐 빛을 표현한다.
  function render() {
    if (!gl || lost) return;
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!points.length) return;
    const visible = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.t <= cursor) visible.push(p);
      else {
        const prev = points[i - 1];
        if (prev && prev.stroke === p.stroke && cursor > prev.t) {
          const f = (cursor - prev.t) / (p.t - prev.t);
          visible.push({ ...p, x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f, t: cursor });
        }
        break;
      }
    }
    const w = stage.clientWidth, h = stage.clientHeight;
    const data = [];
    function vertex(x,y,c,e,a) { data.push(x,y,...c,e,a); }
    function segment(a,b,width,alpha) {
      const dx = (b.x-a.x)*w, dy = (b.y-a.y)*h;
      const len = Math.hypot(dx,dy);
      if (len < .05) return;
      const nx = -dy/len*width/w, ny = dx/len*width/h;
      const c1 = speedColor(a.speed), c2 = speedColor(b.speed);
      vertex(a.x+nx,a.y+ny,c1,1,alpha);
      vertex(a.x-nx,a.y-ny,c1,-1,alpha);
      vertex(b.x+nx,b.y+ny,c2,1,alpha);
      vertex(b.x+nx,b.y+ny,c2,1,alpha);
      vertex(a.x-nx,a.y-ny,c1,-1,alpha);
      vertex(b.x-nx,b.y-ny,c2,-1,alpha);
    }
    // Slow portions have more weight; all points keep their original timing.
    for (const [scale,alpha] of [[5,.055],[2,.12],[.75,.74]]) {
      for (let i=1; i<visible.length; i++) {
        const a=visible[i-1],b=visible[i];
        if(a.stroke !== b.stroke) continue;
        segment(a,b,strokeWidth * scale * (1.2 - Math.min(b.speed/3,.5)),alpha);
      }
    }
    // A small cross at the current tip also makes a single click visible.
    const tip = visible[visible.length-1];
    if(tip) {
      const len = mode === 'playing' || mode === 'recording' ? 4 : 2;
      segment({...tip,x:tip.x-len/w},{...tip,x:tip.x+len/w},1,.8);
      segment({...tip,y:tip.y-len/h},{...tip,y:tip.y+len/h},1,.8);
    }
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, data.length/STRIDE);
    dirty = false;
  }

  function resetFeelings() {
    document.querySelectorAll('.feelings button').forEach(b => b.setAttribute('aria-pressed', 'false'));
    $('feeling-note').textContent = '정답 없이, 느껴지는 대로 골라보세요.';
  }

  function refresh() {
    const busy = mode === 'recording' || mode === 'armed';
    ui.record.disabled = lost;
    ui.record.classList.toggle('is-recording', busy);
    $('record-label').textContent = mode === 'recording' ? '기록 마치기' : mode === 'armed' ? '시작 취소' : '기록하기';
    $('record-duration').textContent = mode === 'recording' ? `${Math.max(0,(LIMIT-cursor)/1000).toFixed(1)} s` : '10 SEC';
    ui.play.disabled = busy || !points.length || lost;
    ui.timeline.disabled = busy || !points.length || lost;
    $('export').disabled = busy || !points.length || lost;
    $('example').disabled = busy || lost;
    $('clear').disabled = busy || !points.length || lost;
    $('playback-speed').disabled = busy || lost;
    $('play-icon').textContent = mode === 'playing' ? 'Ⅱ' : '▶';
    ui.play.setAttribute('aria-label', mode === 'playing' ? '재생 일시정지' : '움직임 재생');
    $('current-time').textContent = timestamp(cursor);
    $('total-time').textContent = timestamp(duration);
    ui.timeline.value = duration ? Math.round(cursor / duration * 1000) : 0;
    ui.timeline.setAttribute('aria-valuetext', `${timestamp(cursor)}초 / ${timestamp(duration)}초`);
    $('point-count').textContent = `${points.length.toString().padStart(3,'0')} POINTS`;
    $('state-dot').classList.toggle('recording', mode === 'recording');
    $('stage-status').textContent = ({ armed: 'READY / 움직임을 기다리는 중', recording: 'REC / 움직임 기록 중', playing: 'PLAY / 움직임 재생 중', paused: 'PAUSE / 잠시 멈춤' })[mode] || (points.length ? isExample ? 'EXAMPLE / 예시 움직임' : 'YOUR TRACE / 나의 움직임' : 'EMPTY / 새로운 시작');
    ui.guide.hidden = mode !== 'armed' && points.length > 0;
    ui.guide.querySelector('strong').textContent = mode === 'armed' ? '여기서 움직임을 시작하세요' : '어떤 움직임을 남겨볼까요?';
    ui.guide.querySelector('span:last-child').textContent = mode === 'armed' ? '누른 채 움직이면 기록됩니다 · 최대 10초' : '기록하기를 누르거나 예시를 불러오세요';
  }

  function addPoint(event, force=false) {
    const now = performance.now();
    if (!force && now-lastInput < 8) return;
    const rect = canvas.getBoundingClientRect();
    const t = clamp(now-startedAt,0,LIMIT);
    const p = {x:clamp((event.clientX-rect.left)/rect.width,0,1), y:clamp((event.clientY-rect.top)/rect.height,0,1), t, stroke, speed:0};
    const prev = points[points.length-1];
    if (prev && prev.stroke === stroke) {
      const distance = Math.hypot((p.x-prev.x)*rect.width/rect.height,p.y-prev.y);
      if (p.t <= prev.t) return;
      const raw = distance / ((p.t-prev.t)/1000);
      p.speed = prev.speed * .5 + raw * .5;
    }
    points.push(p);
    lastInput = now;
    dirty = true;
  }

  function releasePointer() {
    if (activePointer !== null && canvas.hasPointerCapture(activePointer)) canvas.releasePointerCapture(activePointer);
    activePointer = null;
  }

  function finishRecording() {
    if(mode !== 'recording') return;
    duration = Math.min(LIMIT,performance.now()-startedAt);
    cursor = duration;
    releasePointer();
    mode = 'ready';
    ui.caption.textContent = '움직임을 남겼어요. 재생한 뒤 색을 바꿔 느낌을 비교해보세요.';
    announce('기록을 마쳤습니다. 재생 버튼으로 움직임을 확인하세요.');
    dirty = true;
    refresh();
  }

  function record() {
    if (lost) return;
    if(mode === 'recording') { finishRecording(); return; }
    if(mode === 'armed') {
      mode = 'ready';
      ui.caption.textContent = '기록 시작을 취소했어요. 기존 움직임은 그대로 남아 있습니다.';
    } else {
      mode = 'armed';
      ui.caption.textContent = '무대를 누르는 순간 기록이 시작됩니다. 손을 떼면 선이 끊어지고, 다시 누르면 이어 그릴 수 있어요.';
      announce('기록 준비. 무대 위에서 마우스나 손가락을 누른 채 움직여보세요.');
      stage.scrollIntoView({block:'center',behavior:'instant'});
    }
    refresh();
  }

  function play() {
    if(ui.play.disabled) return;
    if(mode === 'playing') {
      mode = 'paused';
      ui.caption.textContent = '재생을 잠시 멈췄어요. 재생 버튼을 누르면 이어집니다.';
    }
    else {
      if(cursor >= duration) cursor = 0;
      mode = 'playing';
      lastFrame = performance.now();
      ui.caption.textContent = '입력했던 시간 그대로 재생 중입니다. 색상 모드를 바꿔 비교해보세요.';
    }
    dirty = true;
    refresh();
  }

  // 실제 사용자의 기록이 아닌, 시작 화면을 위한 합성 예시이다.
  function loadExample() {
    points = [];
    duration = LIMIT;
    cursor = LIMIT;
    mode = 'ready';
    isExample = true;
    const aspect = stage.clientWidth/stage.clientHeight;
    for(let i=0;i<=700;i++) {
      const t = i/700;
      const a = t*Math.PI*5.3;
      const envelope = .72 + .22*Math.sin(t*Math.PI);
      const x = .5 + Math.min(.34,.49/aspect)*Math.sin(a)*envelope + .055*Math.sin(a*2.4);
      const y = .5 + .28*Math.sin(a*1.47+.6)*envelope + .045*Math.cos(a*3.1);
      const p={x,y,t:Math.pow(t,1.15)*LIMIT,stroke:0,speed:0};
      const prev=points[points.length-1];
      if(prev) p.speed=Math.hypot((x-prev.x)*aspect,y-prev.y)/((p.t-prev.t)/1000);
      points.push(p);
    }
    resetFeelings();
    ui.caption.textContent = '예시 움직임이 표시되어 있어요. 재생하거나 나만의 움직임을 만들어보세요.';
    dirty = true;
    refresh();
    render();
  }

  canvas.addEventListener('pointerdown',event => {
    if(lost || !['armed','recording'].includes(mode) || activePointer !== null || event.button > 0) return;
    event.preventDefault();
    if(mode === 'armed') {
      points = [];
      startedAt = performance.now();
      cursor = 0;
      duration = LIMIT;
      isExample = false;
      stroke = 0;
      mode = 'recording';
      resetFeelings();
      announce('10초 동안 움직임을 기록합니다. 기록 마치기로 일찍 끝낼 수 있습니다.');
    }
    stroke++;
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    addPoint(event,true);
    refresh();
  });
  canvas.addEventListener('pointermove',event => {
    if(mode === 'recording' && activePointer === event.pointerId) addPoint(event);
  });
  canvas.addEventListener('pointerup',event => {
    if(activePointer === event.pointerId) { addPoint(event,true); releasePointer(); }
  });
  canvas.addEventListener('pointercancel',releasePointer);
  canvas.addEventListener('lostpointercapture',() => { activePointer = null; });
  ui.record.addEventListener('click',record);
  ui.play.addEventListener('click',play);
  $('example').addEventListener('click',loadExample);
  $('clear').addEventListener('click',() => {
    points=[];duration=0;cursor=0;mode='ready';isExample=false;dirty=true;
    resetFeelings();refresh();
    ui.caption.textContent = '무대를 비웠어요. 새로운 움직임을 만들어보세요.';
    announce('움직임을 지웠습니다.');
  });
  ui.timeline.addEventListener('input',() => {
    mode='paused';cursor=Number(ui.timeline.value)/1000*duration;dirty=true;refresh();
  });
  $('playback-speed').addEventListener('change',event => { playbackRate=Number(event.target.value); });
  $('width').addEventListener('input',event => {
    strokeWidth=Number(event.target.value);$('width-value').textContent=strokeWidth;dirty=true;
  });
  $('show-grid').addEventListener('change',event => { $('grid').hidden=!event.target.checked; });
  for(const type of ['speed','mono']) $('color-'+type).addEventListener('click',() => {
    colorMode=type;
    for(const other of ['speed','mono']) {
      $('color-'+other).classList.toggle('selected',other===type);
      $('color-'+other).setAttribute('aria-pressed',String(other===type));
    }
    $('color-scale').hidden=type==='mono';$('mono-note').hidden=type!=='mono';dirty=true;
  });
  document.querySelectorAll('.feelings button').forEach(button => button.addEventListener('click',() => {
    const selected=button.getAttribute('aria-pressed')==='true';
    document.querySelectorAll('.feelings button').forEach(b => b.setAttribute('aria-pressed','false'));
    button.setAttribute('aria-pressed',String(!selected));
    $('feeling-note').textContent=selected ? '정답 없이, 느껴지는 대로 골라보세요.' : `‘${button.textContent}’ 움직임으로 느꼈군요. (이번 화면에만 기록)`;
  }));
  $('export').addEventListener('click',() => {
    if(lost || !points.length) return;
    render();
    canvas.toBlob(blob => {
      if(!blob) { announce('이미지를 저장하지 못했습니다. 다시 시도해 주세요.');return; }
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download=`jansang-${Date.now()}.png`;link.click();
      setTimeout(() => URL.revokeObjectURL(url),10000);
      announce('잔상 PNG를 저장했습니다.');
    },'image/png');
  });
  document.addEventListener('keydown',event => {
    if(event.repeat || event.ctrlKey || event.metaKey || event.altKey || /^(INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY|A)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if(event.code==='KeyR') { event.preventDefault();record(); }
    if(event.code==='Space') { event.preventDefault();play(); }
    if(event.code==='Escape') {
      if(mode==='recording') finishRecording();
      else if(mode==='armed') record();
      else if(mode==='playing') play();
    }
  });
  document.addEventListener('visibilitychange',() => {
    if(document.hidden) {
      if(mode==='recording') finishRecording();
      if(mode==='playing') {
        mode='paused';
        ui.caption.textContent='화면을 벗어나 재생이 일시정지됐어요. 재생 버튼을 누르면 이어집니다.';
        refresh();
      }
    }
  });
  canvas.addEventListener('webglcontextlost',event => {
    event.preventDefault();
    if(mode==='recording') finishRecording();
    if(mode==='armed') mode='ready';
    if(mode==='playing') mode='paused';
    lost=true;$('stage-error').hidden=false;refresh();
    announce('그래픽 연결이 끊어졌습니다. 복구를 기다리거나 새로고침해 주세요.');
  });
  canvas.addEventListener('webglcontextrestored',() => { try { setupGL();refresh(); } catch { failGL(); } });
  function failGL() { lost=true;$('stage-error').hidden=false;refresh(); }
  function frame(now) {
    if(!lost && mode==='recording') {
      cursor=Math.min(now-startedAt,LIMIT);dirty=true;
      if(cursor>=LIMIT) finishRecording();
      else refresh();
    } else if(!lost && mode==='playing') {
      cursor=Math.min(duration,cursor+(now-lastFrame)*playbackRate);dirty=true;
      if(cursor>=duration) {
        mode='ready';
        ui.caption.textContent='재생을 마쳤어요. 색을 바꾸거나 재생 막대를 움직여 비교해보세요.';
        announce('재생을 마쳤습니다.');
      }
      refresh();
    }
    lastFrame=now;
    if(dirty && !lost) render();
    requestAnimationFrame(frame);
  }
  try { setupGL(); } catch(error) { console.error('WebGL initialization:',error);failGL(); }
  new ResizeObserver(resize).observe(stage);
  loadExample();
  requestAnimationFrame(frame);
})();
