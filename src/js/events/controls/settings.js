/**
 * Settings page control listeners
 */
import { state } from '../../state.js';
import { elements } from '../../ui/elements.js';
import { loadLibrary } from '../../audio.js';
import { getAppHandler } from '../../app-context.js';
import {
  FAQ_URL,
  FFMPEG_SOURCE_URL,
  GITHUB_ISSUES_BUG_URL,
  LICENSE_URL,
  PRIVACY_URL,
  QA_URL,
  TERMS_URL,
  THIRD_PARTY_NOTICES_URL,
  YTDLP_SOURCE_URL,
  resolveDiscordUrl,
} from '../../companion-links.js';
import {
  checkForAppUpdate,
  checkMrCachePath,
  exportBackup,
  exportLibrarySpreadsheet,
  getMrCacheFormat,
  getMrCachePathInfo,
  importBackup,
  importLibrarySpreadsheet,
  openAppPage,
  openCacheFolder,
  pickMrCacheFolder,
  runCacheRescue,
  setBroadcastMode,
  setMrCacheFormat,
  setMrCachePath,
} from '../../settings-api.js';

async function reloadLibraryAfterSpreadsheetImport(result) {
  const { showNotification } = await import('../../utils.js');
  const { renderLibrary } = await import('../../ui/library.js');
  const { refreshFilterDropdowns } = await import('../../ui/core.js');
  state.songLibrary = await loadLibrary() || [];
  await refreshFilterDropdowns();
  renderLibrary();
  const added = Number(result?.added || 0);
  const updated = Number(result?.updated || 0);
  const skipped = Number(result?.skipped || 0);
  let enriched = Number(result?.enriched || 0);
  let errCount = Array.isArray(result?.errors) ? result.errors.length : 0;
  let msg = `가져오기 완료: 추가 ${added}곡, 갱신 ${updated}곡`;
  if (enriched > 0) msg += `, 유튜브 정보 ${enriched}곡`;
  if (skipped > 0) msg += `, 건너뜀 ${skipped}행`;
  if (errCount > 0) msg += `, 오류 ${errCount}건`;
  showNotification(msg, errCount > 0 ? "warning" : "success");
  if (errCount > 0 && result.errors?.length) {
    console.warn("[spreadsheet import]", result.errors.slice(0, 20));
  }
}

