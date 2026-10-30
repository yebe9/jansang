const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const zlib=require('node:zlib');
const {spawnSync}=require('node:child_process');
const {create,fromData,normalize,cosine,FORMAT}=require('../dist/semantic-similarity.js');

function fixture(rows={유연함:[127,0,0],우아한:[100,100,0],빠른:[0,127,0],차분함:[-127,0,0],나비:[100,0,100],같은:[0,-127,0]}){
 const words=Object.keys(rows);
 const manifest={format:FORMAT,model:'deterministic test vectors',dimension:3,count:words.length,words,vectorsFile:'ko-fasttext.int8.bin'};
 const bytes=Int8Array.from(Object.values(rows).flat());
 return {manifest,bytes,engine:fromData(manifest,bytes)};
}
const response=(body,status=200)=>({ok:status>=200 && status<300,status,json:async()=>body,arrayBuffer:async()=>body});

test('cosine uses actual vectors, is scale invariant, and preserves zero and negative similarity',()=>{
 assert.equal(cosine([3,0],[1,0]),1);
 assert.equal(cosine([3,0],[0,7]),0);
 assert.equal(cosine([3,0],[-7,0]),-1);
 assert.equal(cosine([0,0],[1,0]),null);
 assert.equal(cosine([NaN,1],[1,1]),null);
 assert.equal(cosine([1],[1,1]),null);
});

test('NFC normalization matches decomposed Korean and does not use spelling-overlap scores',async()=>{
 const {engine}=fixture();
 assert.equal(normalize('  '+ '유연함'.normalize('NFD')+'  '),'유연함');
 const result=await engine.rank('유연함'.normalize('NFD'),['우아한','유연함','빠른','차분함']);
 assert.equal(result.method,'fasttext-cosine');
 assert.equal(result.results[0].label,'유연함'); assert.equal(result.results[0].similarity,100);
 assert.ok(Math.abs(result.results.find(x=>x.label==='우아한').rawCosine-Math.SQRT1_2)<1e-10);
 assert.equal(result.results.find(x=>x.label==='빠른').similarity,0);
 assert.equal(result.results.at(-1).similarity,-100);
});

test('even identical unregistered words remain unavailable rather than receiving a fabricated perfect score',async()=>{
 const result=await fixture().engine.rank('완전미등록문자열',['완전미등록문자열','유연함']);
 assert.equal(result.results.length,0); assert.equal(result.unavailable.length,2);
 assert.ok(result.unavailable.every(item=>item.similarity===null && item.rawCosine===null));
 assert.deepEqual(result.missingTokens,['완전미등록문자열']);
 assert.equal(result.queryCoverage,0);
});

test('a missing candidate is reported separately without being converted to zero',async()=>{
 const result=await fixture().engine.rank('유연함',['미등록표현','빠른']);
 assert.deepEqual(result.results.map(x=>[x.label,x.similarity]),[['빠른',0]]);
 assert.equal(result.unavailable[0].similarity,null);
 assert.equal(result.unavailable[0].reason,'CANDIDATE_OUT_OF_VOCABULARY');
});

test('sentence means disclose missing tokens and coverage, including their order/negation limitation',async()=>{
 const {engine}=fixture();
 const first=await engine.rank('유연함 빠른 미등록표현',['우아한']);
 const reordered=await engine.rank('빠른 유연함 미등록표현',['우아한']);
 assert.equal(first.results[0].similarity,100);
 assert.equal(first.results[0].rawCosine,reordered.results[0].rawCosine);
 assert.equal(first.queryCoverage,2/3);
 assert.deepEqual(first.missingTokens,['미등록표현']);
 assert.ok(first.limitations.some(line=>line.includes('부정')));
});

test('explicit phrase forms resolve to observed words and common particles are removed only after exact lookup',async()=>{
 const {engine}=fixture();
 const phrase=await engine.rank('나비 같은',['나비']);
 assert.equal(phrase.results[0].similarity,100);
 assert.deepEqual(phrase.resolvedTokens,[{token:'나비 같은',word:'나비'}]);
 const particle=await engine.rank('유연함으로',['유연함']);
 assert.equal(particle.results[0].similarity,100);
 const native=fixture({유연한:[0,127,0],유연함:[127,0,0]}).engine;
 assert.equal((await native.rank('유연한',['유연함'])).results[0].similarity,0,'An available native vector wins over morphological alternatives');
});

test('ranking keeps evidence, supports explicit comparison text and respects a top-five limit',async()=>{
 const {engine}=fixture();
 const result=await engine.rank('유연함',[
  {label:'글로 쓴 인상',text:'유연함',evidence:'원래 근거'},'유연함','우아한','나비','빠른','차분함','빠른'
 ]);
 assert.equal(result.results.length,5);
 assert.equal(result.results.find(x=>x.label==='글로 쓴 인상').evidence,'원래 근거');
 assert.equal(new Set(result.results.map(x=>x.label)).size,5);
 assert.ok(result.results.every((item,i,list)=>!i || list[i-1].rawCosine>=item.rawCosine));
});

test('invalid or zero vector data fails honestly without a numeric result',async()=>{
 const {manifest,bytes}=fixture();
 assert.throws(()=>fromData({...manifest,count:99},bytes),/크기/);
 assert.throws(()=>fromData(manifest,new Int8Array(1)),/형식/);
 assert.throws(()=>fromData({...manifest,words:['유연함','유연함'],count:2},new Int8Array(6)),/중복/);
 const zero=fixture({유연함:[0,0,0]}).engine;
 assert.equal((await zero.rank('유연함',['유연함'])).results.length,0);
});

