// Impressão nativa (Windows): envia bytes ESC/POS direto para a impressora
// selecionada via spooler em modo RAW, e aciona a gaveta. Em outras
// plataformas (dev), as funções retornam erro/-vazio.

#[cfg(windows)]
pub mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Graphics::Printing::{
        ClosePrinter, EndDocPrinter, EndPagePrinter, OpenPrinterW, StartDocPrinterW,
        StartPagePrinter, WritePrinter, DOC_INFO_1W,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    const CREATE_NO_WINDOW: u32 = 0x08000000;

    // Executa um script PowerShell e devolve as linhas nao vazias do stdout.
    fn powershell_lines(script: &str) -> Result<Vec<String>, String> {
        let output = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("falha ao consultar impressoras do Windows: {e}"))?;

        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() {
                "falha ao consultar impressoras instaladas no Windows".into()
            } else {
                message
            });
        }

        Ok(String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|name| name.trim().trim_start_matches('\u{feff}'))
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect())
    }

    // Lista as impressoras pelo NOME DO SPOOLER (Get-Printer / Win32_Printer),
    // que e exatamente o nome aceito por OpenPrinterW. A versao anterior usava
    // Get-PnpDevice, cujo "FriendlyName" frequentemente difere do nome da fila
    // de impressao (ex.: impressora renomeada para "CAIXA 02") e nao inclui
    // impressoras compartilhadas de rede — por isso a impressao falhava em
    // alguns caixas mesmo com a impressora selecionada.
    pub fn list_printers() -> Result<Vec<String>, String> {
        let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
            try { Get-Printer -ErrorAction Stop | ForEach-Object { $_.Name } } \
            catch { Get-CimInstance -ClassName Win32_Printer | ForEach-Object { $_.Name } }";
        let mut names = powershell_lines(script)?;
        let mut seen = std::collections::HashSet::new();
        names.retain(|n| seen.insert(n.clone()));
        Ok(names)
    }

    // Impressora padrao do Windows nesta maquina (vazio se nao houver).
    pub fn default_printer() -> Result<String, String> {
        let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; \
            (Get-CimInstance -ClassName Win32_Printer | Where-Object { $_.Default } | \
            Select-Object -First 1).Name";
        Ok(powershell_lines(script)?.into_iter().next().unwrap_or_default())
    }

    pub fn print_raw(printer: &str, data: &[u8]) -> Result<(), String> {
        let printer = printer.trim();
        if printer.is_empty() {
            return Err(
                "nenhuma impressora configurada neste caixa — selecione uma em Configurações > Impressora"
                    .into(),
            );
        }
        if data.is_empty() {
            return Ok(());
        }
        unsafe {
            let pname = wide(printer);
            let mut hprinter = HANDLE::default();
            OpenPrinterW(PCWSTR(pname.as_ptr()), &mut hprinter, None).map_err(|e| {
                format!(
                    "OpenPrinter('{}'): {} — confira se a impressora existe e está ligada neste computador",
                    printer, e
                )
            })?;

            let result = (|| -> Result<(), String> {
                let mut docname = wide("Cupom DS PDV PRO");
                let mut datatype = wide("RAW");
                let di = DOC_INFO_1W {
                    pDocName: PWSTR(docname.as_mut_ptr()),
                    pOutputFile: PWSTR::null(),
                    pDatatype: PWSTR(datatype.as_mut_ptr()),
                };
                let job = StartDocPrinterW(hprinter, 1, &di);
                if job == 0 {
                    return Err("StartDocPrinter falhou".into());
                }

                // A partir daqui o documento esta aberto: SEMPRE encerra,
                // mesmo se a pagina ou a escrita falhar (evita job travado
                // na fila do spooler).
                let outcome = (|| -> Result<(), String> {
                    if !StartPagePrinter(hprinter).as_bool() {
                        return Err("StartPagePrinter falhou".into());
                    }
                    let mut offset: usize = 0;
                    while offset < data.len() {
                        let chunk = &data[offset..];
                        let mut written: u32 = 0;
                        let ok = WritePrinter(
                            hprinter,
                            chunk.as_ptr() as *const core::ffi::c_void,
                            chunk.len() as u32,
                            &mut written,
                        );
                        if !ok.as_bool() {
                            return Err("WritePrinter falhou".into());
                        }
                        if written == 0 {
                            return Err(format!(
                                "WritePrinter escreveu 0 bytes ({} de {})",
                                offset,
                                data.len()
                            ));
                        }
                        offset += written as usize;
                    }
                    let _ = EndPagePrinter(hprinter);
                    Ok(())
                })();

                let _ = EndDocPrinter(hprinter);
                outcome
            })();

            let _ = ClosePrinter(hprinter);
            result
        }
    }

    // Abertura de gaveta ESC/POS. A maioria das gavetas usa o pino 2, mas
    // algumas (dependendo do cabo/modelo — Bematech/Elgin/Epson) usam o pino
    // 5. Enviamos os dois pulsos: a gaveta so abre no pino conectado, o outro
    // e ignorado — garantindo compatibilidade entre marcas.
    pub fn open_drawer(printer: &str) -> Result<(), String> {
        let kick: [u8; 10] = [
            0x1B, 0x70, 0x00, 0x19, 0xFA, // ESC p 0 25 250 -> pino 2
            0x1B, 0x70, 0x01, 0x19, 0xFA, // ESC p 1 25 250 -> pino 5
        ];
        print_raw(printer, &kick)
    }
}

#[cfg(not(windows))]
pub mod imp {
    pub fn list_printers() -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    pub fn default_printer() -> Result<String, String> {
        Ok(String::new())
    }
    pub fn print_raw(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("Impressão nativa disponível apenas no Windows".into())
    }
    pub fn open_drawer(_printer: &str) -> Result<(), String> {
        Err("Abertura de gaveta disponível apenas no Windows".into())
    }
}
