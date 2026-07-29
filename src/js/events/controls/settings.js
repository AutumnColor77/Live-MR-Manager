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
  exportBackup,
  exportLibrarySpreadsheet,
  getMrCacheFormat,
  importBackup,
  importLibrarySpreadsheet,
  openAppPage,
  openCacheFolder,
  runCacheRescue,
  setBroadcastMode,
  setMrCacheFormat,
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
      try {
        const backend = await getMrCacheFormat();
        if (backend === "mp3" || backend === "wav") {
          format = backend;
        }
      } catch (_) {
        /* use localStorage fallback */
      }
      state.mrCacheFormat = format;
      localStorage.setItem("mrCacheFormat", format);
      syncMrCacheFormatToUi(format);
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
