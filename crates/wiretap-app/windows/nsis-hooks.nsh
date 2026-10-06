; Puts the install directory, which holds wiretap-can-cli.exe, on PATH.
!include WinMessages.nsh

!define WIRETAP_MACHINE_ENV "SYSTEM\CurrentControlSet\Control\Session Manager\Environment"
; NSIS strings stop at NSIS_MAX_STRLEN, so a PATH near that length is left
; alone rather than written back truncated.
!define /math WIRETAP_PATH_MAX ${NSIS_MAX_STRLEN} - 4

!macro WIRETAP_EDIT_PATH ROOT KEY ADD
  ReadRegStr $R0 ${ROOT} "${KEY}" "Path"
  StrLen $R1 $R0
  StrLen $R2 $INSTDIR
  IntOp $R1 $R1 + $R2
  ${If} $R1 < ${WIRETAP_PATH_MAX}
    ${WordReplace} ";$R0;" ";$INSTDIR;" ";" "+" $R0
    StrCpy $R0 $R0 -1 1
    !if ${ADD} == 1
      StrCpy $R1 $R0 "" -1
      ${If} $R0 == ""
        StrCpy $R0 $INSTDIR
      ${ElseIf} $R1 == ";"
        StrCpy $R0 "$R0$INSTDIR"
      ${Else}
        StrCpy $R0 "$R0;$INSTDIR"
      ${EndIf}
    !endif
    WriteRegExpandStr ${ROOT} "${KEY}" "Path" $R0
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${Else}
    DetailPrint "PATH is too long to edit: add $INSTDIR to it by hand to run wiretap-can-cli."
  ${EndIf}
!macroend

!macro WIRETAP_PATH ADD
  !if "${INSTALLMODE}" == "perMachine"
    !insertmacro WIRETAP_EDIT_PATH HKLM "${WIRETAP_MACHINE_ENV}" ${ADD}
  !else if "${INSTALLMODE}" == "currentUser"
    !insertmacro WIRETAP_EDIT_PATH HKCU "Environment" ${ADD}
  !else
    ${If} $MultiUser.InstallMode == "AllUsers"
      !insertmacro WIRETAP_EDIT_PATH HKLM "${WIRETAP_MACHINE_ENV}" ${ADD}
    ${Else}
      !insertmacro WIRETAP_EDIT_PATH HKCU "Environment" ${ADD}
    ${EndIf}
  !endif
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WIRETAP_PATH 1
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro WIRETAP_PATH 0
!macroend
