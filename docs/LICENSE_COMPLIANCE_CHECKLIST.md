# 릴리스 라이선스 준수 체크리스트

배포 담당자가 태그·Release 생성 전에 확인합니다. (법률 자문 아님)

## A. 저장소·메타데이터

- [ ] 루트 `LICENSE`가 MIT이고 저작권 연도가 유효하다
- [ ] `package.json`, `src-tauri/Cargo.toml`, `web/companion/package.json`에 `"license": "MIT"` / `license = "MIT"`
- [ ] GitHub 저장소 페이지에 MIT가 표시된다 (`licenseInfo`)
- [ ] `THIRD_PARTY_NOTICES.md`, `docs/MODEL_LICENSING.md`, `CONTRIBUTING.md`가 main에 있다

## B. 설치 패키지 내용물

- [ ] `*_setup.exe` / `.dmg`에 `ffmpeg.exe`, `yt-dlp.exe`, `*.onnx` 모델이 **번들되지 않음**
- [ ] `src-tauri/resources/libs/` ONNX Runtime EP DLL을 포함할 경우 MIT 고지(`THIRD_PARTY_NOTICES`) 유지
- [ ] 번들 시 GPL 도구를 넣는다면: 해당 구성요소 라이선스·소스 제공 의무를 별도 검토·이행

## C. 런타임 다운로드

- [ ] FFmpeg URL이 BtbN의 고정 태그 LGPL 자산이며 코드·문서의 SHA-256이 일치한다
- [ ] yt-dlp Windows exe 경로·GPLv3+ 고지가 `THIRD_PARTY_NOTICES.md`와 일치한다
- [ ] FFmpeg·yt-dlp를 프로젝트 GitHub Release·운영 서버에 재호스팅하지 않는다
- [ ] FFmpeg·yt-dlp는 별도 프로세스로만 호출하며 `libav*` 등을 앱에 링크하지 않는다
- [ ] 설정 > 법적 고지의 외부 도구 설명·원 배포처 소스 링크가 동작한다
- [ ] 기본 MR 모델 URL·UVR 크레딧·잠정 MIT 표기가 UI/문서와 일치한다

## D. 신규 AI 모델 / 외부 PR

- [ ] `docs/MODEL_LICENSING.md` §1 체크리스트 통과
- [ ] Apache-2.0 변환본: LICENSE/NOTICE·원본 링크·용량 고지
- [ ] CC-BY-NC 등 비상업 모델: 공식 기본·추천·프로젝트 Release **제외**

## E. Companion·약관

- [ ] `/terms` 시행일과 MIT 비축소 조항이 배포 환경에 반영됨
- [ ] 앱 설정 > 법적 고지 링크(개인정보·약관·MIT·제3자 고지)가 동작한다

## F. 릴리스 노트

- [ ] 사용자용 노트에 라이선스/고지 변경이 있으면 한 줄이라도 안내
- [ ] Discord 공지와 README 라이선스 절이 모순되지 않음
