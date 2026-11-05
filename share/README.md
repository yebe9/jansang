# 잔상 · 24시간 이미지 공유 Worker

결과 화면의 **폰으로 받기**를 직접 누르면 잔상 PNG 한 장을 올리고, 24시간 동안 열리는 개인별 QR 링크를 만든다. 카메라 준비·기록 종료·AI 해석만으로 이미지를 업로드하지 않는다. QR 링크를 가진 사람은 로그인 없이 이미지를 저장하고, 지원되는 휴대전화에서는 기기의 공유 메뉴로 전달할 수 있다.

공유 대상은 브라우저가 만든 **1080 × 1350 PNG 한 장, 최대 1MiB(1,048,576바이트)**다. 원본 카메라 영상·음성·내 의도·AI 해석·유사도·비공개 기록은 요청에 넣지 않는다. 기존 비공개 기록함 Worker·D1·KV와 연결하지 않으며, 이 Worker는 새 D1 **ghosting-image-shares**의 **SHARE_DB** 바인딩만 사용한다.

## 만료와 저장 범위

서버 수신 시각을 기준으로 24시간 뒤 접근을 만료시킨다. 페이지와 PNG는 만료 시각과 같은 순간부터 410을 반환하며, 삭제 작업이 아직 실행되지 않아도 접근할 수 없다. 매시간 정각 cron과 다음 업로드가 만료 행을 물리 삭제한다. 따라서 만료 후 삭제까지 최대 약 한 시간의 간격이 있을 수 있으며, 플랫폼의 백업 보존 정책까지 즉시 삭제한다는 뜻은 아니다.

토큰은 암호학적으로 무작위인 32바이트를 64자리 소문자 16진수로 만든다. DB에는 토큰의 SHA-256 해시·생성/만료 시각·이미지 바이트 수·PNG BLOB만 둔다. 원본 토큰은 보관하지 않고 Worker 로그 수집과 invocation 로그도 비활성화한다. 링크 소지자가 저장한 파일은 서버의 접근 만료와 별개로 기기에 남는다.

## API 계약

| 요청 | 응답 |
| --- | --- |
| POST /api/shares | PNG를 저장하고 201 JSON {url, expiresAt} 반환 |
| OPTIONS /api/shares | 허용 출처의 업로드 CORS 사전 요청에 204 |
| GET /s/:token | 모바일용 어두운 이미지 보기 페이지 |
| GET /s/:token/image.png | image/png 원본 바이트 |
| GET /s/:token/image.png?download=1 | attachment 파일 ghosting.png |
| HEAD /s/:token 또는 이미지 경로 | 본문 없이 접근 가능 여부 확인 |
| GET /share.js | 기기 공유·만료 시각 표시용 고정 스크립트 |

업로드는 multipart나 JSON이 아닌 `Content-Type: image/png` 본문 자체다. 브라우저 자격증명은 필요하지 않다. 허용 Origin은 `https://yebe9.github.io`, `http://127.0.0.1:4173`, `http://localhost:4173`이며 누락되거나 다른 값이면 403이다. CORS는 사용자 인증 수단이 아니므로 빈도와 저장 한도도 함께 적용한다.

성공 응답 예시:

```json
{
  "url": "https://ghosting-image-share.jansang.workers.dev/s/64자리소문자16진수토큰",
  "expiresAt": "2026-11-06T09:00:00.000Z"
}
```

`expiresAt`은 UTC ISO 8601 문자열이다. 실제 URL에는 64자리 소문자 16진수 토큰이 들어가며 query/hash가 없다. 24시간은 이 반환된 시각으로 판정한다.

| 상태 | 의미 |
| --- | --- |
| 400 | PNG 서명·CRC·청크·고정 크기 또는 링크 query가 올바르지 않음 |
| 403 | 허용하지 않은 업로드 Origin |
| 405 | 경로에 맞지 않는 HTTP 메서드 |
| 410 | 만료되었거나 올바른 형태이지만 존재하지 않는 공유 링크 |
| 413 | PNG가 1MiB를 초과함 |
| 415 | image/png가 아닌 업로드 |
| 429 | 업로드 빈도 초과, Retry-After: 60 |
| 503 | 저장소/제한 바인딩 미설정, 전체 용량 도달 또는 서비스 일시 오류 |

모든 응답에는 no-store·no-referrer·nosniff·noindex를 적용한다. 페이지는 외부 리소스 없이 로드하며 iframe 표시를 차단한다. PNG 외 영상·APNG·HTML·트레일링 데이터는 받지 않는다. 만료된 이미지를 브라우저 캐시로 계속 제공하지 않는다.

## 운영 한도

- PNG 1장 1MiB 이하, 1080 × 1350, 8비트 RGB/RGBA.
- DB 전체 200장·100MiB 이하. 개수/바이트 검사와 INSERT는 하나의 SQLite 문장으로 실행해 동시 업로드에서도 한도를 넘기지 않는다.
- 업로드는 IP별 분당 6회, Worker 제한 키별 분당 30회. Cloudflare rate-limit 바인딩은 위치별 제한이며 전 세계의 정확한 단일 카운터는 아니다.
- SHARE_LIMITER 또는 TOTAL_SHARE_LIMITER가 없으면 업로드를 허용하지 않는다. 플랫폼의 무료 할당량은 이 앱의 한도와 별도로 적용된다.

D1의 [행·문자열·BLOB 최대 크기](https://developers.cloudflare.com/d1/platform/limits/)와 [ArrayBuffer 바인딩](https://developers.cloudflare.com/d1/worker-api/)을 확인해 별도 R2 없이 PNG를 BLOB으로 저장한다. 현재 설정의 1MiB 상한은 D1 행 제한인 2,000,000바이트보다 작다. 이 구성이 서비스의 영구 무료 제공을 보장하지는 않는다.

## 새 배포

프로젝트 루트 PowerShell에서 실행한다. 기존 로그 저장소를 지정하거나 기존 DB에 이 스키마를 적용하지 않는다. 별도 계정에 설치하는 경우 Cloudflare 로그인·권한이 먼저 필요하다.

```powershell
Set-Location -LiteralPath 'C:\Projects_AI\Codex\라운지서울_잔상'
npx wrangler login
npx wrangler d1 create ghosting-image-shares --config share/wrangler.toml
```

현재 계정의 배포와 DB 연결은 완료되어 있다. 다른 계정에 새로 설치할 때는 생성 결과의 database_id로 `share/wrangler.toml`의 기존 database_id를 교체한다. 다음 명령은 해당 이미지 공유 전용 DB에만 실행한다.

```powershell
npx wrangler d1 execute ghosting-image-shares --config share/wrangler.toml --remote --file share/schema.sql
npx wrangler deploy --config share/wrangler.toml
```

Worker 이름은 `ghosting-image-share`다. 현재 계정에 배포한 주소는 `https://ghosting-image-share.jansang.workers.dev`이며, 실제 배포 출력 주소와 프런트엔드의 공유 API 주소를 맞춘다. API 키·소유자 비밀번호·영상 저장소 바인딩은 이 Worker에 필요하지 않다.

## 검증

```powershell
node --check share/worker.mjs
node --test tests/share-worker.test.cjs
```

테스트는 진짜 PNG와 메모리 SQLite로 정확한 만료 경계·삭제 후 접근 차단·다중 동시 업로드 용량·허용 출처·파일 검증·모바일 공유 클릭 활성화를 확인한다. 실제 배포 뒤에는 브라우저에서 폰으로 받기 → QR → 휴대전화 이미지 저장을 별도로 확인한다.