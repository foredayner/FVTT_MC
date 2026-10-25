# Blockworld Bridge

Foundry VTT(V14)와 Minecraft: Java Edition 서버를 잇는 모듈 + 중계 프로그램.

- **탑뷰 조작**: Foundry 씬이 마크 지도 아이템처럼 칠해진 지도가 되고, 클릭하면 캐릭터가 그 방향으로 곧장 걷거나, 캐거나, 공격합니다.
- **시야**: 플레이어는 자기 캐릭터 주변(기본 16블록)만 보이고, 안 가본 곳은 회색 안개입니다.
- **실내 평면도**: 지붕 아래 들어간 캐릭터 주변은 지붕을 걷어내고 바닥(밝게)·벽(어둡게)·문·창문으로 그립니다. 벽은 Foundry 벽으로 만들어져 시야를 막습니다. GM은 층 높이를 직접 지정할 수도 있습니다.
- **3D 시점**: Foundry 안의 창에서 1인칭으로 보고 WASD·마우스로 조작합니다. 플레이어 브라우저가 직접 그리고, 데이터는 Foundry 연결로 받으므로 따로 열어야 할 포트가 없습니다.
- **GM 연출**: 낮/밤, 날씨, 화면 중앙 나레이션, 상태효과, 몹 소환.
- **디스플레이 블록 오브젝트**: `block_display` 엔티티로 만든 물체(예: AI 건축 모드의 소품)가 3D 시점에는 실제 블록 모양·텍스처로, 지도에는 그 블록 색으로 나옵니다. 모드 없는 서버에서도 보입니다(모드 전용 엔티티는 빠짐).

> Not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
> 이 모듈은 마인크래프트 게임 파일·텍스처를 포함하지 않습니다. **각 플레이어는 Minecraft: Java Edition을 보유해야 합니다.**

## 구조

```
[Minecraft 서버] ⇄ [relay (Node.js, GM PC)] ⇄ WebSocket ⇄ [GM의 Foundry 탭] ⇄ Foundry 소켓 ⇄ [플레이어들]
                       └ Mineflayer 봇 (플레이어 1명 = 봇 1개)
```

플레이어에게 필요한 것은 브라우저뿐입니다. 지도, 토큰, 3D 화면 데이터 모두 Foundry 연결로 갑니다.

- `relay/` — 마크 서버에 봇으로 접속해 상태·지도·3D 청크를 보내고, Foundry에서 온 조작을 실행합니다.
- `module/` — Foundry 모듈. 설치 폴더는 `Data/modules/blockworld-bridge`.
- `tools/build3d/` — `module/vendor/`의 3D 렌더러를 빌드하는 도구(개발자용).

## 빠른 시작 (로컬 테스트)

요구: Node.js 20 이상, Foundry VTT V14.

```bash
git clone https://github.com/foredayner/FVTT_MC
cd FVTT_MC/relay
npm install
cp config.example.json config.json   # token 을 16자 이상 임의 문자열로 바꾸기
npm run test:server                   # 1) 테스트용 마크 서버 (1.21.4, 오프라인, 클래식 평면)
npm start                             # 2) 다른 터미널에서 relay 실행
```

테스트 서버는 기본이 **클래식 평면**(기반암 y=-64, 흙 2칸, 잔디 y=-61)입니다. 언덕 지형으로 시험하려면 `node test/dev-server.js --hills`.

Foundry에서:
1. `module/` 폴더를 `Data/modules/blockworld-bridge` 로 복사하고 월드에서 활성화
2. 모듈 설정(GM 브라우저): 중계 서버 주소 `ws://127.0.0.1:8765`, 토큰 = config.json 의 token. **자동 연결**을 켜두면 편합니다.
3. 토큰 컨트롤의 🧊 버튼(또는 Shift+M)으로 패널 → **중계 서버 연결**
   - 처음 연결할 때 GM 브라우저가 3D 화면용 블록 텍스처·모델을 relay에서 받아 Foundry 데이터 폴더(`bwb-assets/`)에 한 번 올립니다.