export function initSettingsListeners({ syncAllOverlayStylesToBackend }) {
  if (elements.btnExportBackup) {
    elements.btnExportBackup.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportBackup();
        showNotification("라이브러리 목록이 성공적으로 백업되었습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("백업 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }

  if (elements.btnImportBackup) {
    elements.btnImportBackup.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await importBackup();
        const { renderLibrary } = await import('../../ui/library.js');
        state.songLibrary = await loadLibrary() || [];
        const { refreshFilterDropdowns } = await import('../../ui/core.js');
        await refreshFilterDropdowns();
        renderLibrary();
        showNotification("백업본에서 없는 곡들을 성공적으로 병합했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("복원 중 오류가 발생했습니다: " + err, "error");
        }
      }
    };
  }

  if (elements.btnExportSpreadsheetTemplate) {
    elements.btnExportSpreadsheetTemplate.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportLibrarySpreadsheet(true);
        showNotification("가져오기 양식(CSV)을 저장했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("양식 저장 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnExportSpreadsheet) {
    elements.btnExportSpreadsheet.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        await exportLibrarySpreadsheet(false);
        showNotification("라이브러리를 CSV로 저장했습니다.", "success");
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("CSV 보내기 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnImportSpreadsheet) {
    elements.btnImportSpreadsheet.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      try {
        const result = await importLibrarySpreadsheet();
        await reloadLibraryAfterSpreadsheetImport(result);
      } catch (err) {
        if (err !== "CANCELLED") {
          showNotification("가져오기 중 오류: " + err, "error");
        }
      }
    };
  }

  if (elements.btnRunRescue) {
    elements.btnRunRescue.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      const { renderLibrary } = await import('../../ui/library.js');

      showNotification("데이터 복구를 시작합니다. 유튜브 곡의 경우 시간이 소요될 수 있습니다.", "info");
      elements.btnRunRescue.classList.add("loading-btn");

      try {
        const result = await runCacheRescue();
        const stats = typeof result === "number"
          ? { scanned: result, recovered: result, failed: 0 }
          : {
              scanned: Number(result?.scanned || 0),
              recovered: Number(result?.recovered || 0),
              failed: Number(result?.failed || 0),
            };
        showNotification(
          `복구 완료: 스캔 ${stats.scanned}곡 / 복구 ${stats.recovered}곡 / 실패 ${stats.failed}곡`,
          stats.failed > 0 ? "warning" : "success"
        );
        state.songLibrary = await loadLibrary() || [];
        const { refreshFilterDropdowns } = await import('../../ui/core.js');
        await refreshFilterDropdowns();
        renderLibrary();
      } catch (err) {
        showNotification("복구 중 오류가 발생했습니다: " + err, "error");
      } finally {
        elements.btnRunRescue.classList.remove("loading-btn");
      }
    };
  }

  if (elements.themeModeSelect) {
    const syncThemeToUi = (mode) => {
      const dropdown = document.getElementById("theme-mode-dropdown");
      if (!dropdown) return;
      const selectedText = dropdown.querySelector(".selected-text");
      const options = dropdown.querySelectorAll(".option-item");
      options.forEach((opt) => {
        const selected = opt.dataset.value === mode;
        opt.classList.toggle("selected", selected);
        if (selected && selectedText) selectedText.textContent = opt.textContent;
      });
    };

    const initialMode = state.themeMode || localStorage.getItem("themeMode") || "dark";
    elements.themeModeSelect.value = initialMode;
    syncThemeToUi(initialMode);

    elements.themeModeSelect.addEventListener("change", async (e) => {
      const allowedThemes = new Set(["dark", "light", "pink", "sky"]);
      const mode = allowedThemes.has(e.target.value) ? e.target.value : "dark";
      const applyTheme = getAppHandler('applyAppTheme');
      if (typeof applyTheme === "function") {
        applyTheme(mode, { persist: true });
      } else {
        document.documentElement.setAttribute("data-theme", mode);
        localStorage.setItem("themeMode", mode);
      }
      state.themeMode = mode;
      syncThemeToUi(mode);
      if (typeof syncAllOverlayStylesToBackend === "function") {
        syncAllOverlayStylesToBackend();
      }
    });
  }

  const syncBroadcastModeToggles = (enabled) => {
    state.broadcastMode = !!enabled;
    localStorage.setItem("broadcastMode", String(!!enabled));
    if (elements.toggleBroadcastMode) elements.toggleBroadcastMode.checked = !!enabled;
    if (elements.toggleBroadcastModeActive) elements.toggleBroadcastModeActive.checked = !!enabled;
  };

  const applyBroadcastMode = async (enabled) => {
    try {
      await setBroadcastMode(enabled);
      syncBroadcastModeToggles(enabled);
    } catch (err) {
      syncBroadcastModeToggles(state.broadcastMode);
      const { showNotification } = await import('../../utils.js');
      showNotification("방송 제원 보호 모드 변경 실패: " + err, "error");
    }
  };

  if (elements.toggleBroadcastMode) {
    elements.toggleBroadcastMode.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  if (elements.toggleBroadcastModeActive) {
    elements.toggleBroadcastModeActive.onchange = (e) => applyBroadcastMode(e.target.checked);
  }
  syncBroadcastModeToggles(state.broadcastMode);

  // 인트로 자동 건너뛰기 - 순수 로컬 설정(백엔드 호출 없음), 기본값 켜짐.
  const toggleAutoSkipIntro = document.getElementById("toggle-auto-skip-intro");
  if (toggleAutoSkipIntro) {
    const stored = localStorage.getItem("autoSkipIntro");
    state.autoSkipIntro = stored === null ? true : stored === "true";
    toggleAutoSkipIntro.checked = state.autoSkipIntro;
    toggleAutoSkipIntro.onchange = (e) => {
      state.autoSkipIntro = !!e.target.checked;
      localStorage.setItem("autoSkipIntro", String(state.autoSkipIntro));
    };
  }

  // MR 분리 방식 선택 모달 표시 여부 - 모달 안의 "다음부터 바로 분리"와 같은 값.
  const toggleAskSeparationMode = document.getElementById("toggle-ask-separation-mode");
  if (toggleAskSeparationMode) {
    const stored = localStorage.getItem("askSeparationMode");
    state.askSeparationMode = stored === null ? true : stored === "true";
    toggleAskSeparationMode.checked = state.askSeparationMode;
    toggleAskSeparationMode.onchange = (e) => {
      state.askSeparationMode = !!e.target.checked;
      localStorage.setItem("askSeparationMode", String(state.askSeparationMode));
    };
  }

  const syncMrCacheFormatToUi = (format) => {
    const normalized = format === "wav" ? "wav" : "mp3";
    const dropdown = document.getElementById("mr-cache-format-dropdown");
    if (!dropdown) return;
    const selectedText = dropdown.querySelector(".selected-text");
    const options = dropdown.querySelectorAll(".option-item");
    options.forEach((opt) => {
      const selected = opt.dataset.value === normalized;
      opt.classList.toggle("selected", selected);
      if (selected && selectedText) selectedText.textContent = opt.textContent;
    });
    if (elements.mrCacheFormatSelect) {
      elements.mrCacheFormatSelect.value = normalized;
    }
  };

  const applyMrCacheFormat = async (format) => {
    const normalized = format === "wav" ? "wav" : "mp3";
    try {
      await setMrCacheFormat(normalized);
      state.mrCacheFormat = normalized;
      localStorage.setItem("mrCacheFormat", normalized);
      syncMrCacheFormatToUi(normalized);
    } catch (err) {
      syncMrCacheFormatToUi(state.mrCacheFormat);
      const { showNotification } = await import('../../utils.js');
      showNotification("MR 저장 형식 변경 실패: " + err, "error");
    }
  };

  if (elements.mrCacheFormatSelect) {
    const initMrCacheFormat = async () => {
      let format = state.mrCacheFormat || "mp3";
      let fromBackend = false;
      try {
        const backend = await getMrCacheFormat();
        if (backend === "mp3" || backend === "wav") {
          format = backend;
          fromBackend = true;
        }
      } catch (_) {
        /* use localStorage fallback */
      }
      state.mrCacheFormat = format;
      localStorage.setItem("mrCacheFormat", format);
      syncMrCacheFormatToUi(format);
      // 백엔드가 설정 DB에서 복원한 값이 진실의 원천이므로 되돌려 보내지 않는다.
      if (fromBackend) return;
      try {
        await setMrCacheFormat(format);
      } catch (_) {
        /* backend may be unavailable during early init */
      }
    };
    initMrCacheFormat();

    elements.mrCacheFormatSelect.addEventListener("change", async (e) => {
      await applyMrCacheFormat(e.target.value);
      const { showNotification } = await import('../../utils.js');
      const label = e.target.value === "wav" ? "WAV (32비트 무손실)" : "MP3 (320kbps)";
      showNotification(`MR 저장 형식이 ${label}로 변경되었습니다.`, "info");
    });
  }

  const btnOpenCache = document.getElementById("btn-open-cache");
  if (btnOpenCache) {
    btnOpenCache.onclick = async () => {
      await openCacheFolder();
    };
  }

  // MR 캐시 저장 위치 - 로컬 디스크 우선, 쓰기 가능한 네트워크 공유도 허용하되
  // 성능 경고 표시. 변경 사항은 앱 재시작 시에만 실제 반영된다(백엔드가
  // AppPaths::from_handle에서 시작 시 한 번만 읽음) - 라이브러리의 바운디드
  // LRC 싱크 상태 스캔(classify_lyric_sync_status)은 그대로 유지된다.
  const mrCachePathDisplay = document.getElementById("mr-cache-path-display");
  const mrCachePathStatus = document.getElementById("mr-cache-path-status");
  const btnBrowseMrCachePath = document.getElementById("btn-browse-mr-cache-path");
  const btnSaveMrCachePath = document.getElementById("btn-save-mr-cache-path");
  const btnResetMrCachePath = document.getElementById("btn-reset-mr-cache-path");

  if (mrCachePathDisplay && btnBrowseMrCachePath) {
    let pendingPath = null; // 아직 저장하지 않은, 찾아보기로 방금 고른 경로

    const showStatus = (message, tone = "warning") => {
      if (!mrCachePathStatus) return;
      if (!message) {
        mrCachePathStatus.style.display = "none";
        mrCachePathStatus.textContent = "";
        return;
      }
      mrCachePathStatus.style.display = "block";
      mrCachePathStatus.textContent = message;
      mrCachePathStatus.style.borderColor = tone === "error" ? "rgba(239, 68, 68, 0.4)" : "rgba(245, 158, 11, 0.35)";
      mrCachePathStatus.style.background = tone === "error" ? "rgba(239, 68, 68, 0.1)" : "rgba(245, 158, 11, 0.1)";
    };

    const refreshFromBackend = async () => {
      try {
        const info = await getMrCachePathInfo();
        pendingPath = null;
        if (btnSaveMrCachePath) btnSaveMrCachePath.disabled = true;
        // 기본 위치일 때도 실제 폴더 경로를 그대로 보여준다. 저장은 했지만 아직
        // 재시작 전이면 저장된 경로를 보여주고, 지금 쓰는 경로는 경고에서 알린다.
        mrCachePathDisplay.textContent = info.customPath || info.effectivePath;
        if (btnResetMrCachePath) btnResetMrCachePath.style.display = info.isCustom ? "" : "none";

        if (info.pendingRestart) {
          showStatus(
            `앱을 다시 시작해야 적용됩니다. 지금은 ${info.effectivePath} 를 사용 중입니다.`,
            "warning"
          );
        } else if (info.isNetworkPath) {
          showStatus("네트워크 폴더를 사용 중입니다. 느릴 수 있습니다.", "warning");
        } else {
          showStatus(null);
        }
      } catch (err) {
        console.error("Failed to load MR cache path info:", err);
      }
    };

    btnBrowseMrCachePath.onclick = async () => {
      const { showNotification } = await import('../../utils.js');
      let picked;
      try {
        picked = await pickMrCacheFolder();
      } catch (err) {
        console.error("Failed to open folder picker:", err);
        return;
      }
      if (!picked) return;

      let check;
      try {
        check = await checkMrCachePath(picked);
      } catch (err) {
        showNotification("경로 확인 중 오류: " + err, "error");
        return;
      }

      if (!check.writable) {
        pendingPath = null;
        if (btnSaveMrCachePath) btnSaveMrCachePath.disabled = true;
        mrCachePathDisplay.textContent = picked;
        showStatus(check.error || "이 폴더에는 쓸 수 없습니다.", "error");
        return;
      }

      pendingPath = picked;
      mrCachePathDisplay.textContent = picked;
      if (btnSaveMrCachePath) btnSaveMrCachePath.disabled = false;
      showStatus(
        check.isNetworkPath
          ? "쓸 수 있는 폴더입니다. 네트워크 경로라 느릴 수 있습니다."
          : "쓸 수 있는 폴더입니다. 저장 후 앱을 다시 시작하면 적용됩니다.",
        "warning"
      );
    };

    if (btnSaveMrCachePath) {
      btnSaveMrCachePath.onclick = async () => {
        const { showNotification } = await import('../../utils.js');
        if (!pendingPath) return;
        try {
          await setMrCachePath(pendingPath);
          showNotification("MR 캐시 저장 위치를 저장했습니다. 앱을 다시 시작하면 적용됩니다.", "success");
          await refreshFromBackend();
        } catch (err) {
          showNotification("저장 실패: " + err, "error");
        }
      };
    }

    if (btnResetMrCachePath) {
      btnResetMrCachePath.onclick = async () => {
        const { showNotification } = await import('../../utils.js');
        try {
          await setMrCachePath(null);
          showNotification("기본 위치로 되돌렸습니다. 앱을 다시 시작하면 적용됩니다.", "success");
          await refreshFromBackend();
        } catch (err) {
          showNotification("재설정 실패: " + err, "error");
        }
      };
    }

    refreshFromBackend();
  }

  const btnCheckAppUpdate = document.getElementById("btn-check-app-update");
  const appVersionDesc = document.getElementById("app-version-desc");
  const btnOpenPrivacyPolicy = document.getElementById("btn-open-privacy-policy");
  const btnOpenTermsOfService = document.getElementById("btn-open-terms-of-service");
  const btnOpenLicense = document.getElementById("btn-open-license");
  const btnOpenThirdPartyNotices = document.getElementById("btn-open-third-party-notices");
  const btnOpenFfmpegSource = document.getElementById("btn-open-ffmpeg-source");
  const btnOpenYtdlpSource = document.getElementById("btn-open-ytdlp-source");
  const btnOpenFaq = document.getElementById("btn-open-faq");
  const btnOpenQa = document.getElementById("btn-open-qa");
  const btnOpenDiscord = document.getElementById("btn-open-discord");
  const btnOpenBugReport = document.getElementById("btn-open-bug-report");

  const openCompanionPage = async (url) => {
    const { showNotification } = await import('../../utils.js');
    try {
      await openAppPage(url);
    } catch (err) {
      console.error("[Companion] Failed to open page:", err);
      showNotification("브라우저에서 페이지를 열지 못했습니다.", "error");
    }
  };

  if (btnOpenPrivacyPolicy) btnOpenPrivacyPolicy.onclick = () => openCompanionPage(PRIVACY_URL);
  if (btnOpenTermsOfService) btnOpenTermsOfService.onclick = () => openCompanionPage(TERMS_URL);
  if (btnOpenLicense) btnOpenLicense.onclick = () => openCompanionPage(LICENSE_URL);
  if (btnOpenThirdPartyNotices) btnOpenThirdPartyNotices.onclick = () => openCompanionPage(THIRD_PARTY_NOTICES_URL);
  if (btnOpenFfmpegSource) btnOpenFfmpegSource.onclick = () => openCompanionPage(FFMPEG_SOURCE_URL);
  if (btnOpenYtdlpSource) btnOpenYtdlpSource.onclick = () => openCompanionPage(YTDLP_SOURCE_URL);
  if (btnOpenFaq) btnOpenFaq.onclick = () => openCompanionPage(FAQ_URL);
  if (btnOpenQa) btnOpenQa.onclick = () => openCompanionPage(QA_URL);
  if (btnOpenDiscord) btnOpenDiscord.onclick = () => openCompanionPage(resolveDiscordUrl());
  if (btnOpenBugReport) btnOpenBugReport.onclick = () => openCompanionPage(GITHUB_ISSUES_BUG_URL);

  if (btnCheckAppUpdate) {
    btnCheckAppUpdate.onclick = async () => {
      const { showNotification, showUpdateAvailable } = await import('../../utils.js');
      btnCheckAppUpdate.disabled = true;
      try {
        const info = await checkForAppUpdate();
        const current = info?.currentVersion || info?.current_version || "?";
        const latest = info?.latestVersion || info?.latest_version || "?";
        if (appVersionDesc) {
          appVersionDesc.textContent = `현재 v${current} · GitHub 최신 v${latest}`;
        }
        if (info?.hasUpdate) {
          showUpdateAvailable(info);
        } else {
          showNotification("이미 최신 버전을 사용 중입니다.", "success");
        }
      } catch (err) {
        showNotification("업데이트 확인 실패: " + err, "error");
      } finally {
        btnCheckAppUpdate.disabled = false;
      }
    };
  }
}
