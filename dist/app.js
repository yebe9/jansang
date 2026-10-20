/* 잔상: WebGL 렌더링 + 시작 → 기록(일시정지) → 결과 상태 흐름. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const stage = $('stage');
  const dialog = $('start-dialog');
  const resultDialog = $('result-dialog');
  const workspace = $('workspace');
  const LIMIT = 10000;
  let points = []; // { x, y, t, speed, stroke }
  let view = 'intro';
  let mode = 'idle';
  let isExample = false;
  let duration = LIMIT;
  let cursor = 0;
  let elapsed = 0; // 완료된 기록 구간의 누적 시간. 일시정지 시간은 제외.
  let startedAt = 0;
  let lastFrame = 0;
  let activePointer = null;
  let stroke = 0;
  let lastInput = 0;
  let captureAspect = 1;
  let strokeWidth = 3;
  let colorMode = 'speed';
  let playbackRate = 1;
  let dirty = true;
  let intendedFeeling = '';
  let inputMode = 'pointer';
  let captureSource = 'pointer';
  let camera = null;
  let cameraKind = 'loading';
  let cameraMessage = '';
  let cameraReady = false;
  let cameraRequested = false;
  let poseFrames = [];
  let poseSegment = 0;
  let wristTracks = new Map();
  let analysis = null;
  let analysisKind = 'local';
  let motionReport = null;
  let analysisMessage = '';
  let analysisBusy = false;
  let analysisController = null;
  let takeId = 0;
  let gl, program, buffer, position, color, edge, opacity;
  let lost = false;
  const STRIDE = 7;
  const palette = [[.56,.52,.95],[.40,.83,.77],[.95,.80,.51],[1,.42,.34]];
  const clamp = (value,min,max) => Math.min(max,Math.max(min,value));
  const timestamp = (ms) => (Math.max(0,ms)/1000).toFixed(1).padStart(4,'0');
  function announce(message) { $('announcement').textContent = message; }
  function recordTime(now=performance.now()) {
    return clamp(elapsed + (mode === 'recording' ? now-startedAt : 0),0,LIMIT);
  }
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
    gl.clearColor(17/255,27/255,32/255,1);
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
    dirty = false;
    if (!points.length) return;
    const visible = [];
    const lastByStroke = new Map();
    const interpolated = new Set();
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (p.t <= cursor) {
        visible.push(p);
        lastByStroke.set(p.stroke, p);
      } else if (!interpolated.has(p.stroke)) {
        const prev = lastByStroke.get(p.stroke);
        if (prev && cursor > prev.t) {
          const f = (cursor - prev.t) / (p.t - prev.t);
          visible.push({ ...p, x: prev.x + (p.x - prev.x) * f, y: prev.y + (p.y - prev.y) * f, t: cursor });
        }
        interpolated.add(p.stroke);
      }
    }
    const w = stage.clientWidth, h = stage.clientHeight;
    // 결과 화면에서도 기록 당시의 가로세로 비율을 보존한다.
    if(view === 'result' || captureSource === 'webcam') {
      const sx = Math.min(1,captureAspect/(w/h)) * .88;
      const sy = Math.min(1,(w/h)/captureAspect) * .88;
      for(let i=0;i<visible.length;i++) {
        const p=visible[i];
        visible[i]={...p,x:.5+(p.x-.5)*sx,y:.5+(p.y-.5)*sy};
      }
    }
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
      const previous = new Map();
      for (const b of visible) {
        const a = previous.get(b.stroke);
        if(a) segment(a,b,strokeWidth * scale * (1.2 - Math.min(b.speed/3,.5)),alpha);
        previous.set(b.stroke, b);
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

  function setView(next) {
    if(next !== 'result' && resultDialog.open) closeResult(false);
    view = next;
    document.body.dataset.view = next;
    const result = next === 'result';
    for (const id of ['result-heading','transport','result-caption']) $(id).hidden = !result;
    $('result-panel').hidden = !result || !resultDialog.open;
    $('reopen-result').hidden = !result || resultDialog.open;
    $('record-dock').hidden = next !== 'drawing';
    $('drawing-hint').hidden = next !== 'drawing';
    $('tool-rail').hidden = next !== 'drawing';
    $('intro-action').hidden = next !== 'intro';
    $('camera-panel').hidden = next !== 'drawing' || captureSource !== 'webcam';
    for(const [id,active] of [['step-start',next==='intro'],['step-draw',next==='drawing'],['step-result',result]]) {
      if(active) $(id).setAttribute('aria-current','step');
      else $(id).removeAttribute('aria-current');
    }
    closeSettings(false);
    resize();
  }

  function resetFeelings() {
    intendedFeeling = '';
    $('intent-detail').value = '';
    document.querySelectorAll('.feelings button').forEach(b=>b.setAttribute('aria-pressed','false'));
    updateComparison();
  }

  function updateComparison() {
    const detail = $('intent-detail').value.trim();
    $('intent-word').textContent = intendedFeeling || (detail ? '나만의 표현' : '선택 전');
    $('intent-summary').textContent = detail || (intendedFeeling ? '내가 이 움직임으로 표현하려던 느낌입니다.' : '표현하려던 느낌을 위에서 남겨주세요.');
    $('feeling-note').textContent = intendedFeeling || detail ? '의도를 남겼어요. 서버로 보내지 않고 이 화면에만 보관합니다.' : '단어를 고르거나 직접 적어주세요. 이 화면에만 남습니다.';
    const ai = analysisKind === 'ai';
    $('analysis-badge').textContent = analysisBusy ? 'AI 해석 중' : ai ? 'Gemini 해석' : isExample ? '합성 예시 · 수치 분석' : '기본 수치 분석';
    $('reading-label').textContent = ai ? '02 / AI READING' : '02 / MOVEMENT READING';
    $('reading-title').textContent = ai ? 'AI가 읽은 인상' : '움직임의 특징';
    $('ai-word').textContent = analysis?.impression || '기록 전';
    $('ai-summary').textContent = analysis?.description || '움직임을 남기면 분석이 시작됩니다.';
    $('analysis-status').textContent = analysisMessage;
    $('analysis-evidence').hidden = !analysis;
    $('analysis-observations').replaceChildren(...(analysis?.observations || []).map(text => {
      const li = document.createElement('li'); li.textContent = text; return li;
    }));
    $('analysis-caveat').textContent = analysis?.caveat || '';
    $('analyze-button').disabled = analysisBusy || !motionReport?.sufficient;
    $('analyze-button').textContent = analysisBusy ? '움직임을 읽고 있어요…' : ai ? 'AI로 다시 해석하기 ↗' : 'AI로 움직임 해석하기 ↗';
    $('analyze-button').setAttribute('aria-busy', String(analysisBusy));
    if (!intendedFeeling && !detail) {
      $('comparison-verdict').textContent = '내 의도를 먼저 남겨보세요.';
      $('comparison-explanation').textContent = '해석과 내 의도를 비교해보세요. 같은 움직임의 어떤 부분을 서로 다르게 읽었을까요?';
    } else {
      $('comparison-verdict').textContent = '내가 담은 느낌과 읽힌 인상';
      $('comparison-explanation').textContent = '나는 ‘' + (intendedFeeling || detail) + '’을 담았고, ' +
        (ai ? 'AI는' : '수치 분석은') + ' ‘' + (analysis?.impression || '분석 대기') +
        '’을 보여줍니다. 움직임에서 읽은 근거와 내 의도 사이에 어떤 차이가 있나요?';
    }
  }

  function clearAnalysis() {
    takeId++;
    analysisController?.abort();
    analysisController = null;
    analysisBusy = false;
    analysis = null;
    motionReport = null;
    analysisKind = 'local';
    analysisMessage = '';
  }

  function analyzeMovement() {
    motionReport = window.JansangMotion.analyze({source:captureSource, points, poseFrames, durationMs:duration, captureAspect});
    analysis = motionReport.local;
    analysisKind = 'local';
    analysisMessage = motionReport.sufficient
      ? '현재 기록의 속도·멈춤·공간 사용을 계산한 기본 분석입니다. 생성형 AI 해석과는 구분됩니다.'
      : '분석할 움직임이 짧거나 인식한 관절이 부족합니다. 1초 이상 움직임을 남겨주세요.';
    updateComparison();
    if ($('ai-consent').checked && motionReport.sufficient && !isExample) requestAI();
  }

  function apiBase() {
    const configured = (window.JANSANG_CONFIG?.apiBase || '').trim().replace(/\/+$/, '');
    if (configured) {
      const url = new URL(configured);
      if (url.protocol !== 'https:') throw new Error('AI 서버 주소는 HTTPS여야 합니다.');
      return configured;
    }
    if (['localhost','127.0.0.1','[::1]'].includes(location.hostname)) return '';
    throw new Error('AI 서버가 아직 연결되지 않았습니다. 현재는 기본 수치 분석을 볼 수 있어요. Gemini 키와 서버 연결 후 AI 해석이 켜집니다.');
  }

  async function requestAI() {
    if (analysisBusy || !motionReport?.sufficient) return;
    const id = takeId;
    const controller = new AbortController();
    analysisController = controller;
    const timeout = setTimeout(() => controller.abort(), 50000);
    analysisBusy = true;
    analysisMessage = '움직임 좌표를 바탕으로 인상을 읽고 있어요. 영상과 내 의도는 보내지 않습니다.';
    updateComparison();
    try {
      const base = apiBase();
      const response = await fetch(base + '/api/analyze', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(motionReport.payload), signal:controller.signal, credentials:'omit'
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error?.message || 'AI 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.');
      const result = data?.analysis;
      if (!result || typeof result.impression !== 'string' || typeof result.description !== 'string' ||
          !Array.isArray(result.observations) || !result.observations.every(x=>typeof x==='string') ||
          typeof result.caveat !== 'string') throw new Error('AI 응답 형식을 확인할 수 없습니다. 다시 시도해주세요.');
      if (id !== takeId) return;
      analysis = result;
      analysisKind = 'ai';
      analysisMessage = (isExample ? '합성 예시 움직임에 대한 ' : '') + 'Gemini가 움직임 정보만 보고 생성한 해석입니다.';
      announce('AI 해석이 도착했습니다. 내 의도와 비교해보세요.');
    } catch (error) {
      if (id !== takeId) return;
      analysisMessage = (error.name === 'AbortError'
        ? 'AI 응답 시간이 길어져 요청을 멈췄습니다. 다시 시도할 수 있어요.'
        : error instanceof TypeError ? 'AI 서버에 연결하지 못했습니다. 인터넷 연결과 서버 설정을 확인해주세요.' : error.message) +
        (analysisKind === 'ai' ? ' 앞서 받은 해석을 유지합니다.' : ' 아래 결과는 기본 수치 분석입니다.');
    } finally {
      clearTimeout(timeout);
      if (id === takeId) {
        analysisBusy = false;
        analysisController = null;
        updateComparison();
      }
    }
  }

  function refresh() {
    const hasPoints = points.length > 0;
    const result = view === 'result';
    $('pause').disabled = lost || !hasPoints;
    $('finish').disabled = lost || !hasPoints;
    $('start').disabled = lost;
    $('example').disabled = lost;
    $('dialog-error').hidden = !lost;
    $('settings-toggle').disabled = lost;
    $('play').disabled = lost || !hasPoints;
    $('timeline').disabled = lost || !hasPoints;
    $('export').disabled = lost || !hasPoints;
    $('playback-speed').disabled = lost || !hasPoints;
    $('pause-icon').textContent = mode === 'paused' ? '▶' : 'Ⅱ';
    $('pause-label').textContent = mode === 'paused' ? (captureSource === 'webcam' ? '이어 기록' : '이어 그리기') : '일시정지';
    $('record-time').textContent = timestamp(cursor);
    $('record-progress').value = cursor;
    $('play-icon').textContent = mode === 'playing' ? 'Ⅱ' : '▶';
    $('play').setAttribute('aria-label',mode === 'playing' ? '재생 일시정지' : '움직임 재생');
    $('current-time').textContent = timestamp(cursor);
    $('total-time').textContent = timestamp(duration);
    $('timeline').value = duration ? Math.round(cursor/duration*1000) : 0;
    $('timeline').setAttribute('aria-valuetext',timestamp(cursor)+'초 / '+timestamp(duration)+'초');
    $('point-count').textContent = String(points.length).padStart(3,'0')+' POINTS';
    $('state-dot').classList.toggle('recording',mode === 'recording');
    $('stage-status').textContent = ({
      idle:'당신의 움직임을 기다립니다',
      armed:hasPoints ? '다시 누르면 이어서 기록합니다' : '처음 누르는 순간 기록이 시작됩니다',
      recording:'REC / 움직임을 기록하고 있어요',
      paused:'PAUSE / 잠시 쉬어가는 중',
      playing:'PLAY / 당신이 남긴 리듬',
      'replay-paused':'PAUSE / 잔상을 바라보는 중',
      complete:isExample ? 'EXAMPLE / 합성 예시 움직임' : 'YOUR TRACE / 당신이 남긴 움직임',
    })[mode];
    if (captureSource === 'webcam' && view === 'drawing') {
      if (mode === 'armed') $('stage-status').textContent = cameraRequested ? 'TRACKING / 몸을 찾으면 이어서 기록합니다' : 'READY / 자세를 잡고 기록을 시작하세요';
      $('camera-status').textContent = cameraMessage;
      $('camera-record').hidden = cameraRequested || points.length > 0;
      $('camera-record').disabled = !cameraReady || cameraKind !== 'tracking' || lost;
    }
    $('stage-guide').hidden = result || mode === 'recording';
    $('stage-guide').classList.toggle('paused',mode === 'paused');
    if(mode === 'paused') {
      $('guide-title').textContent = '잠시 멈춰도 괜찮아요.';
      $('guide-copy').textContent = '시간도 함께 멈췄어요. 이어 그리거나 결과를 만나보세요.';
    } else if(mode === 'armed') {
      if (captureSource === 'webcam') {
        $('guide-title').textContent = cameraReady ? (cameraRequested ? '당신의 움직임을 기다려요.' : '몸으로 남기는, 작은 잔상.') : '움직임을 만날 준비 중';
        $('guide-copy').textContent = cameraRequested ? '어깨와 손을 화면 안으로 옮겨주세요. 인식되면 시간이 흐릅니다.' : '미리보기에서 자세를 잡고 ‘10초 기록 시작’을 눌러주세요.';
      } else {
        $('guide-title').textContent = hasPoints ? '움직임을 이어가볼까요?' : '여기서, 당신의 움직임을.';
        $('guide-copy').textContent = '마우스나 손가락을 누른 채 움직여보세요.';
      }
    } else {
      $('guide-title').textContent = '움직임으로 채워질 공간';
      $('guide-copy').textContent = '작은 움직임 하나면 충분해요.';
    }
  }

  function openStart() {
    if(view === 'result' && mode === 'playing') togglePlayback();
    if(!dialog.open) dialog.showModal();
    refresh();
  }

  function startDrawing() {
    if(lost) return;
    stopCamera();
    clearAnalysis();
    dialog.close();
    points=[];
    poseFrames=[];
    poseSegment=0;
    wristTracks.clear();
    captureSource=inputMode;
    isExample=false;
    elapsed=0;cursor=0;duration=LIMIT;stroke=0;
    mode='armed';
    resetFeelings();
    setView('drawing');
    captureAspect=stage.clientWidth/stage.clientHeight;
    refresh();render();
    canvas.focus({preventScroll:true});
    $('drawing-hint').textContent = captureSource === 'webcam'
      ? '양손목으로 잔상을 남겨보세요 · 몸을 놓치면 시간도 멈춥니다'
      : '누른 채 움직여보세요 · 손을 떼면 새로운 획 · Space 일시정지';
    if (captureSource === 'webcam') startCamera();
    else announce('무대를 누르면 기록이 시작됩니다. 최대 10초이며, 일시정지할 수 있습니다.');
  }

  function setInputMode(next) {
    inputMode = next;
    $('input-pointer').setAttribute('aria-pressed', String(next === 'pointer'));
    $('input-webcam').setAttribute('aria-pressed', String(next === 'webcam'));
    $('input-help').textContent = next === 'webcam'
      ? '카메라 허용 후 자세를 잡고 시작하세요. 영상은 저장하지 않아요.'
      : '처음 그리는 순간부터 10초를 기록합니다.';
    $('start').firstChild.textContent = next === 'webcam' ? '웹캠 준비하기 ' : '시작하기 ';
  }

  function stopCamera() {
    camera?.stop();
    camera = null;
    cameraReady = false;
    cameraRequested = false;
    wristTracks.clear();
    $('camera-panel').hidden = true;
  }

  async function startCamera() {
    const id = takeId;
    cameraKind = 'loading';
    cameraMessage = '카메라와 자세 인식 모델을 준비하고 있어요.';
    cameraReady = false;
    cameraRequested = false;
    $('camera-panel').hidden = false;
    const current = new window.JansangPoseCamera({
      video:$('camera-video'), overlay:$('camera-overlay'),
      onStatus(status) {
        if (id !== takeId || view !== 'drawing') return;
        cameraKind = status.kind;
        cameraMessage = status.message;
        if (status.kind === 'error') {
          pauseRecording();
          cameraReady = false;
        }
        refresh();
      },
      onFrame:receivePose
    });
    camera = current;
    refresh();
    try {
      const ready = await current.start();
      if (id !== takeId || camera !== current || view !== 'drawing') { current.stop(); return; }
      cameraReady = ready;
      if (ready) captureAspect = ($('camera-video').videoWidth || 640) / ($('camera-video').videoHeight || 480);
    } catch (error) {
      if (id !== takeId || camera !== current) return;
      cameraMessage = error.message;
      cameraKind = 'error';
      cameraReady = false;
    }
    refresh();
  }

  function receivePose({landmarks, timestamp:now}) {
    if (view !== 'drawing' || captureSource !== 'webcam' || !cameraRequested || lost || mode === 'paused') return;
    const jointIndices = {leftShoulder:11,rightShoulder:12,leftElbow:13,rightElbow:14,leftWrist:15,rightWrist:16,leftHip:23,rightHip:24};
    const joints = {};
    for (const [name,index] of Object.entries(jointIndices)) {
      const p = landmarks[index];
      if (p && p.visibility >= .5) joints[name] = [clamp(p.x,0,1), clamp(p.y,0,1)];
    }
    if (!joints.leftShoulder || !joints.rightShoulder || (!joints.leftWrist && !joints.rightWrist)) {
      if (mode === 'recording') {
        elapsed = recordTime(now);
        cursor = elapsed;
        mode = 'armed';
        wristTracks.clear();
        refresh();
      }
      return;
    }
    if (mode === 'armed') {
      startedAt = now;
      mode = 'recording';
      poseSegment++;
      wristTracks.clear();
    }
    if (mode !== 'recording') return;
    const t = recordTime(now);
    if (!poseFrames.length || t > poseFrames[poseFrames.length-1].t) poseFrames.push({t,joints,segment:poseSegment});
    for (const joint of ['leftWrist','rightWrist']) {
      if (!joints[joint]) { wristTracks.delete(joint); continue; }
      const [x,y] = joints[joint];
      const prev = wristTracks.get(joint);
      const connected = prev && t > prev.t && t-prev.t < 350;
      const p = {x,y,t,stroke:connected ? prev.stroke : ++stroke,speed:0};
      if (connected) p.speed = prev.speed*.5 + Math.hypot((x-prev.x)*captureAspect,y-prev.y)/((t-prev.t)/1000)*.5;
      points.push(p);
      wristTracks.set(joint,p);
    }
    cursor = t;
    dirty = true;
    if (t >= LIMIT) finishRecording();
  }

  function releasePointer() {
    const id=activePointer;
    activePointer=null;
    if(id !== null && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
  }

  function addPoint(event,force=false) {
    const now=performance.now();
    if(!force && now-lastInput<8) return;
    const t=recordTime(now);
    const rect=canvas.getBoundingClientRect();
    const p={x:clamp((event.clientX-rect.left)/rect.width,0,1),y:clamp((event.clientY-rect.top)/rect.height,0,1),t,stroke,speed:0};
    const prev=points[points.length-1];
    if(prev && prev.stroke===stroke) {
      if(p.t<=prev.t) return;
      const distance=Math.hypot((p.x-prev.x)*rect.width/rect.height,p.y-prev.y);
      p.speed=prev.speed*.5+distance/((p.t-prev.t)/1000)*.5;
    }
    points.push(p);lastInput=now;cursor=t;dirty=true;
    if(t>=LIMIT) finishRecording();
  }

  function pauseRecording() {
    if(view!=='drawing' || !['recording','armed'].includes(mode) || !points.length) return;
    elapsed=recordTime();
    cursor=elapsed;
    releasePointer();
    if(elapsed>=LIMIT) { finishRecording();return; }
    mode='paused';dirty=true;refresh();
    wristTracks.clear();
    announce('기록을 일시정지했습니다. 멈춘 시간은 기록에 포함되지 않습니다.');
  }

  function togglePause() {
    if(lost || view!=='drawing' || !points.length) return;
    if(mode==='paused') {
      closeSettings(false);
      mode='armed';refresh();
      canvas.focus({preventScroll:true});
      announce(captureSource === 'webcam' ? '몸이 인식되면 남은 시간 동안 기록을 이어갑니다.' : '무대를 다시 누르면 남은 시간 동안 기록을 이어갑니다.');
    } else pauseRecording();
  }

  function showResult() {
    setView('result');
    $('result-duration').textContent=(duration/1000).toFixed(1);
    $('result-strokes').textContent=new Set(points.map(p=>p.stroke)).size;
    $('result-caption').textContent=isExample ? '합성 예시입니다. 재생하거나 색을 바꿔 느낌을 비교해보세요.' : captureSource === 'webcam' ? '양손목이 지나간 잔상입니다. 원본 영상은 저장하지 않았어요.' : '재생 버튼을 눌러, 당신이 남긴 리듬을 다시 만나보세요.';
    openResult();
    $('result-panel').scrollTop = 0;
    workspace.scrollTop = 0;
    refresh();render();
    $('result-title').focus({preventScroll:true});
    window.scrollTo(0,0);
    analyzeMovement();
  }

  // 같은 WebGL 캔버스를 팝업 안팎으로 옮겨 기록과 재생 상태를 보존한다.
  function openResult() {
    if(view !== 'result') return;
    resultDialog.append(workspace);
    $('result-panel').hidden = false;
    $('reopen-result').hidden = true;
    if(!resultDialog.open) resultDialog.showModal();
    resize();
    $('result-title').focus({preventScroll:true});
  }

  function closeResult(restoreFocus=true) {
    if(!resultDialog.open) return;
    if(mode === 'playing') togglePlayback();
    resultDialog.close();
    $('workspace-anchor').after(workspace);
    $('result-panel').hidden = true;
    $('reopen-result').hidden = view !== 'result';
    resize();
    if(restoreFocus) $('reopen-result').focus({preventScroll:true});
  }

  function finishRecording() {
    if(view!=='drawing' || !points.length) return;
    duration=Math.max(1,recordTime());
    elapsed=duration;cursor=duration;
    releasePointer();
    mode='complete';
    stopCamera();
    showResult();
    announce('움직임을 기록했습니다. 의도한 느낌을 남기고 비교 화면을 살펴보세요.');
  }

  function closeSettings(restoreFocus=true) {
    const wasOpen=!$('settings').hidden;
    $('settings').hidden=true;
    $('settings-toggle').setAttribute('aria-expanded','false');
    if(wasOpen && restoreFocus) $('settings-toggle').focus();
  }

  function toggleSettings() {
    if(lost || view!=='drawing') return;
    if(!$('settings').hidden) { closeSettings();return; }
    if(mode==='recording' || (captureSource==='webcam' && mode==='armed' && points.length)) pauseRecording();
    if(view!=='drawing') return;
    $('settings').hidden=false;
    $('settings-toggle').setAttribute('aria-expanded','true');
    $('settings-close').focus();
  }

  function setColor(type) {
    colorMode=type;
    for(const prefix of ['color-','result-color-']) for(const other of ['speed','mono']) {
      $(prefix+other).setAttribute('aria-pressed',String(type===other));
    }
    $('color-scale').hidden=type==='mono';
    $('mono-note').hidden=type!=='mono';
    dirty=true;render();
  }

  function togglePlayback() {
    if(lost || view!=='result' || !points.length) return;
    if(mode==='playing') {
      mode='replay-paused';
      $('result-caption').textContent='잠시 멈춘 잔상입니다. 재생 버튼을 누르면 이어집니다.';
    } else {
      if(cursor>=duration) cursor=0;
      mode='playing';lastFrame=performance.now();
      $('result-caption').textContent='기록했던 리듬으로 재생 중입니다. 일시정지한 시간은 제외됩니다.';
    }
    dirty=true;refresh();
  }

  function loadExample() {
    if(lost) return;
    stopCamera();
    clearAnalysis();
    dialog.close();
    captureSource='example';poseFrames=[];
    points=[];isExample=true;duration=LIMIT;cursor=LIMIT;mode='complete';
    captureAspect=1.6;
    for(let i=0;i<=700;i++) {
      const t=i/700,a=t*Math.PI*5.3,envelope=.72+.22*Math.sin(t*Math.PI);
      const x=.5+.31*Math.sin(a)*envelope+.055*Math.sin(a*2.4);
      const y=.5+.28*Math.sin(a*1.47+.6)*envelope+.045*Math.cos(a*3.1);
      const p={x,y,t:Math.pow(t,1.15)*LIMIT,stroke:1,speed:0};
      const prev=points[points.length-1];
      if(prev) p.speed=Math.hypot((x-prev.x)*captureAspect,y-prev.y)/((p.t-prev.t)/1000);
      points.push(p);
    }
    resetFeelings();showResult();
  }

  canvas.addEventListener('pointerdown',event=>{
    if(lost || captureSource==='webcam' || view!=='drawing' || !['armed','recording'].includes(mode) || activePointer!==null || event.button>0 || !$('settings').hidden || dialog.open) return;
    event.preventDefault();
    if(mode==='armed') { startedAt=performance.now();mode='recording'; }
    stroke++;activePointer=event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    addPoint(event,true);refresh();
  });
  canvas.addEventListener('pointermove',event=>{
    if(mode==='recording' && activePointer===event.pointerId) addPoint(event);
  });
  canvas.addEventListener('pointerup',event=>{
    if(mode==='recording' && activePointer===event.pointerId) { addPoint(event,true);releasePointer(); }
  });
  canvas.addEventListener('pointercancel',()=>{ releasePointer();pauseRecording(); });
  canvas.addEventListener('lostpointercapture',()=>{ activePointer=null; });

  $('open-start').addEventListener('click',openStart);
  $('restart').addEventListener('click',openStart);
  $('result-close').addEventListener('click',()=>closeResult());
  $('reopen-result').addEventListener('click',openResult);
  resultDialog.addEventListener('cancel',event=>{ event.preventDefault();closeResult(); });
  $('dialog-close').addEventListener('click',()=>dialog.close());
  $('start').addEventListener('click',startDrawing);
  $('input-pointer').addEventListener('click',()=>setInputMode('pointer'));
  $('input-webcam').addEventListener('click',()=>setInputMode('webcam'));
  $('camera-record').addEventListener('click',()=>{
    if (!cameraReady || cameraKind !== 'tracking') return;
    closeSettings(false);
    cameraRequested = true;
    mode = 'armed';
    refresh();
    canvas.focus({preventScroll:true});
    announce('몸이 인식되면 10초의 움직임을 기록합니다.');
  });
  $('camera-cancel').addEventListener('click',()=>{
    pauseRecording();
    stopCamera();
    clearAnalysis();
    mode='idle';
    setView('intro');
    openStart();
  });
  $('example').addEventListener('click',loadExample);
  $('pause').addEventListener('click',togglePause);
  $('finish').addEventListener('click',finishRecording);
  $('settings-toggle').addEventListener('click',toggleSettings);
  $('settings-close').addEventListener('click',()=>closeSettings());
  $('play').addEventListener('click',togglePlayback);
  $('timeline').addEventListener('input',()=>{
    if(view!=='result') return;
    mode='replay-paused';cursor=Number($('timeline').value)/1000*duration;dirty=true;refresh();render();
    $('result-caption').textContent='선택한 순간의 잔상입니다. 재생 버튼을 누르면 이어집니다.';
  });
  $('playback-speed').addEventListener('change',event=>{ playbackRate=Number(event.target.value); });
  $('width').addEventListener('input',event=>{
    strokeWidth=Number(event.target.value);$('width-value').textContent=strokeWidth;dirty=true;render();
  });
  $('show-grid').addEventListener('change',event=>{ $('grid').hidden=!event.target.checked; });
  for(const prefix of ['color-','result-color-']) for(const type of ['speed','mono']) {
    $(prefix+type).addEventListener('click',()=>setColor(type));
  }
  document.querySelectorAll('.feelings button').forEach(button=>button.addEventListener('click',()=>{
    const selected=button.getAttribute('aria-pressed')==='true';
    document.querySelectorAll('.feelings button').forEach(b=>b.setAttribute('aria-pressed','false'));
    button.setAttribute('aria-pressed',String(!selected));
    intendedFeeling = selected ? '' : button.dataset.feeling;
    updateComparison();
  }));
  $('intent-detail').addEventListener('input',updateComparison);
  $('analyze-button').addEventListener('click',requestAI);
  $('export').addEventListener('click',()=>{
    if(lost || !points.length) return;
    render();
    canvas.toBlob(blob=>{
      if(!blob) { announce('이미지 저장에 실패했습니다. 다시 시도해 주세요.');return; }
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download='jansang-'+Date.now()+'.png';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),10000);
      announce('잔상 PNG를 저장했습니다.');
    },'image/png');
  });

  // 팝업은 native dialog가 포커스를 가두고 Escape 닫기를 처리한다.
  // 설정 메뉴는 Escape로 닫고, 기록/결과 단축키는 각각 해당 화면에서만 동작한다.
  document.addEventListener('keydown',event=>{
    if(dialog.open || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    if(event.code==='Escape' && !$('settings').hidden) { event.preventDefault();closeSettings();return; }
    if(/^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if(event.code==='Space') {
      event.preventDefault();
      if(view==='drawing') togglePause();
      else if(view==='result') togglePlayback();
    }
    if(event.code==='Escape' && view==='drawing') pauseRecording();
    if(event.code==='KeyR' && view!=='drawing') { event.preventDefault();openStart(); }
  });
  document.addEventListener('visibilitychange',()=>{
    if(!document.hidden) return;
    if(mode==='recording' || (captureSource==='webcam' && mode==='armed' && cameraRequested)) {
      if(points.length) pauseRecording();
      else { cameraRequested = false; refresh(); }
    }
    if(mode==='playing') {
      mode='replay-paused';refresh();
      $('result-caption').textContent='화면을 벗어나 재생을 멈췄어요. 재생 버튼으로 이어보세요.';
    }
  });
  window.addEventListener('pagehide',()=>{
    pauseRecording();
    stopCamera();
    analysisController?.abort();
  });
  window.addEventListener('pageshow',event=>{
    if(event.persisted && captureSource==='webcam' && view==='drawing') {
      mode='idle';
      setView('intro');
      openStart();
    }
  });
  canvas.addEventListener('webglcontextlost',event=>{
    event.preventDefault();
    if(mode==='recording') pauseRecording();
    if(mode==='playing') mode='replay-paused';
    lost=true;$('stage-error').hidden=false;refresh();
    announce('그래픽 연결이 끊어졌습니다. 복구 후 다시 이어갈 수 있습니다.');
  });
  canvas.addEventListener('webglcontextrestored',()=>{
    try { setupGL();refresh(); } catch { failGL(); }
  });
  function failGL() { lost=true;$('stage-error').hidden=false;refresh(); }
  function frame(now) {
    if(!lost && mode==='recording') {
      cursor=recordTime(now);dirty=true;
      if(cursor>=LIMIT) finishRecording();
      else refresh();
    } else if(!lost && mode==='playing') {
      cursor=Math.min(duration,cursor+(now-lastFrame)*playbackRate);dirty=true;
      if(cursor>=duration) {
        mode='complete';
        $('result-caption').textContent='재생을 마쳤어요. 색을 바꾸면 같은 움직임이 어떻게 느껴지나요?';
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
  setView('intro');refresh();openStart();
  requestAnimationFrame(frame);
})();
