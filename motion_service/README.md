# MotionGPT CPU caption service

GPU 없이 공식 MotionGPT 사전 학습 가중치로 **영문 동작 캡션**을 생성하는 로컬 서비스다. 학습·Whisper·영상 렌더·SMPL·Lightning 데이터 로더를 실행하지 않고, 공식 VQ 모션 토크나이저와 T5 언어 모델만 직접 불러온다. 감정이나 의도 유사도를 측정하는 모델은 아니며, 여기서 나온 캡션의 한국어 표현 변환·의도 비교는 상위 애플리케이션이 처리한다.

## 설치와 실행

프로젝트 루트에서 Python 3.12와 CPU용 PyTorch 2.6을 사용한다. venv 생성 후 다음 명령을 실행한다.

    .venv-motion\Scripts\python.exe -m pip install torch==2.6.0 --index-url https://download.pytorch.org/whl/cpu
    .venv-motion\Scripts\python.exe -m pip install -r motion_service\requirements.txt
    .venv-motion\Scripts\python.exe -m motion_service.download_models
    .venv-motion\Scripts\python.exe -m motion_service.server --port 8765

모델은 기본적으로 프로젝트의 .models/motiongpt/에 저장한다. MOTIONGPT_MODEL_DIR 환경변수로 경로를 바꿀 수 있다. 최소 공식 소스도 고정 revision으로 설치하므로 vendor 폴더가 없는 새 체크아웃에서 재현할 수 있다.

공식 MotionGPT 체크포인트 약 1.33GB, Flan-T5 단일 safetensors 약 0.99GB와 토크나이저·정규화 값을 받아 **총 2,326,176,467바이트**를 저장한다. 중복 PT/TF/Flax 포맷은 받지 않는다. 다운로드는 .part 파일로 재개하며 크기와 SHA-256이 일치한 파일만 설치한다. HTTP 범위 읽기를 지원해 대용량 전체 응답 지연을 피한다. 첫 실행은 다운로드·메모리 로드 시간 때문에 오래 걸릴 수 있으며, CPU 캡션의 특정 응답 시간을 보장하지 않는다.

MOTIONGPT_CPU_THREADS는 1~16 범위로 CPU 스레드 수를 조정한다. 기본값은 최대 4개다. MOTIONGPT_INT8=1은 선택적으로 T5 선형 레이어의 동적 int8 추론을 켠다. 기본값은 float32이며 실제 모델 출력이 생성된 경우에만 결과를 반환한다.

## HTTP 계약

127.0.0.1:8765에만 바인딩한다. 요청의 연결 주소와 Host를 검증하고, 브라우저 Origin은 127.0.0.1:4173 및 localhost:4173만 허용한다. CORS를 열지 않으며 공개 Pages에서 이 포트에 직접 연결하는 구조가 아니다. 같은 컴퓨터의 Node 서버가 프록시로 호출한다.

- GET /health: ready, status, busy, missingAssets 등을 반환한다. 실제 가중치를 검증하고 VQ/T5 상태를 모두 strict 로드한 뒤에만 ready=true다.
- POST /caption: Content-Type application/json, 256KiB 이내. source=webcam, durationMs, samples 배열을 받는다.
- samples 항목: t(밀리초), segment(정수), worldJoints(허용된 몸 관절 이름별 [x,y,z]), 선택적인 breakBefore.
- body/frame/joint 이름, 유한 수치, 좌표 범위 -20~20m를 검증한다. 최대 512프레임이다. 얼굴 관절, 2D 궤적, 손 입력은 이 모델에 넣지 않는다.
- 실제 반환: caption, provider=MotionGPT, model, frames, elapsedMs, provenance.
- 오류: error.code 및 error.message. 모델 없음·해시 오류는 503, 잘못된 관측은 400, 다른 CPU 분석이 진행 중이면 429다.

동시에 한 기록만 분석한다. 영상, 음성, 사용자 의도 텍스트는 이 API로 받지 않는다.

## 3D 변환과 한계

MediaPipe가 추정한 hip-centred world 좌표에서 양 어깨·팔꿈치·손목·골반·무릎·발목·발끝 14개 관절이 모두 관측된 연속 구간만 사용한다. 누락 관절, segment 변경, 250ms 초과 공백을 넘어 연결하지 않는다. 1초 이상·8프레임 이상인 가장 긴 유효 구간을 20fps로 재표본화하며, 모델 입력은 최대 196개 관절 프레임이다.

