!macro customInstall
  StrCpy $0 "$INSTDIR\resources\icon.ico"

  ${If} ${FileExists} "$0"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      ${If} ${FileExists} "$newStartMenuLink"
        Delete "$newStartMenuLink"
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${EndIf}
    !endif

    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      ${IfNot} ${isNoDesktopShortcut}
        Delete "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$0" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${EndIf}
    !endif

    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  ${EndIf}
!macroend
