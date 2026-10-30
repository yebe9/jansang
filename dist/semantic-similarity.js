/*
 * Korean fastText cosine similarity for Ghosting.
 * Independently implemented from the mathematical method documented in
 * NewsJelly/semantle-ko word2vec.py and its NFC normalization in process_vecs.py.
 * Source/provenance and upstream GPL-3.0 notice: third_party/semantle-ko/README.md.
 * Filtered fastText vectors are CC BY-SA 3.0; see the distributed model manifest.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GhostingSemantic = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  'use strict';
  const FORMAT = 'ghosting-fasttext-int8-v1';
  const METHOD = 'fasttext-cosine';
  const LIMITATIONS = Object.freeze([
    '단어 벡터의 의미적 가까움이며 의도나 감정이 맞을 확률이 아닙니다.',
    '문장은 알려진 단어 벡터를 평균하므로 어순·부정 표현·문맥을 충분히 구별하지 못합니다.',
    '빈도가 높은 한국어 단어와 춤 표현으로 제한한 사전이며 미등록어는 측정하지 않습니다.',
    '동음이의어와 형태 변환의 모호함, 정수 양자화에 따른 작은 오차가 있습니다.'
  ]);
  const MORPH_FORMS = Object.freeze({
    "우아한":["우아함","우아하다","우아"],"유려한":["유려함","유려하다","유려"],
    "감미로운":["감미로움","감미롭다","감미"],"나비 같은":["나비"],
    "연연한":["연연함","연연하다","연연"],"미려한":["미려함","미려하다","미려"],
    "매끄러운":["매끄러움","매끄럽다","매끄럽게"],"사뿐한":["사뿐함","사뿐하다","사뿐"],
    "나풀거리는":["나풀거림","나풀거리다","나풀"],"역동적인":["역동적","역동성","역동"],
    "폭발적인":["폭발적","폭발성","폭발"],"절도 있는":["절도"],
    "파워풀한":["파워풀","파워풀하다"],"격정적인":["격정적","격정"],
    "거침없는":["거침없이","거침없다"],"저돌적인":["저돌적","저돌성","저돌"],
    "직선적인":["직선적","직선"],"압도적인":["압도적","압도"],
    "몽환적인":["몽환적","몽환"],"신비로운":["신비로움","신비롭다","신비"],
    "의식적인":["의식적","의식"],"홀린 듯한":["홀린","홀림","홀리다"],
    "환상적인":["환상적","환상"],"정령 같은":["정령"],
    "매혹적인":["매혹적","매혹"],"몽롱한":["몽롱함","몽롱하다","몽롱"],
    "경쾌한":["경쾌함","경쾌하다","경쾌"],"재치 있는":["재치"],
    "그루비한":["그루비","그루브"],"분주한":["분주함","분주하다","분주"],
    "자유분방한":["자유분방함","자유분방하다","자유분방"],"익살스러운":["익살스럽다","익살스러움","익살"],
    "리드미컬한":["리드미컬","리드미컬하다","리듬"],"통통 튀는":["통통","튀는","튀다"],
    "애절한":["애절함","애절하다","애절"],"서정적인":["서정적","서정성","서정"],
    "처연한":["처연함","처연하다","처연"],"격앙된":["격앙","격앙되다"],
    "절제된":["절제","절제되다"],"묵직한":["묵직함","묵직하다","묵직"],
    "호소력 짙은":["호소력"],"처절한":["처절함","처절하다","처절"],
    "정교한":["정교함","정교하다","정교"],"감각적인":["감각적","감각"],
    "기하학적인":["기하학적","기하학"],"날카로운":["날카로움","날카롭다","날카롭게"],
    "유연한":["유연함","유연하다","유연성","유연"],"아크로바틱한":["아크로바틱","아크로바틱하다"],
    "미니멀한":["미니멀","미니멀하다"],"유기적인":["유기적","유기성"],
    "빠른":["빠름","빠르다","빠르게"],"초조한":["초조함","초조하다","초조"],
    "차분한":["차분함","차분하다","차분"],"부드러운":["부드러움","부드럽다","부드럽게"]
  });
  const normalize = value => typeof value === 'string' ? value.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const abortError = () => Object.assign(new Error('유사도 계산을 취소했습니다.'), { name:'AbortError', code:'CANCELLED' });
  function checkSignal(signal) { if (signal?.aborted) throw abortError(); }
  function failure(code, message) { return Object.assign(new Error(message), { code }); }
  function unit(values) {
    let square = 0;
    for (const value of values) { if (!Number.isFinite(value)) return null; square += value * value; }
    if (!square) return null;
    const length = Math.sqrt(square);
    return Float64Array.from(values, value => value / length);
  }
  function cosine(a,b) {
    if (!a || !b || a.length !== b.length || !a.length) return null;
    let dot=0, aa=0, bb=0;
    for(let i=0;i<a.length;i++) {
      if(!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
      dot+=a[i]*b[i]; aa+=a[i]*a[i]; bb+=b[i]*b[i];
    }
    if(!aa || !bb) return null;
    return Math.max(-1, Math.min(1,dot/Math.sqrt(aa*bb)));
  }
  function validate(manifest, bytes) {
    if (!manifest || manifest.format !== FORMAT || !Number.isInteger(manifest.dimension) ||
        manifest.dimension < 1 || manifest.dimension > 1024 || !Array.isArray(manifest.words) ||
        !manifest.words.length || manifest.words.length > 100000 || bytes.byteLength !== manifest.words.length * manifest.dimension) {
      throw failure('INVALID_VECTORS','한국어 벡터 파일 형식을 확인할 수 없습니다.');
    }
    if (manifest.count !== undefined && manifest.count !== manifest.words.length) throw failure('INVALID_VECTORS','한국어 벡터 사전 크기가 맞지 않습니다.');
    const seen = new Set();
    for (const word of manifest.words) {
      if (typeof word !== 'string' || !word || normalize(word) !== word || seen.has(word)) throw failure('INVALID_VECTORS','한국어 벡터 사전에 중복 또는 잘못된 단어가 있습니다.');
      seen.add(word);
    }
  }
  function fromData(manifest, data) {
    const bytes = data instanceof Int8Array ? data : new Int8Array(data);
    validate(manifest, bytes);
    const words = new Map(manifest.words.map((word,index) => [word,index]));
    const cache = new Map();
    const aliases = new Map();
    for(const [label,forms] of Object.entries(MORPH_FORMS)) {
      aliases.set(normalize(label),forms); aliases.set(normalize(label).replace(/\s/g,''),forms);
      for(const form of forms) if(!aliases.has(normalize(form))) aliases.set(normalize(form),[label,...forms]);
    }
    const lookup = word => {
      if(cache.has(word)) return cache.get(word);
      const index=words.get(word);
      if(index === undefined) return null;
      const vector=unit(bytes.subarray(index*manifest.dimension,(index+1)*manifest.dimension));
      if(!vector) return null;
      if(cache.size >= 2048) cache.delete(cache.keys().next().value);
      cache.set(word,vector); return vector;
    };
    function resolve(token) {
      let vector=lookup(token);
      if(vector) return {word:token,vector};
      for(const form of aliases.get(token) || []) {
        const word=normalize(form); vector=lookup(word);
        if(vector) return {word,vector};
      }
      // Only remove common Korean particles after exact lookup and explicit forms.
      for(const ending of ['에서는','으로는','에게는','처럼','에서','에게','으로','을','를','은','는','이','가','과','와','의','에','도']) {
        if(token.endsWith(ending) && token.length > ending.length+1) {
          const word=token.slice(0,-ending.length); vector=lookup(word);
          if(vector) return {word,vector};
        }
      }
      return null;
    }
    function embed(input) {
      const text=normalize(input).slice(0,2000);
      if(!text) return {vector:null,matchedTokens:[],missingTokens:[],resolvedTokens:[],coverage:0};
      const phrase=aliases.has(text) ? resolve(text) : null;
      const tokens=phrase ? [text] : (text.match(/[가-힣ㄱ-ㅎㅏ-ㅣa-z0-9]+/gu) || []).slice(0,80);
      const sum=new Float64Array(manifest.dimension), matchedTokens=[], missingTokens=[], resolvedTokens=[];
      for(const token of tokens) {
        const match=phrase || resolve(token);
        if(!match) {missingTokens.push(token);continue;}
        for(let i=0;i<sum.length;i++)sum[i]+=match.vector[i];
        matchedTokens.push(token);resolvedTokens.push({token,word:match.word});
      }
      return {vector:matchedTokens.length ? unit(sum) : null,matchedTokens,missingTokens,resolvedTokens,coverage:tokens.length ? matchedTokens.length/tokens.length : 0};
    }
    async function rank(query,candidates,options={}) {
      checkSignal(options.signal);
      if(typeof query !== 'string' || !Array.isArray(candidates) || candidates.length>100) throw failure('INVALID_QUERY','유사도를 비교할 표현을 확인해주세요.');
      const queryEmbedding=embed(query);
      const results=[],unavailable=[];
      const seen=new Set();
      for(const candidate of candidates) {
        const entry=typeof candidate === 'string' ? {label:candidate} : candidate;
        if(!entry || typeof entry.label !== 'string' || !entry.label.trim() || seen.has(entry.label))continue;
        seen.add(entry.label);
        const comparison=embed(typeof entry.text === 'string' ? entry.text : entry.label);
        const score=cosine(queryEmbedding.vector,comparison.vector);
        const record={label:entry.label,evidence:typeof entry.evidence === 'string' ? entry.evidence : '',similarity:score === null ? null : Math.round(score*1000)/10,rawCosine:score,matchedTokens:comparison.matchedTokens,missingTokens:comparison.missingTokens,coverage:comparison.coverage};
        if(score === null)unavailable.push({...record,reason:!queryEmbedding.vector ? 'QUERY_OUT_OF_VOCABULARY' : 'CANDIDATE_OUT_OF_VOCABULARY'});
        else results.push(record);
      }
      checkSignal(options.signal);
      const limit=Number.isInteger(options.limit) ? Math.max(1,Math.min(100,options.limit)) : 5;
      results.sort((a,b)=>b.rawCosine-a.rawCosine || a.label.localeCompare(b.label,'ko'));
      return {method:METHOD,model:manifest.model || 'fastText cc.ko.300 (filtered, int8)',results:results.slice(0,limit),unavailable,missingTokens:queryEmbedding.missingTokens,matchedTokens:queryEmbedding.matchedTokens,resolvedTokens:queryEmbedding.resolvedTokens,queryCoverage:queryEmbedding.coverage,limitations:[...LIMITATIONS]};
    }
    return {rank,embed,info:()=>({method:METHOD,model:manifest.model,wordCount:words.size,dimension:manifest.dimension,limitations:[...LIMITATIONS]})};
  }
  const scriptURL=root.document?.currentScript?.src;
  const defaultBaseURL=scriptURL ? new URL('./semantic/',scriptURL).href : './semantic/';
  function create(options={}) {
    const fetchImpl=options.fetchImpl || root.fetch?.bind(root);
    const base=options.baseURL || defaultBaseURL;
    let loading=null,engine=null;
    const asset=name=>String(base).replace(/\/?$/,'/')+name;
    async function load(loadOptions={}) {
      checkSignal(loadOptions.signal);
      if(engine)return engine;
      if(!loading)loading=(async()=>{
        if(!fetchImpl)throw failure('VECTORS_UNAVAILABLE','한국어 벡터를 불러올 수 없습니다.');
        const manifestResponse=await fetchImpl(asset('ko-fasttext.json'),{cache:'force-cache'});
        if(!manifestResponse.ok)throw failure('VECTORS_UNAVAILABLE','한국어 유사도 사전을 불러오지 못했습니다.');
        const manifest=await manifestResponse.json();
        if(manifest.format!==FORMAT || manifest.vectorsFile!=='ko-fasttext.int8.bin')throw failure('INVALID_VECTORS','한국어 유사도 사전 형식이 맞지 않습니다.');
        const response=await fetchImpl(asset('ko-fasttext.int8.bin'),{cache:'force-cache'});
        if(!response.ok)throw failure('VECTORS_UNAVAILABLE','한국어 유사도 벡터를 불러오지 못했습니다.');
        const buffer=await response.arrayBuffer();
        if(buffer.byteLength>32*1024*1024)throw failure('INVALID_VECTORS','한국어 벡터 파일이 너무 큽니다.');
        if(manifest.vectorsSha256 && root.crypto?.subtle) {
          const hash=await root.crypto.subtle.digest('SHA-256',buffer);
          const actual=[...new Uint8Array(hash)].map(n=>n.toString(16).padStart(2,'0')).join('');
          if(actual!==manifest.vectorsSha256)throw failure('INVALID_VECTORS','한국어 벡터 파일 검증에 실패했습니다. 새로고침 후 다시 시도해주세요.');
        }
        engine=fromData(manifest,new Int8Array(buffer));return engine;
      })().catch(error=>{loading=null;throw error.code ? error : failure('VECTORS_UNAVAILABLE','한국어 유사도 사전을 불러오지 못했습니다.');});
      const ready=await loading;checkSignal(loadOptions.signal);return ready;
    }
    return {load,rank:async(query,candidates,rankOptions={})=>(await load(rankOptions)).rank(query,candidates,rankOptions)};
  }
  const defaultEngine=create();
  return {create,fromData,cosine,normalize,MORPH_FORMS,LIMITATIONS,FORMAT,load:options=>defaultEngine.load(options),rank:(query,candidates,options)=>defaultEngine.rank(query,candidates,options)};
});