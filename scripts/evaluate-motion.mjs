// Controlled synthetic regression probe; not a human-dance accuracy benchmark.
import fs from 'node:fs/promises';
import fixtures from './motion-fixtures.cjs';
const endpoint=process.argv[2]||'http://127.0.0.1:4173';
const output=process.argv[3];
const names=(process.argv[4]||'stationary,jitter,slow_broad,fast_broad').split(',');
const results=[];
for(const name of names){
 const motion=fixtures.payload(name),start=Date.now();
 const requestOptions={method:'POST',headers:{Origin:endpoint.includes('127.0.0.1')?'http://127.0.0.1:4173':'https://yebe9.github.io','Content-Type':'application/json'},body:JSON.stringify(motion)};
 const response=endpoint==='in-process'?await (await import('../api/handler.mjs')).handleApi(new Request('https://test.local/api/analyze',requestOptions),{env:{GEMINI_API_KEY:process.env.GEMINI_API_KEY,GEMINI_MODEL:process.env.GEMINI_MODEL}}):await fetch(endpoint+'/api/analyze',requestOptions);
 const data=await response.json();
 const item={name,status:response.status,elapsedMs:Date.now()-start,provider:data.provider,impression:data.analysis?.impression,candidates:data.analysis?.candidates,rubric:data.analysis?.rubric,error:data.error};
 results.push(item);console.log(JSON.stringify(item));
}
if(output)await fs.writeFile(output,JSON.stringify({input:'synthetic projected skeletons; not real-person accuracy evaluation',results},null,2));