4. 마크 이름을 넣고 **접속** → 캐릭터가 서버에 들어옵니다
5. GM: 빈 씬을 열고 **이 씬을 지도로** → 기준 캐릭터 주변 128×128 블록이 지도가 되고, 시야·안개가 켜집니다
   - 또는 **좌측 하단** X·Z를 넣고 **좌표로 지도** → 그 블록이 지도의 왼쪽 아래(서남쪽) 모서리가 됩니다
6. **지도 조작**을 켜고(Shift+N) 클릭 = 직선 이동, Shift+클릭 = 채굴, Alt+클릭 = 공격
7. **3D 시점** → 창을 클릭해 마우스를 잡고 WASD로 조작, 스페이스 점프, Esc로 해제
8. **3D 모습**(패널) → 다른 사람 3D 화면에 보일 내 상자 색, 정면 일러스트, 크기·위치
9. GM: 지도 씬 칸의 **단면** → 자동(실내만) / 높이 지정(층) / 끄기, 벽 자동 생성 켜기·끄기 → **적용**
10. GM: **이동·스폰** 칸 → X·Y·Z를 넣거나 기준 캐릭터의 **현재 위치**로 채운 뒤
    - **이동**: 고른 대상(한 명 또는 모두)을 그 블록으로 순간이동
    - **리스폰 지점**: 대상이 죽으면 살아날 곳
    - **월드 스폰으로**: 처음 접속하는 캐릭터가 나타날 곳 (`spawnRadius 0`도 함께 설정해 정확히 그 블록에 나타남). 이미 접속했던 캐릭터는 마지막 위치로 들어오므로 **이동**을 쓰세요

## 런처 앱 (서버 · 맵 · relay · 모듈 설치를 한 창에서)

`launcher/`는 Foundry를 켜기 전까지의 준비를 탭 순서대로 진행하는 Electron 앱입니다. 오른쪽 상태판에 항목마다 초록불/빨간불이 켜지고, 빨간 항목을 누르면 해결할 탭으로 갑니다. GM PC에 Node.js를 따로 설치할 필요가 없습니다(앱 안에 들어 있음).

| 탭 | 하는 일 |
|---|---|
| 1. 서버 | Java 21 확인(없으면 앱 폴더에 자동 설치), Paper/Vanilla 선택, EULA 동의(사용자가 직접 체크), 공식 주소에서 서버 받기(체크섬 확인) |
| 2. 맵 | 월드 폴더나 zip 가져오기(끌어다 놓기 가능, 원본은 복사만), 새 평면/일반 맵, 사용할 맵 고르기(1.21.4보다 새 맵은 경고) |
| 3. 설정 | 오프라인/정품 인증, 성능 프리셋(가벼움/보통/넓게), 메모리, 포트 → **설정 적용**으로 server.properties 와 relay 설정을 같은 토큰·RCON 비밀번호로 씀 |
| 4. 모듈 설치 | Foundry 데이터 폴더 지정 → 앱 안의 모듈을 설치/업데이트 (월드·`bwb-assets`는 그대로) |
| 5. 실행 | 서버 → relay 순서로 시작, relay → `stop`(맵 저장) 순서로 정지, Foundry에 넣을 주소·토큰 복사, 서버/relay 로그와 서버 콘솔 |