test('lazy loading fetches each public asset once and never sends the private query in a request',async()=>{
 const {manifest,bytes}=fixture(); const calls=[];
 const engine=create({baseURL:'https://example.test/semantic',fetchImpl:async url=>{
  calls.push(url); return url.endsWith('.json') ? response(manifest) : response(bytes.buffer);
 }});
 const [a,b]=await Promise.all([engine.rank('유연함',['우아한']),engine.rank('차분함',['차분함'])]);
 assert.equal(a.results.length,1); assert.equal(b.results[0].similarity,100);
 assert.deepEqual(calls,['https://example.test/semantic/ko-fasttext.json','https://example.test/semantic/ko-fasttext.int8.bin']);
});

test('network failures stay unavailable and an explicit retry can load the dictionary',async()=>{
 const {manifest,bytes}=fixture(); let attempts=0;
 const engine=create({fetchImpl:async url=>{
  if(++attempts===1)return response({},503);
  return url.endsWith('.json') ? response(manifest) : response(bytes.buffer);
 }});
 await assert.rejects(engine.rank('유연함',['우아한']),{code:'VECTORS_UNAVAILABLE'});
 assert.equal((await engine.rank('유연함',['우아한'])).results.length,1);
 assert.equal(attempts,3);
});

test('a manifest cannot redirect vector loading to an arbitrary endpoint',async()=>{
 const {manifest}=fixture(); const calls=[];
 const engine=create({fetchImpl:async url=>{calls.push(url);return response({...manifest,vectorsFile:'https://evil.test/leak'});}});
 await assert.rejects(engine.rank('유연함',['우아한']),{code:'INVALID_VECTORS'});
 assert.equal(calls.length,1);
});

test('cancellation rejects the result while a shared model load remains reusable',async()=>{
 const {manifest,bytes}=fixture(); let resolve;
 const delayed=new Promise(done=>{resolve=done;});
 const engine=create({fetchImpl:async url=>url.endsWith('.json') ? response(manifest) : delayed});
 const controller=new AbortController();
 const result=engine.rank('유연함',['우아한'],{signal:controller.signal});
 controller.abort();resolve(response(bytes.buffer));
 await assert.rejects(result,{name:'AbortError'});
 assert.equal((await engine.rank('유연함',['유연함'])).results[0].similarity,100);
});

test('builder streams a genuine text-vector archive, includes rare forms and emits a checked int8 deployment asset',t=>{
 const python=process.env.PYTHON || 'python';
 const available=spawnSync(python,['--version'],{encoding:'utf8'});
 if(available.error || available.status!==0){t.skip('Python is not installed');return;}
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ghosting-semantic-'));
 const resolved=path.resolve(temporary);
 assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'ghosting-semantic-'));
 t.after(()=>fs.rmSync(resolved,{recursive:true,force:true}));
 const names=['가벼움','차분함','유연함','유연한','차분한','다른'];
 const row=(name,index)=>name+' '+Array.from({length:300},(_,i)=>i===index ? '1' : '0').join(' ');
 const source=path.join(temporary,'fixture.vec.gz');
 fs.writeFileSync(source,zlib.gzipSync(names.length+' 300\n'+names.map(row).join('\n')+'\n'));
 const output=path.join(temporary,'semantic');
 const execution=spawnSync(python,[path.join(__dirname,'../scripts/build-korean-vectors.py'),'--source',source,'--output',output,'--limit','2'],{cwd:path.join(__dirname,'..'),encoding:'utf8'});
 assert.equal(execution.status,0,execution.stderr || execution.stdout);
 const manifest=JSON.parse(fs.readFileSync(path.join(output,'ko-fasttext.json'),'utf8'));
 const bytes=fs.readFileSync(path.join(output,'ko-fasttext.int8.bin'));
 assert.equal(manifest.source.declaredRows,names.length);
 assert.equal(manifest.dimension,300);
 assert.ok(manifest.words.includes('유연한'),'Rare dance forms after the common-word cutoff remain included');
 assert.equal(bytes.length,manifest.count*300);
 assert.equal(manifest.source.license,'CC-BY-SA-3.0');
 assert.equal(manifest.vectorsSha256,require('node:crypto').createHash('sha256').update(bytes).digest('hex'));
});
test('the shipped asset contains real 300D Korean vectors and covers every supplied dance expression',async()=>{
 const metadataPath=path.join(__dirname,'../dist/semantic/ko-fasttext.json');
 const binaryPath=path.join(__dirname,'../dist/semantic/ko-fasttext.int8.bin');
 assert.ok(fs.existsSync(metadataPath),'Build and ship the filtered real model before deployment');
 const manifest=JSON.parse(fs.readFileSync(metadataPath,'utf8'));
 const binary=fs.readFileSync(binaryPath);
 assert.equal(manifest.dimension,300);assert.ok(manifest.count>=50000);
 assert.equal(binary.length,manifest.count*300);
 assert.equal(manifest.vectorsSha256,require('node:crypto').createHash('sha256').update(binary).digest('hex'));
 const engine=fromData(manifest,binary);
 const {DANCE_VOCABULARY}=await import('../api/dance-vocabulary.mjs');
 const result=await engine.rank('부드럽고 자유로운 움직임',DANCE_VOCABULARY.map(entry=>entry.label));
 assert.equal(result.results.length,5);assert.equal(result.unavailable.length,0);
 assert.ok(result.results.every(entry=>typeof entry.rawCosine==='number' && Number.isFinite(entry.similarity)));
 assert.equal(result.queryCoverage,1);
 assert.equal((await engine.rank('유연함',['유연함'])).results[0].similarity,100);
 assert.equal((await engine.rank('완전미등록낱말검증',['완전미등록낱말검증'])).results.length,0);
});