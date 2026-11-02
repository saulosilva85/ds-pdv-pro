; Hooks NSIS do DS PDV PRO
; ---------------------------------------------------------------------------
!include "FileFunc.nsh"

; ---------------------------------------------------------------------------
; Encerra TODOS os processos que estao rodando de dentro da pasta de instalacao
; (o app, o node.exe do servidor embutido e qualquer outro), sem depender do
; nome do executavel nem da porta. O servidor Node continua em segundo plano
; mesmo com a janela fechada e, com a pasta como diretorio de trabalho dele,
; trava a exclusao de "C:\Program Files\DS PDV PRO" ate reiniciar o PC.
; O proprio desinstalador (uninstall.exe) e preservado.
; ---------------------------------------------------------------------------
!macro DS_ENCERRAR_PROCESSOS
  nsExec::Exec `taskkill /F /IM "DS PDV PRO.exe" /T`
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $$_.ExecutablePath -and $$_.Name -ne 'uninstall.exe' -and $$_.ExecutablePath.StartsWith('$INSTDIR\', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force -ErrorAction SilentlyContinue }"`
  ; Garantia extra: quem estiver atendendo a porta exclusiva do PDV.
  nsExec::ExecToLog `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $$_.OwningProcess -Force -ErrorAction SilentlyContinue }"`
  ; Da tempo ao Windows de liberar os arquivos.
  Sleep 2000
!macroend

; Antes de copiar arquivos (instalacao nova ou atualizacao): se o app/servidor
; da versao anterior ainda estiver rodando, os arquivos ficam em uso.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro DS_ENCERRAR_PROCESSOS
!macroend

; Tauri/NSIS so remove os arquivos que ele mesmo instalou. Arquivos criados
; em tempo de execucao (logs, node_modules descompactado, etc.) e a propria
; pasta ficavam para tras em "C:\Program Files\DS PDV PRO", o que gerava
; erro ao reinstalar. Aqui forcamos a remocao completa da pasta.

!macro NSIS_HOOK_POSTINSTALL
  ; Toda instalacao deve iniciar com a escolha do modo desta maquina. Isso
  ; tambem limpa configuracoes deixadas por desinstaladores de versoes antigas.
  ; O banco de dados permanece preservado em AppData.
  Delete "$APPDATA\com.dssolucoes.pdvpro\config.json"
  Delete "$LOCALAPPDATA\com.dssolucoes.pdvpro\config.json"

  ; Marca esta execucao do instalador. O app compara este valor no primeiro
  ; inicio de cada usuario, evitando que a elevacao UAC limpe o perfil errado.
  ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
  FileOpen $7 "$INSTDIR\install-stamp.txt" w
  FileWrite $7 "$2-$1-$0 $4:$5:$6"
  FileClose $7
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro DS_ENCERRAR_PROCESSOS
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; O diretorio de trabalho do desinstalador nao pode ser a propria pasta que
  ; sera removida (isso bloqueia a exclusao).
  SetOutPath $TEMP

  ; Remove a pasta de instalacao inteira (inclui arquivos criados em runtime).
  ; /REBOOTOK: se algum arquivo ainda estiver em uso, o Windows o remove sozinho
  ; no proximo reinicio (sem precisar apagar a pasta manualmente).
  RMDir /r /REBOOTOK "$INSTDIR"

  ; A configuracao pertence a esta instalacao/máquina e deve voltar zerada
  ; depois de desinstalar. O banco em AppData permanece preservado.
  Delete "$APPDATA\com.dssolucoes.pdvpro\config.json"
  Delete "$LOCALAPPDATA\com.dssolucoes.pdvpro\config.json"
!macroend