앱 자료는 `%appdata%\Blockworld Bridge\`(서버, 맵, Java, 설정)에 모입니다. 서버는 127.0.0.1 에서만 열립니다.

```bash
cd launcher
npm install
npm start          # 개발 실행
npm test           # 로직 테스트
npm run dist       # Windows 설치 파일(nsis)과 zip 을 dist/ 에 만듦 — Windows 에서 실행
```

코드 서명을 하지 않았으므로 처음 실행할 때 Windows 가 "알 수 없는 게시자" 경고를 띄웁니다(**추가 정보 → 실행**).

## 실제 서버로 쓰기

vanilla 또는 Paper **1.21.4** 서버에서 `minecraft.host/port` 를 relay 설정에 넣으세요.

- **클래식 평면 월드**: 새 월드를 만들기 전에 `server.properties`에 `level-type=minecraft\:flat` (설정을 바꾸지 않으면 기본 프리셋이 클래식 평면입니다).
- **GM 명령**: `server.properties`에서 `enable-rcon=true`, `rcon.password=...` 를 정하고 relay 설정의 `rcon` 을 채우세요. RCON 이 없으면 명령은 봇 채팅으로 보내지고 그 봇에 OP 가 필요합니다.
- **정품 인증**: `online-mode=true` 서버는 relay 설정 `minecraft.auth` 를 `"microsoft"` 로 바꾸고, 각 캐릭터 첫 접속 때 터미널에 나오는 코드로 그 캐릭터 주인이 로그인합니다.
- **정품 인증을 끈 서버**는 `server-ip=127.0.0.1` 로 relay 만 붙을 수 있게 하고 25565 포트를 밖에 열지 마세요.

## relay 설정 (config.json)

| 키 | 기본값 | 뜻 |
| --- | --- | --- |
| `viewer.enabled` / `viewer.radius` | true / 2 | 3D 화면 사용, 캐릭터 주변 몇 청크를 보낼지 (2 = 5×5) |
| `map.refreshMs` / `map.refreshRadius` | 2000 / 24 | 지도 주기 동기화 간격과 반경(블록) |
| `map.indoorRadius` | 12 | 자동 단면: 실내 캐릭터 주변 몇 블록까지 지붕을 걷어낼지 |
| `stateHz` | 10 | 위치 갱신 횟수(초당). 3D 카메라가 이 값으로 부드럽게 따라갑니다 |
| `displays.radius` / `displays.maxParts` | 48 / 6000 | 캐릭터 주변 몇 블록의 디스플레이 블록을 보낼지, 최대 몇 개까지 |

## 버전

| 구성요소 | 기준 |
|---|---|
| Minecraft 서버 | **1.21.4** (3D 텍스처 지원 상한) |
| Mineflayer | 4.39 |
| Foundry VTT | V14 |

## 테스트

```bash
npm test                               # relay 단위 + 모듈 로직·권한·3D 전달 테스트
npm run test:e2e                       # 로컬 서버로 봇 접속·지도·3D 청크·조작·명령 종단 테스트
cd tools/build3d && npm install && node render-check.js   # 헤드리스 크로미움으로 3D 렌더 확인 (스크린샷 저장)
```

디스플레이 블록은 저장된 월드로도 시험할 수 있습니다(마크 서버 없이, 실제 패킷 경로로):

```bash
cd relay && node test/display-from-world.js <월드폴더> [태그] parts.json   # 월드의 block_display 를 봇에게 보내고 relay 결과 검증
cd tools/build3d && node render-check.js --displays parts.json            # 그 부품들을 3D 로 그려 스크린샷
```

Foundry 안에서의 동작(패널, 타일 텍스처, 3D 창, 자료 업로드)은 실제 V14 월드에서 확인합니다.

## 3D 렌더러 다시 빌드하기

```bash
cd tools/build3d && npm install && node build.js
```

`module/vendor/bwb3d.js`(three.js 장면)와 `bwb3d-worker.js`(블록 메싱, 1.21.4 데이터만)를 만듭니다. prismarine-viewer의 메싱 코드가 높이 0 아래를 그리지 않는 부분은 빌드할 때 월드 최저 높이 기준으로 고쳐 넣습니다.

## 라이선스

MIT. 번들된 서드파티 코드는 `module/vendor/LICENSES.md` 참고.

## 릴리스 만들기

`module/module.json` 의 `version` 을 올리고 `main` 에 push 하면, 그 버전의 릴리스가 아직 없을 때 GitHub Actions 가 `v<버전>` 태그와 릴리스를 만듭니다. Actions 탭에서 손으로 실행할 수도 있습니다.

릴리스에는 `module.json`·`module.zip`(Foundry manifest 설치/업데이트용)과 Windows 런처 설치 파일·zip 이 붙습니다. 릴리스 설명은 `.github/release-notes/v<버전>.md` 가 있으면 그것을, 없으면 커밋 목록을 씁니다.
