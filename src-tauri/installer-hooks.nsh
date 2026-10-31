; Hooks NSIS do System PDV PRO
; ---------------------------------------------------------------------------
!include "FileFunc.nsh"
; Tauri/NSIS so remove os arquivos que ele mesmo instalou. Arquivos criados
; em tempo de execucao (logs, node_modules descompactado, etc.) e a propria
; pasta ficavam para tras em "C:\Program Files\System PDV PRO", o que gerava
; erro ao reinstalar. Aqui forcamos a remocao completa da pasta.

!macro NSIS_HOOK_POSTINSTALL
  ; Toda instalacao deve iniciar com a escolha do modo desta maquina. Isso
  ; tambem limpa configuracoes deixadas por desinstaladores de versoes antigas.
  ; O banco de dados permanece preservado em AppData.
  Delete "$APPDATA\com.systempdvpro.app\config.json"
  Delete "$LOCALAPPDATA\com.systempdvpro.app\config.json"

  ; Marca esta execucao do instalador. O app compara este valor no primeiro
  ; inicio de cada usuario, evitando que a elevacao UAC limpe o perfil errado.
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  FileOpen $7 "$INSTDIR\install-stamp.txt" w
  FileWrite $7 "$2-$1-$0 $4:$5:$6"
  FileClose $7
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Encerra o app (e, via /T, o servidor Node filho) caso esteja aberto, para
  ; nao deixar arquivos travados. Nao matamos node.exe globalmente para nao
  ; afetar outros processos Node do usuario.
  nsExec::Exec 'taskkill /F /IM "System PDV PRO.exe" /T'
  ; O servidor continua em segundo plano mesmo com a janela fechada. Encerra
  ; somente o processo que estiver atendendo a porta exclusiva do PDV.
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force }"'
  Sleep 800
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove a pasta de instalacao inteira (inclui arquivos criados em runtime).
  RMDir /r "$INSTDIR"

  ; A configuracao pertence a esta instalacao/máquina e deve voltar zerada
  ; depois de desinstalar. O banco em AppData permanece preservado.
  Delete "$APPDATA\com.systempdvpro.app\config.json"
  Delete "$LOCALAPPDATA\com.systempdvpro.app\config.json"
!macroend
