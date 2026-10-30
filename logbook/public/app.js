(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else exported.createApp(root, document).start();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const ALLOWED_ORIGINS = new Set(['https://yebe9.github.io', 'http://127.0.0.1:4173', 'http://localhost:4173']);
  const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' ? value : '';
  const duration = value => Number.isFinite(value) && value >= 0 ? `${(value / 1000).toFixed(1)}초` : '시간 미기록';
  const sourceLabel = value => value === 'hand' ? '손 움직임' : ['body', 'webcam', 'camera'].includes(value) ? '전신 움직임' : value === 'example' ? '예시 움직임' : value === 'pointer' ? '포인터 움직임' : '움직임';
  const scoreValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
  function dateLabel(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date) : '날짜 미기록';
  }
  function frequencies(records) {
    const counts = new Map();
    for (const record of records) {
      const label = text(record.impression).trim();
      if (label) counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ko'));
  }
  function captureAllowed(event, opener, authenticated, captureMode) {
    return Boolean(authenticated && captureMode && opener && event.source === opener && ALLOWED_ORIGINS.has(event.origin) && isObject(event.data) && event.data.type === 'ghosting:capture');
  }
  const revisionValue=record=>Number.isSafeInteger(record?.revision)&&record.revision>=0?record.revision:0;
  function createApp(win, doc) {
    const $ = id => doc.getElementById(id);
    let authenticated = false;
    let epoch = 0;
    let selectionVersion = 0;
    let listVersion = 0;
    let records = [];
    let selected = null;
    let selectedIsPending = false;
    let pending = null;
    let pendingURL = null;
    let saving = false;
    let actionBusy = false;
    const captureParams = new URLSearchParams(win.location.search);
    let captureMode = captureParams.get('capture') === '1';
    const autoSave = captureMode && captureParams.get('save') === '1';
    const continuousMode = autoSave && captureParams.get('auto') === '1';
    const inbox=new Map(),waitingAcks=new Map(),storedRevisions=new Map(),deletedIDs=new Set();
    try{const remembered=JSON.parse(win.sessionStorage?.getItem('ghosting-log-deleted-ids')||'[]');if(Array.isArray(remembered))for(const id of remembered)if(typeof id==='string'&&id.length<=100)deletedIDs.add(id);}catch{}
    let confirmation = null;
    const activeRequests = new Set();
    const downloadURLs = new Set();

    function acknowledge(type,capture,extra={}) {
      try { win.opener?.postMessage({type,id:capture.record.id,revision:revisionValue(capture.record),...extra},capture.origin); } catch {}
    }
    function remember(capture) {
      let versions=waitingAcks.get(capture.record.id);
      if(!versions){versions=new Map();waitingAcks.set(capture.record.id,versions);}
      versions.set(revisionValue(capture.record),{record:{id:capture.record.id,revision:revisionValue(capture.record)},origin:capture.origin});
    }
    function saved(capture,storedRevision) {
      storedRevisions.set(capture.record.id,Math.max(storedRevisions.get(capture.record.id)||0,storedRevision));
      const versions=waitingAcks.get(capture.record.id);
      if(versions)for(const [version,waiting] of versions){
        if(version<=storedRevision){acknowledge('ghosting:saved',waiting,{storedRevision});versions.delete(version);}
      }
      if(!versions?.size)waitingAcks.delete(capture.record.id);
    }
    function notifyPendingError(message,code='LOGIN_REQUIRED') {
      for(const versions of waitingAcks.values())for(const capture of versions.values())acknowledge('ghosting:error',capture,{message,code});
    }
    const deletedMessage='기록함에서 삭제한 움직임입니다. 새로 기록해주세요.';
    function rejectDeleted(capture) {
      status('workspace-status',deletedMessage,true);
      acknowledge('ghosting:error',capture,{message:deletedMessage,code:'RECORD_DELETED'});
    }
    function markDeleted(id) {
      deletedIDs.add(id);storedRevisions.delete(id);
      try{win.sessionStorage?.setItem('ghosting-log-deleted-ids',JSON.stringify([...deletedIDs]));}catch{}
      for(const capture of waitingAcks.get(id)?.values() || [])rejectDeleted(capture);
      waitingAcks.delete(id);inbox.delete(id);
      if(pending?.record.id===id){pending=null;clearVideo();updateCaptureNotice();}
      if(selected?.id===id)hideDetail();
    }
    async function updateStoredCapture(id,record) {
      try {
        return await request('/api/records/'+encodeURIComponent(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(record)});
      } catch(error) {
        if(error.status===404){markDeleted(id);throw Object.assign(new Error(deletedMessage),{status:404,code:'RECORD_DELETED'});}
        throw error;
      }
    }
    function nextCapture() {
      if(pending || saving || !authenticated)return;
      const entry=inbox.entries().next().value;
      if(!entry)return;
      inbox.delete(entry[0]);pending=entry[1];updateCaptureNotice();showPending();
      if(autoSave)void saveCapture();
    }
    function status(id, message, error = false) {
      $(id).textContent = message;
      $(id).classList.toggle('error', error);
    }
    function element(tag, className, content) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (content !== undefined) node.textContent = content;
      return node;
    }
    function clearVideo() {
      const video = $('record-video');
      video.pause();
      video.removeAttribute('src');
      video.load();
      $('video-panel').hidden = true;
      $('video-status').textContent = '';
      $('retry-video').hidden = true;
      if (pendingURL) win.URL.revokeObjectURL(pendingURL);
      pendingURL = null;
    }
    function hideDetail() {
      selectionVersion++;
      clearVideo();
      selected = null;
      selectedIsPending = false;
      $('record-detail').hidden = true;
      $('empty-state').hidden = false;
      for (const id of ['detail-title', 'detail-meta', 'detail-intention', 'detail-notes', 'detail-impression', 'detail-description', 'detail-qualities', 'detail-observations', 'candidate-list', 'detail-metrics', 'analysis-error', 'rubric-note', 'rubric-eligibility', 'rubric-metrics']) $(id).replaceChildren();
      status('detail-status', '');
    }
    function lock(message = '비밀번호를 입력해 기록함을 열어주세요.') {
      notifyPendingError(message);
      epoch++;
      authenticated = false;
      for (const controller of activeRequests) controller.abort();
      activeRequests.clear();
      records = [];
      hideDetail();
      $('record-list').replaceChildren();
      $('distribution-list').replaceChildren();
      $('record-count').textContent = '0';
      $('storage-status').textContent = '';
      $('workspace').hidden = true;
      $('logout').hidden = true;
      $('login-panel').hidden = false;
      $('password').value = '';
      if ($('confirm-dialog').open) $('confirm-dialog').close();
      if (confirmation) confirmation(false);
      confirmation = null;
      status('login-status', message);
    }
    async function request(path, options = {}) {
      const controller = new win.AbortController();
      activeRequests.add(controller);
      const timer = win.setTimeout(() => controller.abort(), 45000);
      try {
        const response = await win.fetch(path, { ...options, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
        if (response.status === 401) {
          if (authenticated) lock('로그인이 만료됐어요. 비밀번호를 다시 입력해주세요.');
          const failure = new Error(options.method === 'POST' && path === '/api/login' ? '비밀번호를 확인해주세요.' : '로그인이 필요합니다.');
          failure.status = 401;
          throw failure;
        }
        if (!response.ok) {
          let body;
          try { body = await response.json(); } catch {}
          const failure = new Error(text(body?.error?.message) || '요청을 마치지 못했어요. 잠시 후 다시 시도해주세요.');
          failure.status = response.status;
          throw failure;
        }
        if (options.asBlob) return await response.blob();
        if (response.status === 204) return {};
        return await response.json();
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('연결이 지연되고 있어요. 잠시 후 다시 시도해주세요.');
        throw error;
      } finally {
        win.clearTimeout(timer);
        activeRequests.delete(controller);
      }
    }
    function announceReady() {
      if (!authenticated || !captureMode || !win.opener) return;
      for (const origin of ALLOWED_ORIGINS) {
        try { win.opener.postMessage({ type: 'ghosting:ready' }, origin); } catch {}
      }
    }
    function updateCaptureNotice() {
      $('capture-notice').hidden = !captureMode && !pending;
      $('review-capture').hidden = !pending;
      $('capture-heading').textContent = pending ? '아직 저장하지 않은 움직임이 있어요.' : '움직임을 기다리고 있어요.';
      $('capture-message').textContent = pending
        ? '내용을 확인하고 저장해주세요. 새로고침하거나 창을 닫으면 저장 전 영상과 기록이 사라집니다.'
        : win.opener ? '원래 Ghosting 화면에서 기록을 보내주세요.' : 'Ghosting의 결과 화면에서 기록함을 열어주세요.';
    }
    async function unlock() {
      authenticated = true;
      $('login-panel').hidden = true;
      $('workspace').hidden = false;
      $('logout').hidden = false;
      $('password').value = '';
      status('workspace-status', '');
      updateCaptureNotice();
      const resumeCapture = pending;
      if (pending) showPending();
      await refreshRecords();
      announceReady();
      if (resumeCapture && pending === resumeCapture && autoSave) await saveCapture();
      else nextCapture();
    }
    async function checkSession() {
      const currentEpoch = epoch;
      $('session-retry').hidden = true;
      $('login-submit').disabled = true;
      status('login-status', '로그인 상태를 확인하고 있어요.');
      try {
        const result = await request('/api/session');
        if (currentEpoch !== epoch) return;
        if (result.authenticated === true) await unlock();
        else lock();
      } catch (error) {
        if (currentEpoch !== epoch) return;
        status('login-status', error.status === 401 ? '비밀번호를 입력해 기록함을 열어주세요.' : error.message, error.status !== 401);
        $('session-retry').hidden = error.status === 401;
      } finally { $('login-submit').disabled = false; }
    }
    function renderList() {
      $('record-list').replaceChildren();
      $('record-count').textContent = String(records.length);
      for (const record of records) {
        const unfinished = record.state && record.state !== 'ready';
        const wrapper = element('div', 'record-wrapper');
        const button = element('button', 'record-item');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(!selectedIsPending && selected?.id === record.id));
        button.append(element('time', '', dateLabel(record.createdAt)));
        button.append(element('strong', '', text(record.impression) || '분석 결과 없음'));
        const line = element('span', 'record-subline');
        line.append(element('span', '', `${sourceLabel(record.source)} · ${duration(record.durationMs)}`));
        line.append(element('span', '', unfinished ? record.state === 'deleting' ? '삭제 미완료' : '저장 미완료' : record.hasVideo ? '영상 포함' : '기록만'));
        button.append(line);
        button.addEventListener('click', () => selectRecord(record.id));
        wrapper.append(button);
        if (unfinished) {
          const remove = element('button', 'text-button danger unfinished-delete', '미완료 기록 삭제');
          remove.type = 'button';
          remove.addEventListener('click', () => deleteRecord(record));
          wrapper.append(remove);
        }
        $('record-list').append(wrapper);
      }
      const distribution = frequencies(records.filter(record => !record.state || record.state === 'ready'));
      $('distribution-list').replaceChildren();
      $('distribution-panel').hidden = !distribution.length;
      for (const [label, count] of distribution.slice(0, 8)) {
        const row = element('div', 'frequency');
        row.append(element('span', '', label), element('span', '', `${count}회`));
        const bar = element('div', 'frequency-bar');
        const fill = element('div', 'frequency-fill');
        fill.style.width = `${count / distribution[0][1] * 100}%`;
        bar.append(fill); row.append(bar);
        $('distribution-list').append(row);
      }
    }
    async function refreshRecords() {
      if (!authenticated) return;
      const currentEpoch = epoch;
      const version = ++listVersion;
      $('refresh').disabled = true;
      status('list-status', '기록을 불러오고 있어요.');
      try {
        const result = await request('/api/records');
        if (!authenticated || currentEpoch !== epoch || version !== listVersion) return;
        records = Array.isArray(result.records) ? result.records.filter(record => isObject(record) && typeof record.id === 'string') : [];
        const listedIDs=new Set(records.map(record=>record.id));
        for(const id of storedRevisions.keys())if(!listedIDs.has(id))markDeleted(id);
        storedRevisions.clear();
        for(const record of records)if((!record.state||record.state==='ready')&&!deletedIDs.has(record.id))storedRevisions.set(record.id,revisionValue(record));
        $('storage-status').textContent = Number.isFinite(result.storage?.usedBytes) && Number.isFinite(result.storage?.maxBytes)
          ? `${(result.storage.usedBytes / 1024 / 1024).toFixed(1)} / ${(result.storage.maxBytes / 1024 / 1024).toFixed(0)} MiB · ${records.length} / ${Number.isFinite(result.storage.maxRecords) ? result.storage.maxRecords : 500}개`
          : '';
        renderList();
        status('list-status', records.length ? '' : '아직 저장된 기록이 없어요.');
      } catch (error) {
        if (authenticated && currentEpoch === epoch && version === listVersion) status('list-status', error.message, true);
      } finally {
        if (version === listVersion) $('refresh').disabled = false;
      }
    }
    function renderCandidates(candidates,similarity) {
      const semantic=isObject(similarity)&&Array.isArray(similarity.results);
      if(semantic)candidates=similarity.results;
      $('candidates-heading').textContent=semantic?'내 의도와 표현의 의미 유사도':'AI가 함께 제시한 표현';
      $('candidate-scale').textContent=semantic?'코사인 × 100':'AI 적합도 / 100';
      $('candidate-description').textContent=semantic?'내가 남긴 말과 각 표현을 단어 벡터로 비교한 의미 유사도입니다. 감정의 확률이나 동작 일치율이 아닙니다. 음수는 벡터 방향이 반대임을 뜻합니다.':'각 수치는 AI가 스스로 보고한 표현의 적합도입니다. 확률·정확도·모델 내부의 실제 후보 순위가 아닙니다. 보고하지 않은 수치는 0으로 표시하지 않습니다.';
      $('similarity-provenance').textContent=semantic?[text(similarity.method),text(similarity.model)].filter(Boolean).join(' · '):'';
      $('candidate-list').replaceChildren();
      if (!Array.isArray(candidates) || !candidates.length) {
        $('candidate-list').append(element('p', 'fine-print', semantic?'계산된 유사도 후보가 아직 없습니다.':'이 분석에는 후보 표현과 적합도 보고가 없습니다.'));
        return;
      }
      for (const candidate of candidates.slice(0, 50)) {
        if (!isObject(candidate)) continue;
        const score = semantic ? (typeof candidate.similarity==='number'&&Number.isFinite(candidate.similarity)&&candidate.similarity>=-100&&candidate.similarity<=100?candidate.similarity:null) : scoreValue(candidate.score);
        const row = element('div', 'candidate');
        const header = element('div', 'candidate-header');
        header.append(element('span', 'candidate-label', text(candidate.label) || '표현 미보고'));
        header.append(element('span', 'candidate-score', score === null ? '미보고' : `${Math.round(score * 10) / 10}${semantic?'':' / 100'}`));
        row.append(header);
        if (score !== null) {
          const bar = element('div', 'candidate-bar');
          bar.setAttribute('role', 'meter');
          bar.setAttribute('aria-label', `${text(candidate.label) || '표현'} ${semantic?'내 의도와 의미 유사도':'AI 보고 적합도'}`);
          bar.setAttribute('aria-valuemin', semantic?'-100':'0');
          bar.setAttribute('aria-valuemax', '100');
          bar.setAttribute('aria-valuenow', String(score));
          const fill = element('div', 'candidate-fill');
          fill.style.width = `${semantic?Math.abs(score)/2:score}%`;
          if(semantic){bar.style.position='relative';fill.style.marginLeft=`${score>=0?50:50+score/2}%`;const zero=element('span');zero.style.position='absolute';zero.style.left='50%';zero.style.top='0';zero.style.height='100%';zero.style.width='1px';zero.style.background='#b6c7bb';bar.append(zero);}
          bar.append(fill); row.append(bar);
        }
        row.append(element('p', 'candidate-evidence', text(candidate.evidence) || '근거 미보고'));
        $('candidate-list').append(row);
      }
    }
    function appendMetric(key, value) {
      $('detail-metrics').append(element('dt', '', key), element('dd', '', value));
    }
    function renderDetail(record, isPending) {
      clearVideo();
      selected = record;
      selectedIsPending = isPending;
      const analysis = isObject(record.analysis) ? record.analysis : {};
      $('empty-state').hidden = true;
      $('record-detail').hidden = false;
      $('detail-meta').textContent = `${dateLabel(record.createdAt)} · ${sourceLabel(record.source)} · ${duration(record.durationMs)}`;
      $('detail-title').textContent = text(analysis.impression) || '아직 이름 붙이지 않은 움직임';
      $('detail-badge').textContent = isPending ? '저장 전 확인' : '비공개 기록';
      $('detail-intention').textContent = text(record.intention) || '작성하지 않음';
      $('detail-notes').textContent = text(record.details);
      $('detail-impression').textContent = text(analysis.impression) || '분석 결과 없음';
      $('detail-description').textContent = text(analysis.description);
      $('detail-qualities').replaceChildren();
      if (Array.isArray(analysis.qualities)) for (const quality of analysis.qualities.slice(0, 50)) {
        if (typeof quality === 'string') $('detail-qualities').append(element('span', 'tag', quality));
      }
      $('detail-observations').replaceChildren();
      if (Array.isArray(analysis.observations)) for (const observation of analysis.observations.slice(0, 30)) {
        if (typeof observation === 'string') $('detail-observations').append(element('li', '', observation));
      }
      const error = typeof record.analysisError === 'string' ? record.analysisError : text(record.analysisError?.message);
      $('analysis-error').hidden = !error;
      $('analysis-error').textContent = error ? `분석 오류 기록: ${error}` : '';
      renderCandidates(analysis.candidates,record.similarity);
      const rubric = isObject(analysis.rubric) ? analysis.rubric : null;
      $('ranking-note').hidden = Boolean(record.similarity)||rubric?.candidateRankingConsistent !== false;
      $('rubric-panel').hidden = !rubric;
      $('rubric-note').textContent = text(rubric?.note);
      $('rubric-eligibility').textContent = isObject(rubric?.eligible)
        ? Object.entries(rubric.eligible).filter(([, value]) => typeof value === 'boolean').map(([label, value]) => `${label}: ${value ? '경험적 기준 충족' : '경험적 기준 미충족'}`).join(' · ')
        : '';
      $('rubric-metrics').replaceChildren();
      if (isObject(rubric?.metrics)) for (const [key, value] of Object.entries(rubric.metrics).slice(0, 50)) {
        if (value === null || (typeof value === 'number' && Number.isFinite(value))) {
          $('rubric-metrics').append(element('dt', '', key), element('dd', '', value === null ? '미측정' : String(value)));
        }
      }
      $('detail-metrics').replaceChildren();
      appendMetric('기록 시각', dateLabel(record.createdAt));
      appendMetric('입력 방식', sourceLabel(record.source));
      appendMetric('기록 길이', duration(record.durationMs));
      if (record.handTarget) appendMetric('자취 기준', record.handTarget === 'wrist' ? '손목' : record.handTarget === 'indexTip' ? '검지 끝' : text(record.handTarget));
      if (record.id) appendMetric('기록 ID', text(record.id));
      appendMetric('보관 버전',String(revisionValue(record)));
      if(isObject(analysis.motionCaption))appendMetric('움직임 해석 출처',JSON.stringify(analysis.motionCaption));
      if (isObject(record.metrics)) for (const [key, value] of Object.entries(record.metrics).slice(0, 50)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') appendMetric(key, String(value));
      }
      $('pending-actions').hidden = !isPending;
      $('saved-actions').hidden = isPending;
      const hasVideo = isPending ? Boolean(pending?.video) : Boolean(record.hasVideo);
      $('no-video').hidden = hasVideo;
      $('download-video').hidden = !hasVideo || isPending;
      if (hasVideo) {
        $('video-panel').hidden = false;
        if (isPending) {
          pendingURL = win.URL.createObjectURL(pending.video);
          $('record-video').src = pendingURL;
          $('video-status').textContent = `저장 전 미리보기 · ${(pending.video.size / 1024 / 1024).toFixed(1)} MiB`;
        } else {
          $('record-video').src = `/api/records/${encodeURIComponent(record.id)}/video`;
          $('video-status').textContent = '영상은 이 비공개 기록함에서만 불러옵니다.';
        }
      }
      status('detail-status', '');
      renderList();
      syncActions();
    }
    async function selectRecord(id) {
      if (!authenticated || saving || actionBusy) return;
      const currentEpoch = epoch;
      const version = ++selectionVersion;
      status('workspace-status', '선택한 기록을 불러오고 있어요.');
      try {
        const result = await request(`/api/records/${encodeURIComponent(id)}`);
        if (!authenticated || currentEpoch !== epoch || version !== selectionVersion) return;
        if (!isObject(result.record)) throw new Error('기록 형식을 확인할 수 없어요.');
        renderDetail(result.record, false);
        status('workspace-status', '');
      } catch (error) {
        if (authenticated && currentEpoch === epoch && version === selectionVersion) status('workspace-status', error.message, true);
      }
    }
    function showPending() {
      if (!pending || !authenticated || saving || actionBusy) return;
      selectionVersion++;
      renderDetail(pending.record, true);
    }
    function syncActions() {
      for (const id of ['save-capture', 'discard-capture', 'delete-record', 'download-json', 'download-video', 'review-capture', 'logout']) $(id).disabled = saving || actionBusy;
      $('save-capture').textContent = saving ? '기록을 저장하고 있어요…' : '이 기록 저장하기';
    }
    async function receiveCapture(event) {
      if(!captureAllowed(event,win.opener,authenticated,captureMode))return;
      const record=event.data.record;
      if(!isObject(record) || typeof record.id!=='string' || (record.revision!==undefined && (!Number.isSafeInteger(record.revision)||record.revision<0))){
        status('workspace-status','받은 기록의 형식을 확인할 수 없어요. 원래 화면에서 다시 보내주세요.',true);return;
      }
      const capture={record,video:event.data.video||null,origin:event.origin};
      if(capture.video && (!(capture.video instanceof win.Blob)||!capture.video.size||capture.video.size>MAX_VIDEO_BYTES||!/^video\/(webm|mp4)(?:;|$)/i.test(capture.video.type))){
        status('workspace-status','영상은 15 MiB 이하의 WebM 또는 MP4 파일이어야 합니다. 원래 화면에서 다시 기록해주세요.',true);
        acknowledge('ghosting:error',capture,{message:'영상 형식이나 크기를 확인해 주세요.',code:'INVALID_VIDEO'});return;
      }
      if(deletedIDs.has(record.id)){rejectDeleted(capture);return;}
      const revision=revisionValue(record);
      if((pending||saving) && pending?.record.id!==record.id && !continuousMode){
        status('workspace-status','먼저 받은 기록이 저장 대기 중입니다. 저장하거나 취소한 뒤 원래 화면에서 다시 보내주세요.',true);
        acknowledge('ghosting:error',capture,{message:'먼저 받은 기록을 저장한 뒤 다시 보내주세요.',code:'CAPTURE_BUSY'});return;
      }
      remember(capture);acknowledge('ghosting:received',capture);
      if(pending && pending.record.id===record.id && revision<=revisionValue(pending.record))return;
      const queued=inbox.get(record.id);
      if(queued && revision<=revisionValue(queued.record))return;
      capture.video ||= queued?.video || (pending?.record.id===record.id ? pending.video : null);
      if(saving){inbox.set(record.id,capture);return;}
      if(pending && pending.record.id!==record.id){inbox.set(record.id,capture);return;}
      pending=capture;updateCaptureNotice();showPending();
      status('workspace-status',autoSave?'영상과 해석을 비공개로 동기화하고 있어요.':'움직임을 받았어요. 아래 내용을 확인한 뒤 저장해주세요.');
      if(autoSave)await saveCapture();
    }
    async function saveCapture() {
      if(!authenticated||!pending||saving||actionBusy)return;
      const capture=pending,currentEpoch=epoch;
      saving=true;syncActions();status('detail-status','영상과 분석 정보를 저장하고 있어요.');
      let completed=false;
      try{
        const id=capture.record.id,revision=revisionValue(capture.record);
        let result;
        if(storedRevisions.has(id)){
          result=await updateStoredCapture(id,capture.record);
        }else{
          const body=new win.FormData();body.append('record',JSON.stringify(capture.record));
          if(capture.video)body.append('video',capture.video,capture.video.type.includes('mp4')?'movement.mp4':'movement.webm');
          result=await request('/api/records',{method:'POST',body});
          const existingRevision=Number.isSafeInteger(result.revision)?result.revision:0;
          if(result.alreadySaved && revision>existingRevision)result=await updateStoredCapture(id,capture.record);
        }
        if(!authenticated||currentEpoch!==epoch)return;
        const responseId=text(result.record?.id)||text(result.id);
        if(responseId!==id)throw new Error('저장 확인 번호가 일치하지 않아요. 목록을 다시 확인해주세요.');
        const storedRevision=Number.isSafeInteger(result.revision)?result.revision:revision;
        if(storedRevision<revision)throw new Error('최신 입력의 저장 확인을 받지 못했어요. 다시 시도해주세요.');
        pending=null;clearVideo();updateCaptureNotice();saved(capture,storedRevision);completed=true;
        await refreshRecords();
        const detail=await request('/api/records/'+encodeURIComponent(id));
        if(authenticated && currentEpoch===epoch && isObject(detail.record))renderDetail(detail.record,false);
        if(authenticated && currentEpoch===epoch)status('workspace-status',result.alreadySaved?'이미 저장된 기록이에요. 최신 보관 내용을 열었습니다.':'영상과 결과를 비공개로 보관했어요.');
      }catch(error){
        if(authenticated&&currentEpoch===epoch){
          status('detail-status',error.message+' 저장 전 데이터는 이 창과 원래 화면에 남아 있습니다. 다시 시도해주세요.',true);
          notifyPendingError(error.message,error.code || 'SAVE_FAILED');
        }
      }finally{
        saving=false;syncActions();
        if(completed && authenticated && currentEpoch===epoch)nextCapture();
      }
    }
    function confirmAction(title, message, label) {
      $('confirm-heading').textContent = title;
      $('confirm-message').textContent = message;
      $('confirm-accept').textContent = label;
      $('confirm-dialog').showModal();
      $('confirm-cancel').focus();
      return new Promise(resolve => { confirmation = resolve; });
    }
    function finishConfirmation(accepted) {
      const resolve = confirmation;
      confirmation = null;
      $('confirm-dialog').close();
      resolve?.(accepted);
    }
    async function discardCapture() {
      if (!pending || saving || actionBusy) return;
      const capture=pending,currentEpoch=epoch;
      if (!await confirmAction('이 기록의 저장을 취소할까요?', '아직 저장하지 않은 영상과 분석 정보가 이 창과 원래 화면의 대기 목록에서 사라집니다.', '저장 취소하기')) return;
      if(!authenticated||currentEpoch!==epoch||pending!==capture||saving||actionBusy)return;
      pending=null;inbox.delete(capture.record.id);waitingAcks.delete(capture.record.id);
      hideDetail();updateCaptureNotice();renderList();
      status('workspace-status', '저장 전 기록을 지웠어요. 원래 화면에서 새 기록을 보낼 수 있습니다.');
      acknowledge('ghosting:discarded',capture);
      announceReady();nextCapture();
    }
    async function deleteRecord(explicitRecord) {
      const record = explicitRecord?.id ? explicitRecord : selectedIsPending ? null : selected;
      if (!record || saving || actionBusy) return;
      const currentEpoch = epoch;
      if (!await confirmAction('이 움직임의 기록을 삭제할까요?', '저장한 영상과 분석 정보가 함께 삭제됩니다. 삭제한 기록은 복원할 수 없습니다.', '기록 삭제하기')) return;
      if (!authenticated || currentEpoch !== epoch) return;
      actionBusy = true;
      syncActions();
      try {
        await request(`/api/records/${encodeURIComponent(record.id)}`, { method: 'DELETE' });
        if (!authenticated || currentEpoch !== epoch) return;
        markDeleted(record.id);
        if (!selectedIsPending && selected?.id === record.id) hideDetail();
        await refreshRecords();
        status('workspace-status', '기록과 영상을 삭제했어요.');
      } catch (error) {
        if (authenticated && currentEpoch === epoch) status('workspace-status', error.message, true);
      } finally { actionBusy = false; syncActions(); }
    }
    function downloadBlob(blob, filename) {
      const url = win.URL.createObjectURL(blob);
      downloadURLs.add(url);
      const link = element('a');
      link.href = url;
      link.download = filename;
      doc.body.append(link);
      link.click();
      link.remove();
      win.setTimeout(() => { win.URL.revokeObjectURL(url); downloadURLs.delete(url); }, 1000);
    }
    async function downloadVideo() {
      if (!selected || selectedIsPending || saving || actionBusy) return;
      const record = selected;
      const currentEpoch = epoch;
      actionBusy = true;
      syncActions();
      status('detail-status', '영상 파일을 준비하고 있어요.');
      try {
        const blob = await request(`/api/records/${encodeURIComponent(record.id)}/video`, { asBlob: true });
        if (!authenticated || currentEpoch !== epoch) return;
        downloadBlob(blob, `ghosting-${record.id.replace(/[^a-zA-Z0-9_-]/g, '')}.${blob.type.includes('mp4') ? 'mp4' : blob.type.includes('ogg') ? 'ogv' : 'webm'}`);
        status('detail-status', '영상 다운로드를 시작했어요.');
      } catch (error) {
        if (authenticated && currentEpoch === epoch) status('detail-status', error.message, true);
      } finally { actionBusy = false; syncActions(); }
    }
    function start() {
      const home=doc.querySelector?.('.site-header .brand');
      if(home&&captureMode)home.setAttribute('href','/logs/'+win.location.search);
      $('login-form').addEventListener('submit', async event => {
        event.preventDefault();
        if ($('login-submit').disabled) return;
        $('login-submit').disabled = true;
        status('login-status', '기록함을 열고 있어요.');
        try {
          await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
          await unlock();
        } catch (error) { status('login-status', error.message, true); }
        finally { $('password').value = ''; $('login-submit').disabled = false; }
      });
      $('logout').addEventListener('click', async () => {
        if (pending && !await confirmAction('기록함을 닫을까요?', '저장 전 영상과 기록이 사라집니다. 저장하려면 돌아가기를 눌러주세요.', '로그아웃')) return;
        $('logout').disabled = true;
        try {
          await request('/api/logout', { method: 'POST' });
          notifyPendingError('로그아웃했어요. 원래 화면에 보관한 기록은 다시 로그인하면 동기화할 수 있어요.');
          pending = null;inbox.clear();waitingAcks.clear();
          lock('로그아웃했어요.');
        } catch (error) {
          if (error.status === 401) pending = null;
          if (authenticated) status('workspace-status', error.message, true);
        } finally { $('logout').disabled = false; }
      });
      $('session-retry').addEventListener('click', checkSession);
      $('refresh').addEventListener('click', refreshRecords);
      $('review-capture').addEventListener('click', showPending);
      $('save-capture').addEventListener('click', saveCapture);
      $('discard-capture').addEventListener('click', discardCapture);
      $('delete-record').addEventListener('click', deleteRecord);
      $('download-video').addEventListener('click', downloadVideo);
      $('download-json').addEventListener('click', () => {
        if (!authenticated || !selected || selectedIsPending) return;
        downloadBlob(new win.Blob([JSON.stringify(selected, null, 2)], { type: 'application/json' }), `ghosting-${text(selected.id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
      });
      $('record-video').addEventListener('error', () => {
        if (!authenticated || !selected) return;
        $('video-status').textContent = selectedIsPending
          ? '이 브라우저에서 영상 미리보기를 열지 못했어요. 기록을 저장한 뒤 다운로드해 확인할 수 있습니다.'
          : '영상 반영 중이거나 연결이 지연됐어요. 잠시 후 다시 열어주세요.';
        $('retry-video').hidden = selectedIsPending;
      });
      $('retry-video').addEventListener('click', () => {
        if (!authenticated || !selected || selectedIsPending) return;
        $('record-video').src = `/api/records/${encodeURIComponent(selected.id)}/video?retry=${Date.now()}`;
        $('record-video').load();
        $('video-status').textContent = '영상을 다시 불러오고 있어요.';
        $('retry-video').hidden = true;
      });
      $('confirm-cancel').addEventListener('click', () => finishConfirmation(false));
      $('confirm-accept').addEventListener('click', () => finishConfirmation(true));
      $('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); finishConfirmation(false); });
      win.addEventListener('message', receiveCapture);
      win.addEventListener('beforeunload', event => { if (pending || saving) { event.preventDefault(); event.returnValue = ''; } });
      win.addEventListener('pagehide', () => { clearVideo(); for (const url of downloadURLs) win.URL.revokeObjectURL(url); downloadURLs.clear(); });
      win.addEventListener('pageshow', event => { if (event.persisted) { lock(); checkSession(); } });
      return checkSession();
    }
    return { start };
  }
  return { createApp, captureAllowed, scoreValue, frequencies, MAX_VIDEO_BYTES };
});
