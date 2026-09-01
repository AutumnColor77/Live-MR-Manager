# Contributing

Live MR Manager에 기여해 주셔서 감사합니다.

## 라이선스

이 저장소의 프로젝트 코드는 [MIT License](LICENSE)입니다.

Pull Request 또는 패치를 제출하면, 해당 기여물을 **MIT License** 조건으로 라이선스하는 데 동의하는 것으로 봅니다. 기여물에 대해 필요한 권리를 보유하고 있어야 하며, 제3자 코드를 포함하는 경우 출처와 라이선스를 PR 설명에 명시해 주세요.

## AI 모델·바이너리

모델 가중치, FFmpeg, yt-dlp 등 제3자 바이너리를 추가·변경할 때는 [`docs/MODEL_LICENSING.md`](docs/MODEL_LICENSING.md)와 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)를 따르세요.

특히:

- 상업 이용이 금지된 모델(CC-BY-NC 등)은 공식 기본값·추천 목록·프로젝트 Release에 넣지 않습니다.
- Apache-2.0 등 허용 모델을 변환·재배포할 때는 NOTICE/원본 고지를 함께 제공합니다.
- FFmpeg·yt-dlp·내장 UVR 모델은 **릴리스 태그+SHA-256**으로 고정합니다. `releases/latest` floating 다운로드를 다시 넣지 마세요.
- Tauri `assetProtocol.scope`에 `$HOME/**`를 되돌리지 마세요. 로컬 음원은 `$HOME/Music/**` 등 필요한 경로만 허용합니다.

## 개발

자세한 환경 설정은 [README.md](README.md)를 참고하세요.
