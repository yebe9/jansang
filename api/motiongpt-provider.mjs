// Local CPU captioning boundary. Never send 2D coordinates as if they were HumanML3D.
export class MotionCaptionError extends Error { constructor(code,message,status=503){super(message);this.code=code;this.status=status;} }
export async function requestMotionCaption(motion,env,{fetchImpl=fetch,signal}={}){
  if(!env.MOTIONGPT_URL||motion.source!=='webcam')return null;
  let url;try{url=new URL(env.MOTIONGPT_URL);}catch{throw new MotionCaptionError('MOTIONGPT_CONFIG','MotionGPT 서버 주소를 확인해 주세요.');}
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.search||url.hash)throw new MotionCaptionError('MOTIONGPT_CONFIG','MotionGPT는 이 컴퓨터의 로컬 CPU 서버에 연결해야 합니다.');
  const samples=motion.samples.map(frame=>({t:frame.t,segment:frame.segment||0,worldJoints:frame.worldJoints||{}}));
  if(!samples.some(f=>Object.keys(f.worldJoints).length>=14))throw new MotionCaptionError('MOTIONGPT_COORDINATES','전신의 3D 관절이 충분히 보이도록 어깨부터 양발까지 다시 기록해 주세요.',422);
  url.pathname='/caption';
  let response;try{response=await fetchImpl(url,{method:'POST',headers:{'Content-Type':'application/json'},signal,body:JSON.stringify({source:'webcam',durationMs:motion.durationMs,samples})});}catch(error){if(signal?.aborted)throw error;throw new MotionCaptionError('MOTIONGPT_OFFLINE','로컬 MotionGPT CPU 서버를 실행해 주세요.');}
  let data;try{data=await response.json();}catch{throw new MotionCaptionError('MOTIONGPT_RESPONSE','MotionGPT 응답을 읽지 못했어요.');}
  if(!response.ok)throw new MotionCaptionError(typeof data?.error?.code==='string'?data.error.code:'MOTIONGPT_UNAVAILABLE',typeof data?.error?.message==='string'?data.error.message:'MotionGPT CPU 모델을 준비하고 다시 시도해주세요.',response.status===429?429:503);
  if(data.provider!=='MotionGPT'||typeof data.caption!=='string'||!data.caption.trim()||data.caption.length>3000)throw new MotionCaptionError('MOTIONGPT_RESPONSE','실제 동작 설명을 받지 못했어요.');
  return {provider:'MotionGPT',model:typeof data.model==='string'?data.model:'MotionGPT-base',caption:data.caption,frames:data.frames,retargeting:data.provenance||data.retargeting||data.preprocessing||null};
}
