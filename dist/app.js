/* Ghosting: WebGL 렌더링 + 시작 → 기록(일시정지) → AI 결과 상태 흐름. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const stage = $('stage');
  const dialog = $('start-dialog');
  const resultDialog = $('result-dialog');
  const analysisDialog = $('analysis-dialog');
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
  let stroke = 0;
  let captureAspect = 1;
  let strokeWidth = 3;
  let playbackRate = 1;
  let dirty = true;
  let intendedFeeling = '';
  let intentComposing = false;
  let inputMode = 'hand';
  let captureSource = 'hand';
  let handTarget = 'indexTip';
  let trackedHandCount = 0;
  let camera = null;
  let cameraKind = 'loading';
  let cameraMessage = '';
  let cameraReady = false;
  let cameraRequested = false;
  let cameraDeviceId = '';
  let poseFrames = [];
  let poseSegment = 0;
  let jointTracks = new Map();
  let analysis = null;
  let analysisState = 'idle';
  let analysisErrorCode = '';
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
  const isCameraInput = () => captureSource === 'hand' || captureSource === 'webcam';
  const handTargetLabel = () => handTarget === 'wrist' ? '손목' : '검지 끝';
  function announce(message) { $('announcement').textContent = message; }
  function recordTime(now=performance.now()) {
    return clamp(elapsed + (mode === 'recording' ? now-startedAt : 0),0,LIMIT);
  }
  // 속도 기준은 화면 높이/초. 창 크기 대신 동작의 상대적 빠르기를 표현한다.
  function speedColor(speed) {
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
    if(view === 'result' || isCameraInput()) {
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
    $('camera-panel').hidden = next !== 'drawing' || !isCameraInput();
    for(const [id,active] of [['step-start',next==='intro'],['step-draw',next==='drawing'],['step-result',result]]) {
      if(active) $(id).setAttribute('aria-current','step');
      else $(id).removeAttribute('aria-current');
    }
    closeSettings(false);
    resize();
  }

  function resetFeelings() {
    intendedFeeling = '';
    intentComposing = false;
    $('intent-short').value = '';
    $('intent-detail').value = '';
    document.querySelectorAll('.feelings button').forEach(b=>b.setAttribute('aria-pressed','false'));
    updateComparison();
  }

  function updateComparison() {
    const detail = $('intent-detail').value.trim();
    $('intent-count').textContent = `${Array.from($('intent-short').value).length} / 5`;
    $('intent-word').textContent = intendedFeeling || (detail ? '나만의 표현' : '선택 전');
    $('intent-summary').textContent = detail || (intendedFeeling ? '내가 이 움직임으로 표현하려던 느낌입니다.' : '표현하려던 느낌을 위에서 남겨주세요.');
    $('feeling-note').textContent = intendedFeeling || detail ? '의도를 남겼어요. 서버로 보내지 않고 이 화면에만 보관합니다.' : '직접 적거나 표현을 골라주세요. 이 화면에만 남습니다.';
    const ai = Boolean(analysis);
    $('analysis-badge').textContent = analysisBusy ? 'AI 해석 중' : ai ? 'Gemini 해석'
      : analysisState === 'error' ? '해석 불가' : isExample ? '합성 예시 · 해석 대기' : '해석 대기';
    $('reading-label').textContent = '02 / AI READING';
    $('reading-title').textContent = 'AI가 느낀 움직임';
    $('ai-word').textContent = analysis?.impression || (analysisBusy ? '해석 중'
      : analysisState === 'error' ? analysisErrorTitle(analysisErrorCode) : analysisState === 'insufficient' ? '움직임이 부족해요' : '해석 대기');
    $('analysis-qualities').replaceChildren(...(analysis?.qualities || []).slice(0,4).map(text => {
      const tag = document.createElement('span'); tag.textContent = text; return tag;
    }));
    $('ai-summary').textContent = analysis?.description || (analysisBusy
      ? 'AI가 움직임에서 전해지는 인상을 읽고 있습니다.' : '아직 AI가 생성한 결과가 없습니다.');
    $('analysis-status').textContent = analysisMessage;
    $('analysis-status').dataset.code = analysisErrorCode;
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
    } else if (ai) {
      $('comparison-verdict').textContent = '내가 담은 느낌과 읽힌 인상';
      $('comparison-explanation').textContent = '나는 ‘' + (intendedFeeling || detail) + '’을 담았고, ' +
        'AI는 ‘' + analysis.impression +
        '’을 보여줍니다. 움직임에서 읽은 근거와 내 의도 사이에 어떤 차이가 있나요?';
    } else {
      $('comparison-verdict').textContent = '내 의도를 남겼어요.';
      $('comparison-explanation').textContent = 'AI 해석이 도착하면 내 표현과 나란히 비교할 수 있어요.';
    }
  }

  function analysisErrorTitle(code) {
    if (code === 'AI_TIMEOUT') return '분석 시간이 초과됐어요';
    if (['RATE_LIMITED','PROVIDER_QUOTA'].includes(code)) return '분석 요청이 많아요';
    if (code === 'CANCELLED') return 'AI 해석을 취소했어요';
    if (code === 'NOT_CONFIGURED') return 'AI 연결이 필요해요';
    if (code === 'PROVIDER_REGION') return 'AI 서버 지역을 확인해 주세요';
    if (code === 'PROVIDER_KEY') return 'AI 연결 설정을 확인해 주세요';
    if (['API_CONFIG','MODEL_CONFIG','MODEL_UNAVAILABLE','PROVIDER_CONFIG'].includes(code)) return 'AI 설정을 확인해 주세요';
    if (['INVALID_ANALYSIS','INCOMPLETE_ANALYSIS'].includes(code)) return 'AI 응답을 다시 받아야 해요';
    if (['INVALID_MOTION','INVALID_JSON','PAYLOAD_TOO_LARGE'].includes(code)) return '움직임을 다시 기록해 주세요';
    if (code === 'ORIGIN_DENIED') return '허용된 주소에서 열어주세요';
    if (code === 'SERVER_ERROR') return '분석 서버에 오류가 있어요';
    return 'AI 연결을 확인해 주세요';
  }

  function analysisError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function commitIntent() {
    if (intentComposing) return;
    const original = $('intent-short').value;
    const characters = Array.from(original);
    if (characters.length > 5) {
      const existing = $('intent-detail').value;
      $('intent-detail').value = existing ? `${existing}\n${original}` : original;
      $('intent-short').value = characters.slice(0, 5).join('');
    }
    intendedFeeling = $('intent-short').value.trim();
    document.querySelectorAll('.feelings button').forEach(button =>
      button.setAttribute('aria-pressed', String(button.dataset.feeling === intendedFeeling)));
    updateComparison();
    if (characters.length > 5) {
      $('feeling-note').textContent = '다섯 글자까지 담고, 원래 표현 전체는 아래 메모에 함께 보관했어요.';
    }
  }

  function clearAnalysis() {
    takeId++;
    analysisController?.abort();
    analysisController = null;
    analysisBusy = false;
    analysis = null;
    motionReport = null;
    analysisState = 'idle';
    analysisErrorCode = '';
    analysisMessage = '';
    $('analysis-evidence').open = false;
    if (analysisDialog.open) analysisDialog.close();
  }

  function analyzeMovement() {
    motionReport = window.JansangMotion.analyze({source:captureSource, handTarget, points, poseFrames, durationMs:duration, captureAspect});
    analysis = null;
    analysisState = motionReport.sufficient ? 'idle' : 'insufficient';
    analysisErrorCode = '';
    analysisMessage = motionReport.sufficient
      ? (isExample ? '합성 예시입니다. 해석 버튼을 누르면 이 예시의 좌표를 AI에 보냅니다.'
        : 'AI 해석을 요청하면 움직임에서 전해지는 인상을 볼 수 있어요.')
      : '분석할 움직임이 짧거나 인식한 관절이 부족합니다. 1초 이상 움직임을 남겨주세요.';
    updateComparison();
    if ($('ai-consent').checked && motionReport.sufficient && !isExample) requestAI();
  }

  function apiBase() {
    // A public Worker only accepts the deployed site's origin. Local sessions
    // always use their own server and private environment, even after deployment.
    if (['localhost','127.0.0.1','[::1]'].includes(location.hostname)) return '';
    const configured = (window.JANSANG_CONFIG?.apiBase || '').trim().replace(/\/+$/, '');
    if (configured) {
      let url;
      try { url = new URL(configured); }
      catch { throw analysisError('API_CONFIG', 'AI 서버 주소를 확인해 주세요. 올바른 HTTPS 주소가 필요합니다.'); }
      if (url.protocol !== 'https:') throw analysisError('API_CONFIG', 'AI 서버 주소는 HTTPS여야 합니다.');
      return configured;
    }
    throw analysisError('NOT_CONFIGURED', 'AI 서버가 아직 연결되지 않았습니다. Gemini 키와 서버를 연결한 뒤 다시 시도해 주세요.');
  }

  // Covers the entire request, including reading its body, even if a stalled
  // transport does not settle its own promise promptly after abort.
  function abortable(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error('Analysis cancelled'); error.name = 'AbortError';
        reject(error);
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once:true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  async function requestAI() {
    if (analysisBusy || !motionReport?.sufficient) return;
    const id = takeId;
    const controller = new AbortController();
    analysisController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    analysisBusy = true;
    analysis = null;
    analysisState = 'busy';
    analysisErrorCode = '';
    analysisMessage = '움직임 좌표를 바탕으로 인상을 읽고 있어요. 영상과 내 의도는 보내지 않습니다.';
    updateComparison();
    if (!analysisDialog.open) analysisDialog.showModal();
    try {
      const base = apiBase();
      const response = await abortable(fetch(base + '/api/analyze', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(motionReport.payload), signal:controller.signal, credentials:'omit'
      }), controller.signal);
      const data = await abortable(response.json().catch(() => null), controller.signal);
      if (!response.ok) {
        const fallbackCode = response.status === 429 ? 'RATE_LIMITED'
          : response.status === 504 ? 'AI_TIMEOUT' : 'PROVIDER_UNAVAILABLE';
        const fallbackMessage = response.status === 429 ? '분석 요청이 많습니다. 잠시 기다린 뒤 같은 잔상을 다시 해석해 주세요.'
          : response.status === 504 ? 'AI가 제한 시간 안에 응답하지 않았어요. 같은 잔상을 다시 해석할 수 있습니다.'
          : 'AI 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.';
        throw analysisError(typeof data?.error?.code === 'string' && data.error.code ? data.error.code : fallbackCode,
          typeof data?.error?.message === 'string' && data.error.message ? data.error.message : fallbackMessage);
      }
      const result = data?.analysis;
      if (!result || typeof result.impression !== 'string' || typeof result.description !== 'string' ||
          !Array.isArray(result.observations) || !result.observations.every(x=>typeof x==='string') ||
          !Array.isArray(result.qualities) || !result.qualities.length ||
          !result.qualities.every(x=>typeof x==='string' && x.trim()) ||
          typeof result.caveat !== 'string') throw analysisError('INVALID_ANALYSIS', 'AI 응답 형식을 확인할 수 없습니다. 다시 시도해주세요.');
      if (id !== takeId || analysisController !== controller || controller.signal.aborted) return;
      analysis = result;
      analysisState = 'ready';
      analysisErrorCode = '';
      analysisMessage = (isExample ? '합성 예시 움직임에 대한 ' : '') + 'Gemini가 움직임 정보만 보고 생성한 해석입니다.';
      announce('AI 해석이 도착했습니다. 내 의도와 비교해보세요.');
    } catch (error) {
      if (id !== takeId || analysisController !== controller) return;
      analysisState = 'error';
      analysisErrorCode = error.name === 'AbortError' ? (timedOut ? 'AI_TIMEOUT' : 'CANCELLED')
        : typeof error.code === 'string' ? error.code : 'NETWORK_ERROR';
      analysisMessage = error.name === 'AbortError'
        ? (timedOut ? '20초 안에 AI 응답을 받지 못해 요청을 멈췄어요. 잔상은 남아 있으니 다시 해석할 수 있습니다.' : 'AI 해석을 취소했어요. 잔상은 그대로 남아 있습니다.')
        : analysisErrorCode === 'NETWORK_ERROR' ? 'AI 서버에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도해 주세요.' : error.message;
    } finally {
      clearTimeout(timeout);
      if (id === takeId && analysisController === controller) {
        analysisBusy = false;
        analysisController = null;
        if (analysisDialog.open) analysisDialog.close();
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
    $('pause-label').textContent = mode === 'paused' ? '이어 기록' : '일시정지';
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
      armed:'READY / 움직임을 만날 준비 중',
      recording:'REC / 움직임을 기록하고 있어요',
      paused:'PAUSE / 잠시 쉬어가는 중',
      playing:'PLAY / 당신이 남긴 리듬',
      'replay-paused':'PAUSE / 잔상을 바라보는 중',
      complete:isExample ? 'EXAMPLE / 합성 예시 움직임' : 'YOUR TRACE / 당신이 남긴 움직임',
    })[mode];
    if (isCameraInput() && view === 'drawing') {
      const hand = captureSource === 'hand';
      if (mode === 'armed') $('stage-status').textContent = cameraRequested
        ? (hand ? 'TRACKING / 손을 찾으면 이어서 기록합니다' : 'TRACKING / 몸을 찾으면 이어서 기록합니다')
        : 'READY / 자세를 잡고 기록을 시작하세요';
      $('camera-mode-label').textContent = hand ? 'LIVE / HANDS' : 'LIVE / FULL BODY';
      $('hand-targets').hidden = !hand;
      $('hand-count').hidden = !hand;
      $('hand-count').textContent = `인식된 손 ${trackedHandCount} / 2`;
      for (const [id, target] of [['hand-index', 'indexTip'], ['hand-wrist', 'wrist']]) {
        $(id).setAttribute('aria-pressed', String(handTarget === target));
        $(id).disabled = hasPoints || cameraRequested;
      }
      $('camera-instructions').textContent = hand
        ? `양손의 손바닥과 손가락을 보여주세요. 각 손의 ${handTargetLabel()}이 따로 자취를 남깁니다. 한 손만 보여도 기록할 수 있어요.`
        : '어깨부터 양발까지 보이게 서주세요. 손·발·몸의 중심이 잔상으로 남습니다. 얼굴 좌표는 기록·해석하지 않아요.';
      $('drawing-hint').textContent = hand
        ? `양손의 ${handTargetLabel()}으로 공중에 그려보세요 · 두 손이 모두 안 보이면 잠시 멈춤`
        : '양손·양발·몸의 중심으로 잔상을 남겨보세요 · 전신이 보여야 기록됩니다';
      $('camera-status').textContent = cameraMessage;
      $('camera-record').hidden = cameraRequested || points.length > 0;
      $('camera-record').disabled = !cameraReady || cameraKind !== 'tracking' || lost;
      $('camera-select').disabled = cameraKind === 'loading' || hasPoints || cameraRequested;
      $('camera-retry').hidden = cameraKind !== 'error';
      $('camera-switch-note').textContent = hasPoints
        ? '카메라는 새 기록을 시작할 때 바꿀 수 있어요.'
        : '영상에 X가 보이면 실제 카메라를 선택해 주세요.';
    }
    $('stage-guide').hidden = result || mode === 'recording';
    $('stage-guide').classList.toggle('paused',mode === 'paused');
    if(mode === 'paused') {
      $('guide-title').textContent = '잠시 멈춰도 괜찮아요.';
      $('guide-copy').textContent = '시간도 함께 멈췄어요. 이어 기록하거나 결과를 만나보세요.';
    } else if(mode === 'armed') {
      $('guide-title').textContent = cameraKind === 'error' ? '카메라 연결을 확인해 주세요.' : cameraReady
        ? (cameraRequested ? '당신의 움직임을 기다려요.' : captureSource === 'hand' ? '손끝에서 시작되는, 작은 잔상.' : '몸으로 남기는, 작은 잔상.')
        : '움직임을 만날 준비 중';
      $('guide-copy').textContent = cameraKind === 'error' ? '왼쪽에서 카메라를 바꾸거나 다시 연결할 수 있어요.'
        : cameraRequested ? (captureSource === 'hand' ? '손을 화면 안으로 옮겨주세요. 한 손 이상 보이면 시간이 흐릅니다.' : '어깨부터 양발까지 화면 안으로 옮겨주세요. 인식되면 시간이 흐릅니다.')
        : '미리보기에서 자세를 잡고 ‘10초 기록 시작’을 눌러주세요.';
    } else {
      $('guide-title').textContent = '움직임으로 채워질 공간';
      $('guide-copy').textContent = '작은 움직임 하나면 충분해요.';
    }
  }

  function openStart() {
    if (analysisBusy) {
      analysisController?.abort();
      if (analysisDialog.open) analysisDialog.close();
    }
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
    jointTracks.clear();
    captureSource=inputMode;
    isExample=false;
    elapsed=0;cursor=0;duration=LIMIT;stroke=0;
    mode='armed';
    resetFeelings();
    setView('drawing');
    captureAspect=stage.clientWidth/stage.clientHeight;
    refresh();render();
    canvas.focus({preventScroll:true});
    startCamera();
  }

  function setInputMode(next) {
    inputMode = next;
    $('input-hand').setAttribute('aria-pressed', String(next === 'hand'));
    $('input-webcam').setAttribute('aria-pressed', String(next === 'webcam'));
    $('input-help').textContent = next === 'webcam'
      ? '카메라 허용 후 자세를 잡고 시작하세요. 영상은 저장하지 않아요.'
      : '양손을 함께 보여주세요. 각 손의 검지 끝 또는 손목으로 공중에 그립니다.';
    $('start').firstChild.textContent = '웹캠 준비하기 ';
  }

  function stopCamera() {
    camera?.stop();
    camera = null;
    cameraReady = false;
    cameraRequested = false;
    trackedHandCount = 0;
    jointTracks.clear();
    $('camera-panel').hidden = true;
  }

  async function startCamera() {
    const id = takeId;
    camera?.stop();
    camera = null;
    jointTracks.clear();
    cameraKind = 'loading';
    cameraMessage = captureSource === 'hand' ? '카메라와 손 인식 모델을 준비하고 있어요.' : '카메라와 자세 인식 모델을 준비하고 있어요.';
    cameraReady = false;
    trackedHandCount = 0;
    cameraRequested = points.length > 0;
    $('camera-panel').hidden = false;
    let current = null;
    refresh();
    try {
      if (!window.JansangPoseCamera) throw new Error('카메라 기능을 불러오지 못했어요. 페이지를 새로고침해 주세요.');
      current = new window.JansangPoseCamera({
        trackingMode:captureSource === 'hand' ? 'hand' : 'body',
        video:$('camera-video'), overlay:$('camera-overlay'),
        onDevices({devices, selectedDeviceId}) {
          if (id !== takeId || camera !== current || view !== 'drawing') return;
          const automatic = document.createElement('option');
          automatic.value = '';
          automatic.textContent = '자동 선택';
          const options = devices.map((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `카메라 ${index + 1}`;
            return option;
          });
          $('camera-select').replaceChildren(automatic, ...options);
          cameraDeviceId = selectedDeviceId || '';
          $('camera-select').value = cameraDeviceId;
        },
        onStatus(status) {
          if (id !== takeId || camera !== current || view !== 'drawing') return;
          cameraKind = status.kind;
          cameraMessage = status.message;
          if (status.kind === 'error') {
            pauseRecording();
            cameraReady = false;
            trackedHandCount = 0;
          }
          refresh();
        },
        onFrame(frame) {
          if (id === takeId && camera === current) receivePose(frame);
        }
      });
      camera = current;
      const ready = await current.start({deviceId:cameraDeviceId});
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

  function receivePose({landmarks = [], hands = [], timestamp:now}) {
    if (view !== 'drawing' || !isCameraInput()) return;
    const hand = captureSource === 'hand';
    const jointIndices = hand ? {
      wrist:0,thumbCmc:1,thumbMcp:2,thumbIp:3,thumbTip:4,
      indexMcp:5,indexPip:6,indexDip:7,indexTip:8,
      middleMcp:9,middlePip:10,middleDip:11,middleTip:12,
      ringMcp:13,ringPip:14,ringDip:15,ringTip:16,
      pinkyMcp:17,pinkyPip:18,pinkyDip:19,pinkyTip:20
    } : {
      leftShoulder:11,rightShoulder:12,leftElbow:13,rightElbow:14,leftWrist:15,rightWrist:16,
      leftPinky:17,rightPinky:18,leftIndex:19,rightIndex:20,leftThumb:21,rightThumb:22,
      leftHip:23,rightHip:24,leftKnee:25,rightKnee:26,leftAnkle:27,rightAnkle:28,
      leftHeel:29,rightHeel:30,leftFootIndex:31,rightFootIndex:32
    };
    const readJoints = raw => {
      const joints = {};
      for (const [name,index] of Object.entries(jointIndices)) {
        const p = raw?.[index];
        if (p && p.visibility >= .5 && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          joints[name] = [clamp(p.x,0,1), clamp(p.y,0,1)];
        }
      }
      return joints;
    };
    const observedHands = [];
    const seenIds = new Set();
    if (hand) {
      for (const detected of hands.slice(0,2)) {
        if (!Number.isInteger(detected.id) || detected.id < 1 || seenIds.has(detected.id)) continue;
        const joints = readJoints(detected.landmarks);
        if (!['wrist','indexMcp','indexTip'].every(name => joints[name])) continue;
        seenIds.add(detected.id);
        observedHands.push({id:detected.id,joints});
      }
      if (trackedHandCount !== observedHands.length) {
        trackedHandCount = observedHands.length;
        refresh();
      }
    }
    if (!cameraRequested || lost || mode === 'paused' || !$('settings').hidden) return;
    const joints = hand ? null : readJoints(landmarks);
    const tracked = hand ? observedHands.length > 0
      : ['leftShoulder','rightShoulder','leftHip','rightHip','leftAnkle','rightAnkle'].every(name => joints[name]);
    if (!tracked) {
      if (mode === 'recording') {
        elapsed = recordTime(now);
        cursor = elapsed;
        mode = 'armed';
        jointTracks.clear();
        refresh();
      }
      return;
    }
    if (mode === 'armed') {
      startedAt = now;
      mode = 'recording';
      poseSegment++;
      jointTracks.clear();
    }
    if (mode !== 'recording') return;
    const t = recordTime(now);
    if (!poseFrames.length || t > poseFrames[poseFrames.length-1].t) {
      poseFrames.push(hand ? {t,hands:observedHands,segment:poseSegment} : {t,joints,segment:poseSegment});
    }
    // Each visible hand has its own trail; missing hands never join another hand.
    const traceJoints = hand ? null : {...joints, bodyCenter:[
      (joints.leftHip[0] + joints.rightHip[0])/2,
      (joints.leftHip[1] + joints.rightHip[1])/2
    ]};
    const traces = hand
      ? observedHands.map(({id,joints}) => ({key:`hand:${id}`,xy:joints[handTarget],handId:id}))
      : ['leftWrist','rightWrist','leftAnkle','rightAnkle','bodyCenter']
        .filter(key => traceJoints[key]).map(key => ({key,xy:traceJoints[key]}));
    const visibleKeys = new Set(traces.map(trace => trace.key));
    for (const key of jointTracks.keys()) if (!visibleKeys.has(key)) jointTracks.delete(key);
    for (const trace of traces) {
      const [x,y] = trace.xy;
      const prev = jointTracks.get(trace.key);
      const connected = prev && t > prev.t && t-prev.t < 350;
      const p = {x,y,t,stroke:connected ? prev.stroke : ++stroke,speed:0};
      if (hand) p.handId = trace.handId;
      if (connected) p.speed = prev.speed*.5 + Math.hypot((x-prev.x)*captureAspect,y-prev.y)/((t-prev.t)/1000)*.5;
      points.push(p);
      jointTracks.set(trace.key,p);
    }
    cursor = t;
    dirty = true;
    if (t >= LIMIT) finishRecording();
  }

  function pauseRecording() {
    if(view!=='drawing' || !['recording','armed'].includes(mode) || !points.length) return;
    elapsed=recordTime();
    cursor=elapsed;
    if(elapsed>=LIMIT) { finishRecording();return; }
    mode='paused';dirty=true;refresh();
    jointTracks.clear();
    announce('기록을 일시정지했습니다. 멈춘 시간은 기록에 포함되지 않습니다.');
  }

  function togglePause() {
    if(lost || view!=='drawing' || !points.length) return;
    if(mode==='paused') {
      closeSettings(false);
      mode='armed';refresh();
      canvas.focus({preventScroll:true});
      announce(captureSource === 'hand' ? '손이 인식되면 남은 시간 동안 기록을 이어갑니다.' : '몸이 인식되면 남은 시간 동안 기록을 이어갑니다.');
    } else pauseRecording();
  }

  function showResult() {
    setView('result');
    $('result-duration').textContent=(duration/1000).toFixed(1);
    $('result-strokes').textContent=new Set(points.map(p=>p.stroke)).size;
    $('result-caption').textContent=isExample ? '합성 예시입니다. 재생하며 움직임의 흐름을 살펴보세요.'
      : captureSource === 'hand' ? `보이는 각 손의 ${handTargetLabel()}이 남긴 잔상입니다. 손마다 자취를 나눠 기록했어요.`
      : '양손·양발·몸의 중심이 남긴 잔상입니다. 얼굴 좌표와 영상은 기록하지 않았어요.';
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
    if(mode==='recording' || (isCameraInput() && mode==='armed' && points.length)) pauseRecording();
    if(view!=='drawing') return;
    $('settings').hidden=false;
    $('settings-toggle').setAttribute('aria-expanded','true');
    $('settings-close').focus();
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

  $('open-start').addEventListener('click',openStart);
  $('restart').addEventListener('click',openStart);
  $('result-close').addEventListener('click',()=>closeResult());
  $('reopen-result').addEventListener('click',openResult);
  resultDialog.addEventListener('cancel',event=>{ event.preventDefault();closeResult(); });
  $('analysis-cancel').addEventListener('click',()=>analysisController?.abort());
  analysisDialog.addEventListener('cancel',event=>{ event.preventDefault();analysisController?.abort(); });
  $('dialog-close').addEventListener('click',()=>dialog.close());
  $('start').addEventListener('click',startDrawing);
  $('input-hand').addEventListener('click',()=>setInputMode('hand'));
  $('input-webcam').addEventListener('click',()=>setInputMode('webcam'));
  for (const [id, target] of [['hand-index', 'indexTip'], ['hand-wrist', 'wrist']]) {
    $(id).addEventListener('click',()=>{
      if (view !== 'drawing' || captureSource !== 'hand' || points.length || cameraRequested) return;
      handTarget = target;
      refresh();
    });
  }
  $('camera-select').addEventListener('change',()=>{
    if (view !== 'drawing' || !isCameraInput() || points.length || cameraRequested || cameraKind === 'loading') return;
    cameraDeviceId = $('camera-select').value;
    startCamera();
  });
  $('camera-retry').addEventListener('click',()=>{
    if (view !== 'drawing' || !isCameraInput() || cameraKind !== 'error') return;
    startCamera();
  });
  $('camera-record').addEventListener('click',()=>{
    if (!cameraReady || cameraKind !== 'tracking') return;
    closeSettings(false);
    cameraRequested = true;
    mode = 'armed';
    refresh();
    canvas.focus({preventScroll:true});
    announce(captureSource === 'hand' ? '손이 인식되면 10초의 움직임을 기록합니다.' : '몸이 인식되면 10초의 움직임을 기록합니다.');
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
  document.querySelectorAll('.feelings button').forEach(button=>button.addEventListener('click',()=>{
    const selected=button.getAttribute('aria-pressed')==='true';
    document.querySelectorAll('.feelings button').forEach(b=>b.setAttribute('aria-pressed','false'));
    button.setAttribute('aria-pressed',String(!selected));
    intendedFeeling = selected ? '' : button.dataset.feeling;
    $('intent-short').value = intendedFeeling;
    updateComparison();
  }));
  $('intent-short').addEventListener('compositionstart',()=>{ intentComposing = true; });
  $('intent-short').addEventListener('compositionend',()=>{ intentComposing = false; commitIntent(); });
  $('intent-short').addEventListener('input',event=>{ if (!event.isComposing) commitIntent(); });
  $('intent-detail').addEventListener('input',updateComparison);
  $('analyze-button').addEventListener('click',requestAI);
  $('export').addEventListener('click',()=>{
    if(lost || !points.length) return;
    render();
    canvas.toBlob(blob=>{
      if(!blob) { announce('이미지 저장에 실패했습니다. 다시 시도해 주세요.');return; }
      const url=URL.createObjectURL(blob);
      const link=document.createElement('a');link.href=url;link.download='ghosting-'+Date.now()+'.png';link.click();
      setTimeout(()=>URL.revokeObjectURL(url),10000);
      announce('잔상 PNG를 저장했습니다.');
    },'image/png');
  });

  // 팝업은 native dialog가 포커스를 가두고 Escape 닫기를 처리한다.
  // 설정 메뉴는 Escape로 닫고, 기록/결과 단축키는 각각 해당 화면에서만 동작한다.
  document.addEventListener('keydown',event=>{
    if(dialog.open || analysisDialog.open || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
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
    if(mode==='recording' || (isCameraInput() && mode==='armed' && cameraRequested)) {
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
    if(event.persisted && isCameraInput() && view==='drawing') {
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
        $('result-caption').textContent='재생을 마쳤어요. 같은 움직임에서 어떤 느낌이 전해지나요?';
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
