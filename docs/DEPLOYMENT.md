# 하루영양 외부 배포

이 문서는 동일한 GitHub 저장소에서 **웹 서비스 1개 + 상시 알림 워커 1개**를 배포하는 절차입니다. SQLite는 웹 서비스의 영구 볼륨에만 저장합니다. 워커는 인증된 HTTP 요청으로 웹 서버의 알림 처리를 호출하므로 별도 DB나 공유 파일 시스템이 필요하지 않습니다.

**실제 공개 서비스:** [하루영양 열기](https://haru-nutri-production.up.railway.app) · [GitHub 저장소](https://github.com/june-young19/haru-nutri) · [성공한 CI](https://github.com/june-young19/haru-nutri/actions/runs/35424692457)

2026-09-19 Railway 웹 `haru-nutri`와 워커 `haru-reminders`의 ONLINE 상태, 클라우드 Docker 빌드·실행, `/app/data`의 500MB 영구 볼륨 연결을 확인했습니다. 공개 HTTPS에서 가입·등록·합산·복용 완료·삭제 이력·계정 분리·로그아웃 검증과 모바일 화면 점검을 완료했습니다. 웹을 실제 재시작한 후 기존 세션·프로필·제품·복용 이력이 유지되는 것도 확인했습니다. `resend` 모드 워커가 실제 자동 알림 1통을 발송했고 공급자 `Sent`·`Delivered`, Gmail 서버 수락, 다음 주기의 중복 발송 방지를 확인했습니다. **사용자 본인도 Gmail 전체 검색으로 해당 메일의 실제 수신을 확인했습니다.** 분류된 폴더는 확인하지 않았습니다. 상세 결과는 [검증 기록](VERIFICATION.md)에 있습니다.

아래 절차로 본인 환경에 새로 배포할 수 있습니다. `<실제 HTTPS 도메인>` 자리에는 해당 배포에서 생성한 주소를 넣습니다. 현재 운영 서비스의 주소는 `https://haru-nutri-production.up.railway.app`입니다. 현재 Resend 테스트 발신자는 계정 본인 이메일로만 전송할 수 있으며, 다른 사용자·보호자에게 실제 발송하려면 발신 도메인 검증이 필요합니다.

## 1. 배포 대상 선택

2026-09-19 공식 문서를 확인한 기준입니다. 결제 전 배포 계정의 최신 가격과 사용 한도를 다시 확인합니다. 금액은 USD이며 추가 트래픽, 빌드, 세금 등은 별도일 수 있습니다.

| 대상                 | 현재 구성에 필요한 조건                              | 비용과 제한                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Railway              | 웹과 워커를 별도 서비스로 만들고 웹에 영구 볼륨 연결 | Hobby 최소 월 $5이며 포함 사용량을 초과하면 실제 사용량에 따라 증가합니다. 월 $5 고정 상한이 아닙니다.                                                                                                             |
| Railway Trial / Free | 단기 배포 검증에 사용 가능                           | Trial은 최대 30일 또는 $5 소진까지입니다. 이후 Free의 월 $1 크레딧으로 바뀝니다. 두 상시 서비스의 지속 운영을 무료로 보장하지 않습니다. Limited Trial은 외부 네트워크가 제한되어 Resend 호출이 실패할 수 있습니다. |
| Render               | 유료 웹 + 유료 Background Worker + 영구 디스크       | 현재 최소 유료 컴퓨트는 서비스당 월 $7, 디스크는 GB당 월 $0.25입니다. 두 서비스와 1GB 디스크의 기본 합계는 월 $14.25입니다.                                                                                        |

이 프로젝트에는 Railway를 우선 권장합니다. 두 프로세스를 분리하고 SQLite를 유지하면서 작은 서비스의 사용량 기준으로 시작할 수 있기 때문입니다. 실제 사용료는 배포 후 측정해야 합니다. Railway의 볼륨 사용료는 GB당 월 $0.15이며 컴퓨트와 합산됩니다. [Railway 요금](https://docs.railway.com/pricing/plans), [Trial 제약](https://docs.railway.com/pricing/free-trial), [Render 요금](https://render.com/pricing)

Render Free 웹 서비스는 15분 동안 트래픽이 없으면 중지되고 영구 디스크를 연결할 수 없습니다. 무료 Background Worker도 제공하지 않으므로 현재 SQLite와 상시 워커 구성을 무료 서비스만으로 운영할 수 없습니다. [Render Free 제한](https://render.com/docs/free)

## 2. Railway 설정 파일 변경 사항

Railway는 기존 `railway.json` / `railway.toml` 방식인 Config as Code를 폐기하는 중입니다. 새 서비스는 이 방식을 선택할 수 없고, 기존 사용 서비스도 2026-12-01에 지원이 종료됩니다. 따라서 이 저장소에는 읽히지 않는 설정 파일을 배포 자동화처럼 추가하지 않았습니다. 아래 표를 **실제 Railway Dashboard의 서비스 설정에 입력**합니다. [공식 변경 안내](https://docs.railway.com/config-as-code)

새 Infrastructure as Code는 `.railway/railway.ts`와 별도 SDK/CLI로 프로젝트 전체를 관리합니다. 향후 필요하면 도입할 수 있지만 이번 구성에는 추가하지 않습니다. [Railway IaC](https://docs.railway.com/infrastructure-as-code)

## 3. GitHub 저장소 연결

1. 프로젝트 루트에 `package.json`, `pnpm-lock.yaml`, `Dockerfile`이 있는 GitHub 저장소를 준비합니다. `.env`, SQLite DB, 백업은 업로드하지 않습니다.
2. Railway에 GitHub로 로그인한 뒤 새 프로젝트를 생성합니다. GitHub 연결 권한은 해당 저장소에만 부여해도 됩니다.
3. 같은 저장소를 연결한 서비스 두 개를 만들고 구분하기 쉬운 이름을 지정합니다. 현재 배포는 `haru-nutri`, `haru-reminders`를 사용합니다.
4. 서비스 Root Directory는 이 프로젝트 루트로 지정합니다. 저장소 전체가 하루영양이면 `/`입니다. 상위 저장소의 하위 폴더에 넣었다면 `Dockerfile`이 있는 폴더를 지정합니다.
5. 빌더를 Dockerfile로 선택하고 파일 위치를 `Dockerfile`로 지정합니다. Dockerfile에서 의존성을 설치하고 Next.js standalone 결과물을 빌드합니다. 별도 Build Command와 Pre-deploy Command는 비워 둡니다.

## 4. 두 서비스의 실행 설정

| 설정                | 웹: `haru-nutri`                                 | 워커: `haru-reminders`                           |
| ------------------- | ------------------------------------------------ | ------------------------------------------------ |
| GitHub 소스         | 이 저장소 / 선택한 배포 브랜치                   | 동일한 저장소 / 동일한 브랜치                    |
| Builder             | Dockerfile                                       | Dockerfile                                       |
| Dockerfile          | `Dockerfile`                                     | `Dockerfile`                                     |
| Start Command       | `node server.js`                                 | `node scripts/reminder-worker.mjs`               |
| Replicas            | **1**                                            | **1**                                            |
| Serverless / Sleep  | 끔                                               | 끔                                               |
| Healthcheck Path    | `/api/health`                                    | 비워 둠: HTTP 서버가 아님                        |
| Healthcheck Timeout | 300초                                            | 해당 없음                                        |
| Restart Policy      | Trial: On Failure / 10회, 유료 상시 운영: Always | Trial: On Failure / 10회, 유료 상시 운영: Always |
| Public Networking   | 도메인 생성, Target Port 3000                    | 공개 도메인 불필요                               |
| Volume              | Mount Path `/app/data`                           | 없음                                             |

Railway의 Free/Trial은 Always 재시작을 선택할 수 없고 On Failure를 최대 10회까지만 설정할 수 있습니다. 유료 플랜에서는 Always를 사용할 수 있습니다. 설정 오류가 반복되면 재시작 횟수만 늘리지 말고 원인을 수정합니다. [재시작 정책](https://docs.railway.com/deployments/restart-policy)

`/api/health`는 SQLite 연결까지 확인합니다. Railway의 이 검사는 배포 시작 시 준비 상태를 확인하는 용도이며 지속적인 장애 감시 기능은 아닙니다. 볼륨을 연결한 서비스는 재배포 중 짧은 중단이 발생할 수 있습니다. [Healthcheck 동작](https://docs.railway.com/deployments/healthchecks)

웹 이미지의 Docker CMD는 standalone 출력 안의 `server.js`입니다. 로컬용 `scripts/start.mjs`로 실행 명령을 바꾸지 않습니다. 워커도 같은 이미지의 복사된 `scripts/reminder-worker.mjs`만 실행합니다.

## 5. 영구 볼륨과 환경변수

**처음 회원가입하기 전에** 웹 서비스에 볼륨을 연결하고 Mount Path를 `/app/data`로 설정합니다. 컨테이너의 일반 파일 시스템은 DB 저장 장소로 사용하지 않습니다. 볼륨을 삭제하거나 연결을 바꾸면 다른 DB가 보이거나 데이터가 사라질 수 있습니다.

Railway 볼륨은 root 소유로 마운트됩니다. 현재 Dockerfile은 기본적으로 `node` 사용자이므로 **웹 서비스에만 `RAILWAY_RUN_UID=0`**을 설정합니다. 이것은 Railway가 문서화한 non-root 이미지의 볼륨 권한 처리 방법입니다. 볼륨은 실행 시점에 연결되므로 DB 초기화/마이그레이션을 Build 또는 Pre-deploy Command에서 실행하지 않습니다. 앱이 처음 DB를 열 때 스키마를 준비합니다. [볼륨과 권한](https://docs.railway.com/volumes)

### 웹 서비스 Variables

| 변수              | 값                                                                        |
| ----------------- | ------------------------------------------------------------------------- |
| `NODE_ENV`        | `production`                                                              |
| `HOSTNAME`        | `0.0.0.0`                                                                 |
| `PORT`            | `3000`                                                                    |
| `DATABASE_PATH`   | `/app/data/haru.db`                                                       |
| `RAILWAY_RUN_UID` | `0`                                                                       |
| `APP_URL`         | Railway에서 발급한 `<실제 HTTPS 도메인>`; 경로와 쿼리 없이 입력           |
| `CRON_SECRET`     | 새로 생성한 길고 무작위인 값, 최소 24자, 권장 32바이트 이상의 무작위 토큰 |
| `EMAIL_MODE`      | 첫 배포는 `capture`; 실제 전송을 설정한 뒤 `resend`                       |
| `RESEND_API_KEY`  | Resend에서 발급한 실제 키; Variables 비밀값으로 입력                      |
| `EMAIL_FROM`      | Resend에서 발송할 수 있는 발신 주소                                       |

로컬 컴퓨터에 있는 `.env`를 GitHub에 올리지 않습니다. 운영용 값을 Railway에 직접 설정합니다. `CRON_SECRET`과 Resend 키는 `NEXT_PUBLIC_` 변수로 만들지 않습니다.

### 워커 서비스 Variables

| 변수          | 값                                       |
| ------------- | ---------------------------------------- |
| `NODE_ENV`    | `production`                             |
| `APP_URL`     | 웹 서비스와 동일한 `<실제 HTTPS 도메인>` |
| `CRON_SECRET` | 웹 서비스와 정확히 같은 값               |

처음에는 워커가 공개 HTTPS 웹 주소로 호출하도록 설정하면 별도 사설 DNS나 포트 설정이 필요하지 않습니다. `APP_URL` 뒤에 `/api/cron/notifications`를 붙이지 않습니다. 워커가 경로를 붙이며, URL에 사용자명·비밀번호·쿼리·프래그먼트를 넣으면 시작을 거부합니다. 운영 환경에서는 `APP_URL`이 없을 때 localhost로 조용히 연결하지 않습니다.

워커에는 `RESEND_API_KEY`, `EMAIL_FROM`, 영구 볼륨이 필요하지 않습니다. 모든 DB 판정과 이메일 발송은 웹 서비스에서 처리합니다. Railway의 변수 참조 기능으로 `CRON_SECRET`을 공유하는 경우에도 로그나 공개 문서에 실제 값을 출력하지 않습니다.

## 6. 배포와 자동 알림 확인

1. 웹 서비스를 먼저 배포합니다. 생성된 HTTPS 도메인에서 `/api/health`가 HTTP 200인지 확인합니다.
2. 도메인을 웹과 워커의 `APP_URL`에 설정하고 변경사항을 배포합니다. 이메일 속 링크도 이 주소를 사용합니다.
3. 브라우저에서 회원가입 → 영양제 등록 전 검사 → 저장 → 오늘의 복용 체크를 수행합니다.
4. 웹 서비스를 재시작하고 다시 로그인하여 등록한 제품·복용 기록이 남는지 확인합니다. 남지 않으면 `DATABASE_PATH`와 볼륨 연결부터 수정합니다.
5. 워커를 배포합니다. 워커는 시작 직후 한 번 실행한 뒤 각 요청이 끝난 시점에서 60초 후 다시 검사합니다. 로그에는 `checked`, `sent`, `captured`, `failed`, `skipped` 숫자만 표시합니다.
6. 테스트 계정의 본인 알림을 켜고 복용 시간과 지연 시간을 설정합니다. 그 시간이 지나도록 완료를 체크하지 않은 경우 `capture` 모드에서는 알림함에 로컬 기록이 생기는지 확인합니다. 이 단계는 실제 메일 전송이 아닙니다.
7. Resend의 발신 주소와 수신 가능 조건을 설정한 뒤 실제 전송을 할 때만 `EMAIL_MODE=resend`로 변경하고 웹을 재배포합니다. 새 알림 대상 일정으로 검사하고 서비스의 전송 상태, Resend 결과, 실제 수신함을 각각 확인합니다.
8. 사용자 알림을 받은 뒤에도 미확인이 유지되고 보호자 알림 동의가 저장된 경우에만 보호자 단계가 작동하는지 테스트 계정으로 확인합니다.

Resend 초기 테스트 발신 도메인은 발송 대상이 제한됩니다. 다른 참가자나 보호자에게 전송하려면 발신 도메인을 검증하고 필요한 DNS 레코드를 등록합니다. [Resend 테스트 도메인 제한](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain), [도메인 설정](https://resend.com/docs/dashboard/domains/introduction)

이미 `capture`된 동일 일정은 실제 전송으로 다시 처리되지 않습니다. 전송 검증은 새 테스트 일정으로 수행합니다. 본인 알림을 끄거나 제품을 삭제하면 다음 검사에서 알림 대상에서 제외됩니다. 보호자 알림은 동의와 본인 알림 처리 상태를 서버가 다시 확인합니다.

## 7. 워커의 재시도와 종료

- 한 프로세스 안에서는 이전 요청이 끝난 후 다음 요청을 예약하여 스캔이 겹치지 않습니다.
- HTTP 오류, 네트워크 오류, 잘못된 응답은 다음 주기에 재시도합니다. 요청은 최대 55초 후 중단합니다.
- `SIGTERM` 또는 `SIGINT`를 받으면 다음 실행 예약을 해제하고 진행 중 HTTP 요청도 취소합니다. 플랫폼은 새 배포나 재시작 정책에 따라 다음 프로세스를 실행합니다.
- 재배포 중 두 워커가 잠시 겹치거나, 응답을 받기 전에 연결이 끊겨도 서버의 SQLite 알림 claim과 제공자 멱등성 키가 중복 발송을 방지하도록 설계되어 있습니다. 워커 자체만으로 분산 환경의 무조건적인 정확히 한 번 전송을 보장하는 것은 아닙니다.
- 요청 URL, 토큰, 응답 본문, 수신자, 이메일 내용, 상세 오류 문자열은 워커 로그에 출력하지 않습니다. `HTTP 401` 등의 상태와 집계만 출력합니다.

`tests/worker.test.ts`에서 설정 검증, 비밀값 비출력, 느린 요청의 비중첩, 재시도, 타임아웃, 종료 시 취소를 검사합니다. 기존 서버 테스트가 알림 중복 claim과 동의 조건을 별도로 검사합니다.

## 8. 백업과 업데이트

운영 DB에는 개인 정보가 있으므로 소스와 분리하여 접근을 제한합니다. 기존 로컬 계정과 DB가 클라우드로 자동 복사되는 기능은 없습니다. 운영 첫 시작은 새 DB이며, 데이터 이전이 필요하면 사용자 승인과 백업을 거쳐 별도 수행합니다.

SQLite는 WAL 파일을 함께 사용합니다. **실행 중 `haru.db` 한 파일만 복사하여 백업하지 않습니다.** SQLite에 맞는 일관된 백업을 만들거나 웹과 워커를 중지한 상태에서 DB 디렉터리 전체를 보존한 뒤 복원합니다. 호스팅 제공자의 볼륨 백업도 별도로 설정하고 실제 복구 가능 여부를 확인합니다. Railway는 볼륨 수동/자동 백업을 지원합니다. [Railway 볼륨 백업](https://docs.railway.com/volumes/backups)

코드를 업데이트할 때 같은 볼륨과 `DATABASE_PATH`를 유지합니다. 스키마 마이그레이션이 있는 버전은 사전 백업 후 이전 웹 프로세스를 종료하고 새 버전을 실행합니다. 이전 버전으로 소스만 되돌리면 새 DB 스키마와 호환되지 않을 수 있습니다. 복원 시험은 운영 데이터와 분리한 서비스에서 먼저 수행합니다.

## 9. 문제 해결

| 증상                                 | 확인할 항목                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| 웹 Healthcheck 실패                  | 빌드 로그, `PORT=3000`, `HOSTNAME=0.0.0.0`, `/api/health`, 볼륨 경로와 쓰기 권한 |
| SQLite permission / readonly 오류    | 웹 볼륨 `/app/data`, `DATABASE_PATH=/app/data/haru.db`, `RAILWAY_RUN_UID=0`      |
| 재배포 후 계정이 없어 보임           | 연결한 볼륨·환경·DB 경로가 이전과 동일한지 확인; 새 DB 생성으로 해결하지 않기    |
| 워커가 바로 종료됨                   | 운영 `APP_URL`의 형식과 `CRON_SECRET` 길이; 로그에 실제 값을 출력하지 않기       |
| 워커 `HTTP 401`                      | 웹/워커 `CRON_SECRET` 일치 여부와 변수 변경 후 재배포 여부                       |
| 워커 `HTTP 503`                      | 웹의 필수 설정·DB·로그 확인; 인증/메일 설정 오류를 수정                          |
| 워커 Request failed / timed out      | 공개 HTTPS 주소, 리다이렉트 없는 최종 도메인, 웹 상태, Trial 외부 네트워크 제한  |
| 워커는 실행되지만 `sent=0`           | `EMAIL_MODE`, 사용자 알림 동의, 미완료 여부, 지연 시간, 기존 처리 기록 확인      |
| Resend는 accepted인데 메일이 안 보임 | 제공자 Delivered/Failed 이벤트와 실제 수신함·스팸함을 별도로 확인                |
| 재시작을 반복하다 멈춤               | Trial On Failure 10회 한도 및 최초 설정 오류 확인                                |

## 10. Render로 배포할 경우

Render에서는 동일 Dockerfile의 **유료 Web Service**와 **유료 Background Worker**를 생성합니다. 웹 시작 명령은 `node server.js`, 워커 Docker Command는 `node scripts/reminder-worker.mjs`입니다. 웹에 `/app/data` 디스크를 연결하고 나머지 앱 변수·Healthcheck는 위 표를 사용합니다. `RAILWAY_RUN_UID`는 Railway 전용이므로 Render에 복사하지 않습니다. Render에서 마운트 후 실제 컨테이너 사용자의 쓰기 권한을 확인해야 합니다.

각 서비스는 한 인스턴스를 유지합니다. Render의 디스크는 단일 인스턴스에만 연결되며, 다른 서비스·빌드·Pre-deploy에서 접근할 수 없습니다. 워커가 디스크를 공유하도록 설정하지 않습니다. [Render 디스크 제약](https://render.com/docs/disks), [Background Workers](https://render.com/docs/background-workers), [Docker Command](https://render.com/docs/deploys)

현재 코드는 SQLite를 사용하므로 Vercel 등의 일반 서버리스 배포 또는 여러 웹 복제본으로 확장하는 구성이 아닙니다. 그런 운영이 필요하면 PostgreSQL과 별도 작업 큐로 저장 계층을 먼저 변경해야 합니다.
