# NOTICE — AI 가사 정렬(강제정렬) 모델 (KO/EN)

> 법률 자문이 아닙니다. Apache License, Version 2.0 §4(d)에 따른 고지 목적 문서입니다.

이 프로젝트(Live MR Manager)는 아래 두 개의 음성 인식 모델을 **ONNX 형식으로 변환**하여, 이
프로젝트가 소유한 GitHub Release를 통해 사용자에게 온디맨드로 배포합니다. 원본 가중치의
저작권은 각 원본 모델 카드에 기재된 저작자에게 있으며, 두 모델 모두 **Apache License,
Version 2.0**으로 배포됩니다.

## 1. 한국어 정렬 모델

- **원본**: [kresnik/wav2vec2-large-xlsr-korean](https://huggingface.co/kresnik/wav2vec2-large-xlsr-korean)
- **라이선스**: Apache License, Version 2.0 (원본 모델 카드 기준)
- **변경 사항(Apache-2.0 §4(b) 고지)**: 원본 PyTorch 체크포인트를 ONNX 그래프로 변환(export)했습니다.
  추론에 사용하는 연산 그래프 형식만 바뀌었으며, 학습된 가중치 자체의 내용은 변경하지 않았습니다.
  어휘집(vocab)은 `tokens.txt`로 함께 배포합니다.
- **재배포 자산**: `model.onnx`, `tokens.txt` — 이 프로젝트의 GitHub Release
  [`ai-align-model-v1`](https://github.com/AutumnColor77/Live-MR-Manager/releases/tag/ai-align-model-v1)
- **SHA-256**: `model.onnx` = `e0377224ca28e4daa434155d9a035e858c7dc0c984084011734e101852bba4db`,
  `tokens.txt` = `4511d865e8decdc630f6a7c1781e53d3c22ae40b81702881e2629eddf846b082`

## 2. 영어 정렬 모델

- **원본**: [facebook/wav2vec2-base-960h](https://huggingface.co/facebook/wav2vec2-base-960h)
- **라이선스**: Apache License, Version 2.0 (원본 모델 카드 기준)
- **변경 사항(Apache-2.0 §4(b) 고지)**: 원본 PyTorch 체크포인트를 ONNX 그래프로 변환(export)했습니다.
  추론에 사용하는 연산 그래프 형식만 바뀌었으며, 학습된 가중치 자체의 내용은 변경하지 않았습니다.
  문자 단위(char-level) 어휘집은 `tokens.txt`로 함께 배포합니다.
- **재배포 자산**: `model.onnx`, `tokens.txt` — 이 프로젝트의 GitHub Release
  [`align-model-en-v1`](https://github.com/AutumnColor77/Live-MR-Manager/releases/tag/align-model-en-v1)
- **SHA-256**: `model.onnx` = `7ffb91554931fb918bee1d2294d022886c73ca8642b93ad181d058300fe6a6ef`,
  `tokens.txt` = `07dd8185b1faf8802d94b9a1336aed9e54366994f7e2227b4b0fd0d32a9c044a`

## 3. 라이선스 전문

Apache License, Version 2.0 전문은 <https://www.apache.org/licenses/LICENSE-2.0> 에서 확인할
수 있습니다. 이 프로젝트는 위 변환·재배포 활동에 대해 원본 저작자의 상표·특허 권리를 주장하지
않으며, Apache-2.0이 요구하는 저작권 고지·라이선스 사본 제공·변경 사항 고지 의무를 본 문서와
[`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md) §3.1을 통해 이행합니다.

## 4. 품질·용도 고지

두 모델 모두 **낭독체(read speech) 데이터셋**으로 학습되었습니다. 노래(가창) 음성에 대한 강제
정렬은 원 학습 목적과 다른 실험적 적용이며, 결과는 **AI 초안**으로 취급해야 합니다. 앱은 최초
다운로드 확인 화면과 설정 화면에서 이 사실을 고지하고, 정렬 결과는 사용자가 직접 다듬을 것을
권장합니다.