MediaPipe 몸 관절 22개는 HumanML3D의 22개 관절과 서로 다르다. 골반 중심·척추 3개·목·머리·쇄골 2개는 관측된 몸 관절을 이용해 **추정한 관절**이며, 얼굴 좌표를 읽어 만든 것이 아니다. 응답의 inferredJoints로 이를 구분한다. 캡처에서 측정한 관절 길이의 중앙값으로 골격을 안정화하고, 바닥·초기 위치·초기 몸 방향을 정규화한다. 공식 HumanML3D feature extraction과 공식 mean/std로 263차원 입력을 만든다.

이 과정은 학습 데이터의 정밀 모션 캡처 골격과 동일하지 않은 근사 retarget이다. MediaPipe world 좌표는 골반 중심이므로 **전역 이동 거리와 실제 점프 높이를 복원하지 못한다**. rootTranslationAvailable=false와 설명을 응답에 포함한다. 자취·3D 관절·캡션을 비교해 오해석을 확인해야 하며, 실제 춤의 추적·캡션 정확도를 검증한 것으로 간주하지 않는다.

## 출처와 재현

- 공식 코드: https://github.com/OpenMotionLab/MotionGPT (MIT)
- 코드 고정 revision/파일별 SHA-256: upstream.json. 설치되는 최소 원본 파일은 vendor/에 두며 수정하지 않는다.
- 공식 체크포인트: https://huggingface.co/OpenMotionLab/MotionGPT-base
- T5: https://huggingface.co/google/flan-t5-base
- 정규화 값: 공식 MotionGPT Space의 assets/meta/mean.npy 및 std.npy
- 전체 고정 URL·모델 revision·바이트 수·SHA-256: model-artifacts.json

공식 모델카드의 가중치 라이선스 표시는 cc이며 Creative Commons 종류와 버전은 명시되지 않았다. 코드의 MIT 라이선스를 가중치에 그대로 적용한다고 주장하지 않는다. 체크포인트와 venv는 로컬 캐시로 보관하고 Git·ZIP 배포에 포함하지 않는다. 다른 라이브러리와 데이터의 라이선스는 별개다.

## 검증

    .venv-motion\Scripts\python.exe -m unittest motion_service.test_preprocessing

독립 테스트는 실제 공식 263차원 변환, 유효 구간 분리, 누락 관절 처리, 추정 관절 표시, 정규화 검증, 모델 준비 상태와 HTTP 경계를 검사한다. HTTP 전송 단위 테스트의 런타임은 명시적인 stub이며 실제 신경망 성공으로 보고하지 않는다. 실제 모델 로드·추론 결과는 별도 시험 기록으로 확인한다.


2026-10-30에 모델 로드 완료 후 이 컴퓨터의 CPU 4스레드/float32에서 실제 신경망 추론을 확인했다.

| 합성 입력 | 실제 MotionGPT 캡션 | 서버 처리 / HTTP 전체 |
| --- | --- | --- |
| 2초, 관측 41프레임 | a person raised hands and stopped | 1,187ms / 1,218ms |
| 10초, 관측 80프레임 → 모델 입력 196프레임 | a person stands still with their arms slightly outstretched. | 1,360ms / 1,406ms |

두 입력은 실제 춤 영상이 아닌 손목을 작게 움직인 합성 3D 관절 자료다. 모델은 두 번째의 작은 손 움직임보다 전신의 정적인 자세를 캡션으로 요약했다. 이 결과는 모델의 광범위한 동작 요약과 미세한 표현 감상 사이에 차이가 있음을 보여주는 제한된 시험이며, 춤 인식 정확도나 모든 상황의 응답 시간을 보장하지 않는다. 모델 다운로드·첫 메모리 로드·상위 한국어 LLM·유사도 계산 시간은 위 수치에 포함되지 않는다.

모델 캐시의 cpu-smoke-test.json 및 cpu-smoke-test-10s.json에 캡션·실측 시간·사용한 관절/정규화/가중치 해시를 기록했다. 다음 명령으로 재시험할 수 있다.

    .venv-motion\Scripts\python.exe -m motion_service.smoke_test
    .venv-motion\Scripts\python.exe -m motion_service.smoke_test --duration-ms 10000 --measured-frames 80
