; Install Visual C++ Redistributable (x64) when missing.
; Bundled as resources/vc_redist.x64.exe and cleaned up after install.

!macro NSIS_HOOK_POSTINSTALL
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    DetailPrint "Visual C++ Redistributable already installed"
    Goto vcredist_done
  ${EndIf}

  ${If} ${FileExists} "$INSTDIR\resources\vc_redist.x64.exe"
    DetailPrint "Installing Visual C++ Redistributable..."
    CopyFiles "$INSTDIR\resources\vc_redist.x64.exe" "$TEMP\vc_redist.x64.exe"
    ExecWait '"$TEMP\vc_redist.x64.exe" /install /passive /norestart' $0

    ; 0 = success, 1638 = newer/same already installed, 3010 = success (reboot required)
    ${If} $0 == 0
      DetailPrint "Visual C++ Redistributable installed successfully"
    ${ElseIf} $0 == 1638
      DetailPrint "Visual C++ Redistributable already present"
    ${ElseIf} $0 == 3010
      DetailPrint "Visual C++ Redistributable installed (reboot may be required)"
    ${Else}
      MessageBox MB_ICONEXCLAMATION "Visual C++ 런타임 설치에 실패했습니다 (코드 $0).$\r$\n앱 실행 시 DLL 오류가 날 수 있습니다.$\r$\nhttps://aka.ms/vs/17/release/vc_redist.x64.exe 에서 직접 설치해 주세요."
    ${EndIf}

    Delete "$TEMP\vc_redist.x64.exe"
    Delete "$INSTDIR\resources\vc_redist.x64.exe"
  ${Else}
    DetailPrint "vc_redist.x64.exe not found in installer resources"
  ${EndIf}

  vcredist_done:
!macroend
