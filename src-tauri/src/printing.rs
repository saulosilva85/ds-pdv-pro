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

    pub fn list_printers() -> Result<Vec<String>, String> {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-PnpDevice -Class PrintQueue -PresentOnly -Status OK -ErrorAction Stop | ForEach-Object { $_.FriendlyName }";
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

    pub fn print_raw(printer: &str, data: &[u8]) -> Result<(), String> {
        unsafe {
            let pname = wide(printer);
            let mut hprinter = HANDLE::default();
            OpenPrinterW(PCWSTR(pname.as_ptr()), &mut hprinter, None)
                .map_err(|e| format!("OpenPrinter('{}'): {}", printer, e))?;

            let result = (|| -> Result<(), String> {
                let mut docname = wide("Cupom System PDV PRO");
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
                if !StartPagePrinter(hprinter).as_bool() {
                    return Err("StartPagePrinter falhou".into());
                }
                let mut written: u32 = 0;
                let ok = WritePrinter(
                    hprinter,
                    data.as_ptr() as *const core::ffi::c_void,
                    data.len() as u32,
                    &mut written,
                );
                let _ = EndPagePrinter(hprinter);
                let _ = EndDocPrinter(hprinter);
                if !ok.as_bool() {
                    return Err("WritePrinter falhou".into());
                }
                if written as usize != data.len() {
                    return Err(format!(
                        "WritePrinter escreveu {} de {} bytes",
                        written,
                        data.len()
                    ));
                }
                Ok(())
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
    pub fn print_raw(_printer: &str, _data: &[u8]) -> Result<(), String> {
        Err("Impressão nativa disponível apenas no Windows".into())
    }
    pub fn open_drawer(_printer: &str) -> Result<(), String> {
        Err("Abertura de gaveta disponível apenas no Windows".into())
    }
}
