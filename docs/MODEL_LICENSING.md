# AI 모델 라이선스 채택 기준

> 법률 자문이 아닙니다. 유지보수·PR 리뷰용 체크리스트입니다.
> Live MR Manager는 **무료 배포 + 수익화 방송을 하는 스트리머의 제한 없는 사용**을 목표로 합니다.

## 적용 범위

MIT·Apache-2.0·BSD 같은 **허용적 라이선스 전용** 원칙은 앱에 링크·포함되는 구성요소와 공식 AI 모델에 적용합니다.

FFmpeg·yt-dlp처럼 사용자가 원 배포처에서 런타임에 직접 받는 별도 CLI 프로그램은 예외로 허용할 수 있습니다. 단, 프로젝트가 파일을 재호스팅하거나 설치 패키지에 번들하지 않고, 앱과 별도 프로세스로만 통신하며, 출처·라이선스·소스 위치를 고지해야 합니다. 자세한 정책은 [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) §2를 따릅니다.

## 1. 채택 전 필수 확인

신규·외부 PR 모델을 공식 기본값·추천 목록·프로젝트 GitHub Release에 넣기 전에 모두 충족해야 합니다.

1. **명시적 라이선스 텍스트**가 모델 카드 또는 LICENSE 파일에 존재한다.
2. **상업적 이용(Commercial use)** 이 허용된다. (`CC-BY-NC`, “research only”, “non-commercial” 등은 탈락)
3. **재배포(Redistribution)** 가 허용된다. (앱의 온디맨드 다운로드·미러 Release 포함)
4. Attribution / NOTICE / share-alike 의무를 문서·UI에 이행할 수 있다.
5. 변환본(ONNX 등)을 배포할 경우 원본 라이선스가 파생·변환을 허용하는지 확인한다.
6. 학습 데이터·추가 제한(예: Meta/FAIR 추가 약관)이 있으면 별도 기록한다.

## 2. 배포 경로별 규칙

| 경로 | 허용 조건 |
| --- | --- |
| 앱 기본 모델 (`MODELS`) | §1 전부 + 상업 이용 명확 |
| 설정 UI “추천/원클릭” 카탈로그 | §1 전부. NC 모델 금지 |
| 사용자 커스텀 로컬/URL 등록 | 사용자가 스스로 권리를 확인. 앱은 공식 보증하지 않음 |
| 프로젝트 GitHub Release에 가중치 업로드 | §1 + NOTICE/LICENSE 파일을 같은 릴리스에 포함 |

## 3. 현재 기본 분리 모델 (v0.5.1)

| ID | 파일 | 판정 | 조치 |
| --- | --- | --- | --- |
| `kim` | Kim_Vocal_2.onnx | **잠정 MIT** | UVR README 크레딧 요청 근거. HF `seanghay/uvr_models`에 license 태그 없음 → UI/고지에 “잠정” 표기, UVR 크레딧 유지, 작성자 확인 추적 |
| `inst_hq_3` | UVR-MDX-NET-Inst_HQ_3.onnx | **잠정 MIT** | 동일 |

근거: [UVR License 절](https://github.com/Anjok07/ultimatevocalremovergui#license) — 모델 사용 시 MIT 준수·크레딧.  
잔여 리스크: [Issue #1242](https://github.com/Anjok07/ultimatevocalremovergui/issues/1242)에서 상업 제품 사용 여부가 작성자 확인 대기.

**정식 배포 결론:** 기본 다운로드는 유지하되, 고지·크레딧 없이는 배포하지 않는다. 작성자 거절 또는 NC 재분류가 확인되면 즉시 기본 목록에서 제거하고 대체 모델을 찾는다.

## 4. 외부 PR (Temmis2077 Mod / PR #1) 채택 기준

| 모델 | 라이선스 | 공식 채택 |
| --- | --- | --- |
| kresnik/wav2vec2-large-xlsr-korean (정렬 KO) | Apache-2.0 | **가능** — LICENSE/NOTICE·원본 고지·변환 사실 명시 후 온디맨드 |
| facebook/wav2vec2-base-960h (정렬 EN) | Apache-2.0 | **가능** — 동일 |
| becruily/mel-band-roformer-deux (분리) | **CC-BY-NC-4.0** | **불가** — 수익화 방송·상업 이용과 충돌. 공식 기본/추천/프로젝트 Release에 넣지 않음. 사용자가 로컬 커스텀으로 넣는 것은 이용자 책임으로만 허용 가능 |

Apache-2.0 정렬 모델 반영 시 체크:

- [ ] 원본 HF 카드·LICENSE 링크
- [ ] 변환 ONNX 릴리스에 NOTICE (저작권·Apache-2.0·변경 사항)
- [ ] 다운로드 확인 UI에 라이선스·용량(~1.2GB / ~360MB) 표시
- [ ] “낭독체 학습 → 가창은 초안” 품질 고지

## 5. 문서·UI에 넣을 최소 문구

- 설정 > AI: UVR 크레딧 + 제3자 고지 링크
- 모델 최초 다운로드: 출처·라이선스(또는 잠정 상태)·용량
- README / THIRD_PARTY_NOTICES: 본 문서와 동기화
