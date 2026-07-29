# GPU 가속 팩 (TensorRT)

MR 분리 속도를 **곡당 20~30분 → 약 30초**로 줄이는 선택 설치형 구성요소다.
NVIDIA GPU 전용이며, 없어도 앱은 기존대로 동작한다.

## 왜 필요했나 — 실측으로 드러난 원인

증상: RoFormer(RawWaveform) 모델로 58곡 분리에 12시간 이상. 그런데 로그에는
`Using: GPU (CUDA)`로 찍혔다. 같은 ONNX 런타임에서 MDX/Kim_Vocal_2 + DirectML은
곡당 18.5초였다 — 즉 "ONNX라서 느리다"는 전제부터 틀렸다.

원인은 세 겹이었다:

1. `ort` 크레이트 피처에 `cuda`가 없어 CUDA EP 등록이 실패했다.
2. **ort는 EP 등록 실패를 경고만 남기고 CPU로 계속 진행한다.** 그래서 실제로는
   CPU로 돌면서 로그는 계속 "GPU (CUDA)"라고 말했다. 이게 문제를 오래 숨겼다.
3. `cuda` 피처를 켜서 CUDA가 실제로 붙어도 **CPU보다 느렸다.** 이 모델 그래프는
   노드가 5118개인데 거의 융합되지 않아, 연산 자체가 아니라 커널 실행 오버헤드에
   묶여 있었다(GPU 사용률 7%, 41W/175W. 노드 실행 시간 합 5.0초 vs 실제 19.3초).

→ 런타임이 아니라 **그래프 융합**이 병목이었다. 그래서 TensorRT다.

## 실측 (RTX 2070 8GB, 모델 909MB, 입력 `[1, 2, 352800]` 정적)

| 경로 | 청크당 | 3분30초 곡 | 58곡 |
| :--- | ---: | ---: | ---: |
| 기존 앱 (CPU + Level1) | ~39,000ms | 20~30분 | **12시간+** |
| CPU (Level3) | 14,113ms | 8.2분 | ~8시간 |
| CUDA (cuDNN 있음) | 18,200ms | 10.6분 | 더 느림 |
| DirectML | 크래시 `887A0006` | — | — |
| **TensorRT** | **853ms** | **30초** | **~29분** |

정확도: CPU와 TensorRT의 출력 통계가 소수점 8자리까지 일치했다
(샘플 141만 개, mean=0.00027784 / rms=0.15003123).

## 구조

DLL 약 2GB라 설치본에 넣을 수 없다. AI 모델(1.2GB)을 GitHub 릴리즈에서 받아 쓰는
기존 방식과 동일하게, 원하는 사용자만 받아서 아래 위치에 둔다:

```
%LOCALAPPDATA%\LiveMRManager\tools\gpu\      ← DLL
%LOCALAPPDATA%\LiveMRManager\tools\trt_cache\ ← 빌드된 엔진 캐시
```

`gpu_pack::is_installed()`가 필수 DLL을 확인하고, 있을 때만 프로바이더 체인 맨 앞에
TensorRT를 넣는다. 없으면 기존 경로(DirectML/CUDA/CPU)로 그대로 간다.

### 필수 DLL

`nvinfer_10.dll`, `nvinfer_plugin_10.dll`, `nvonnxparser_10.dll`,
`nvinfer_builder_resource_10.dll`(1326MB), `cudnn64_9.dll`, `cublas64_12.dll`,
`cublasLt64_12.dll` — 및 이들의 의존 DLL(cudnn_* 하위 모듈, `cudart64_12.dll` 등).

## 함정: PATH로는 안 된다

ORT는 provider DLL을 `LoadLibraryEx`의 **제한된 검색 플래그**로 연다. 그래서
PATH에 팩 폴더를 넣어도 검색 대상에서 빠지고 `Error 126: cudnn64_9.dll missing`으로
실패한다. 그리고 ort가 그 실패를 삼켜 조용히 CPU로 떨어진다.

해결: `gpu_pack::register_dll_search_path()`가 앱 시작 시(**ORT를 처음 쓰기 전**)
Win32 `LoadLibraryExW`로 각 DLL을 **절대경로로 직접 선적재**한다
(`LOAD_WITH_ALTERED_SEARCH_PATH = 0x8`). 한 번 적재된 모듈은 같은 이름으로 다시
요청될 때 Windows가 재사용하므로, 이후 ORT의 provider DLL이 의존성을 정상 해결한다.

## 엔진 캐시

TensorRT 엔진은 **GPU 아키텍처별로 다르다**(RTX 2070 = `sm75`, 969MB). 첫 빌드에
약 150초 걸리고, 캐시가 맞으면 세션 로드가 12~17초로 줄어든다. 사용자가 GPU를
바꾸면 자동으로 다시 빌드된다.

## 미해결 — 배포 전 결정 필요

**NVIDIA DLL 재배포 라이선스.** cuDNN/TensorRT 재배포에는 NVIDIA의 조건이 붙는다.
GitHub 릴리즈에 직접 올려 배포할지, 아니면 사용자가 NVIDIA에서 직접 받도록
안내만 할지 확인이 필요하다. 현재 앱은 **폴더 열기 + 상태 표시**까지만 제공하고
자동 다운로드는 넣지 않았다.
