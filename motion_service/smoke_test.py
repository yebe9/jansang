"""Run a real-model smoke test with synthetic, non-personal 3D motion data."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import time
from urllib.request import Request, urlopen
from .test_preprocessing import fixture


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--direct',action='store_true',help='Load a separate runtime instead of calling the existing service.')
    parser.add_argument('--url',default='http://127.0.0.1:8765')
    parser.add_argument('--output',type=Path)
    parser.add_argument('--duration-ms',type=int,default=2000)
    parser.add_argument('--measured-frames',type=int,default=0)
    args=parser.parse_args()
    if not 1000 <= args.duration_ms <= 10000:
        parser.error('duration-ms must be between 1000 and 10000')
    payload=fixture(duration_ms=args.duration_ms)
    if args.measured_frames:
        if not 8 <= args.measured_frames <= len(payload['samples']):
            parser.error('measured-frames must be 8..the generated sample count')
        import numpy as np
        indexes=np.linspace(0,len(payload['samples'])-1,args.measured_frames).round().astype(int)
        payload['samples']=[payload['samples'][int(index)] for index in indexes]
    started=time.monotonic()
    if args.direct:
        from .runtime import MotionRuntime
        runtime=MotionRuntime()
        runtime.load()
        if not runtime.health()['ready']:
            raise RuntimeError('The real model did not become ready.')
        result=runtime.caption(payload)
    else:
        if args.url not in {'http://127.0.0.1:8765','http://localhost:8765'}:
            parser.error('Use the standard loopback test endpoint.')
        request=Request(args.url+'/caption',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'},method='POST')
        with urlopen(request,timeout=180) as response:
            result=json.load(response)
    if result.get('provider')!='MotionGPT' or not isinstance(result.get('caption'),str) or not result['caption'].strip():
        raise RuntimeError('The service did not return a real MotionGPT caption.')
    result['smokeTest']={'input':'synthetic 3D body fixture, not a camera recording','wallTimeMs':round((time.monotonic()-started)*1000),'actualNeuralInference':True}
    output=json.dumps(result,ensure_ascii=False,indent=2)+'\n'
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(output,encoding='utf-8')
    print(output,flush=True)


if __name__=='__main__':main()
