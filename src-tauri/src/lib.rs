// System PDV PRO — casca desktop (Tauri 2).
// Responsavel por: persistir config (modo/servidor/identificador), expor
// hostname, e iniciar o servidor de rede embutido (Node + better-sqlite3)
// quando esta maquina e o "Servidor". O front-end (index.html/app.html)
// permanece inalterado e conversa com o servidor em http://localhost:8765.

use std::fs;
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, State};

mod printing;

const SERVER_PORT: &str = "8765";

#[derive(Default)]
struct ServerState {
    child: Mutex<Option<Child>>,
}

// ---------------------------- util de paths ---------------------------
fn config_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .expect("nao foi possivel resolver app_config_dir");
    fs::create_dir_all(&dir).ok();
    dir.join("config.json")
}

fn sync_installation_config(app: &AppHandle) -> Result<(), String> {
    let marker = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|dir| dir.join("install-stamp.txt"));
    let Some(marker) = marker else {
        return Ok(());
    };
    let stamp = match fs::read(&marker) {
        Ok(value) => value,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };

    let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let seen_path = config_dir.join("install-stamp.txt");
    if fs::read(&seen_path).ok().as_deref() == Some(stamp.as_slice()) {
        return Ok(());
    }

    let config = config_dir.join("config.json");
    match fs::remove_file(config) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    fs::write(seen_path, stamp).map_err(|e| e.to_string())
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("nao foi possivel resolver app_data_dir")
        .join("data");
    fs::create_dir_all(&dir).ok();
    dir
}

fn log_path(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_log_dir()
        .unwrap_or_else(|_| app.path().app_data_dir().unwrap().join("logs"));
    fs::create_dir_all(&dir).ok();
    dir.join("server.log")
}

fn read_config(app: &AppHandle) -> Map<String, Value> {
    let p = config_path(app);
    match fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str::<Map<String, Value>>(&s).unwrap_or_default(),
        Err(_) => Map::new(),
    }
}

fn write_config(app: &AppHandle, cfg: &Map<String, Value>) -> Result<(), String> {
    let p = config_path(app);
    let s = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    fs::write(&p, s).map_err(|e| e.to_string())
}

// Resolve o node.exe e o server.js. Em producao usa os recursos empacotados
// (resources/node.exe + resources/server/server.js). Em dev (rodando da
// arvore do projeto) procura ../server/server.js e usa o `node` do PATH.
// Pode ser sobrescrito por PDV_NODE_BIN / PDV_SERVER_JS.
fn resolve_node_and_server(app: &AppHandle) -> (PathBuf, PathBuf) {
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };

    // ---- node binary ----
    let mut node_bin: PathBuf = PathBuf::from(node_name);
    if let Ok(env_node) = std::env::var("PDV_NODE_BIN") {
        if !env_node.is_empty() {
            node_bin = PathBuf::from(env_node);
        }
    } else if let Ok(base) = app.path().resource_dir() {
        let candidate = base.join("resources").join(node_name);
        if candidate.exists() {
            node_bin = candidate;
        }
    }

    // ---- server.js ----
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(env_srv) = std::env::var("PDV_SERVER_JS") {
        if !env_srv.is_empty() {
            candidates.push(PathBuf::from(env_srv));
        }
    }
    if let Ok(base) = app.path().resource_dir() {
        candidates.push(base.join("resources").join("server").join("server.js"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // dev: target/debug/<app> -> sobe ate a raiz do repo
            candidates.push(dir.join("server").join("server.js"));
            for up in [1usize, 2, 3, 4] {
                let mut p = dir.to_path_buf();
                for _ in 0..up {
                    p = p.parent().map(|x| x.to_path_buf()).unwrap_or(p);
                }
                candidates.push(p.join("server").join("server.js"));
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("server").join("server.js"));
        candidates.push(cwd.join("..").join("server").join("server.js"));
    }

    let server_js = candidates
        .into_iter()
        .find(|p| p.exists())
        .unwrap_or_else(|| PathBuf::from("server/server.js"));

    (node_bin, server_js)
}

// ------------------------------ comandos ------------------------------
#[tauri::command]
fn get_config(app: AppHandle) -> Value {
    Value::Object(read_config(&app))
}

#[tauri::command]
fn save_config(app: AppHandle, config: Value) -> Result<(), String> {
    let mut cfg = read_config(&app);
    if let Value::Object(incoming) = config {
        for (k, v) in incoming {
            cfg.insert(k, v);
        }
    }
    write_config(&app, &cfg)
}

#[tauri::command]
fn ensure_identificador(app: AppHandle) -> Result<String, String> {
    let mut cfg = read_config(&app);
    if let Some(Value::String(id)) = cfg.get("identificador") {
        if !id.is_empty() {
            return Ok(id.clone());
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    cfg.insert("identificador".into(), Value::String(id.clone()));
    write_config(&app, &cfg)?;
    Ok(id)
}

#[tauri::command]
fn hostname() -> String {
    // Sem dependencia externa: usa variaveis de ambiente comuns e cai para
    // o crate gethostname via std se necessario.
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.is_empty() {
            return h;
        }
    }
    "pdv-host".to_string()
}

#[tauri::command]
fn start_embedded_server(app: AppHandle, state: State<ServerState>) -> Result<(), String> {
    // O servidor continua em segundo plano quando a janela do Servidor fecha.
    // Ao reabrir o app, reutiliza o processo que ja atende a porta da rede.
    let addr = SocketAddr::from(([127, 0, 0, 1], 8765));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok() {
        return Ok(());
    }

    // Idempotente dentro desta mesma instancia do desktop.
    {
        let mut guard = state.child.lock().unwrap();
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()), // ainda rodando
                _ => {
                    *guard = None;
                }
            }
        }
    }

    let (node_bin, server_js) = resolve_node_and_server(&app);
    let data = data_dir(&app);
    let log = log_path(&app);

    let log_file = fs::File::create(&log).map_err(|e| e.to_string())?;
    let err_file = log_file.try_clone().map_err(|e| e.to_string())?;

    let mut cmd = Command::new(&node_bin);
    cmd.arg(&server_js)
        .env("PDV_PORT", SERVER_PORT)
        .env("PDV_HOST", "0.0.0.0")
        .env("PDV_DATA_DIR", &data)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(err_file));

    // Diretorio de trabalho = pasta do server (acha node_modules).
    if let Some(parent) = server_js.parent() {
        cmd.current_dir(parent);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| {
        format!(
            "falha ao iniciar o servidor ({}): {}",
            node_bin.display(),
            e
        )
    })?;

    *state.child.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
fn list_printers() -> Result<Vec<String>, String> {
    printing::imp::list_printers()
}

#[tauri::command]
fn print_raw(printer: String, data: Vec<u8>) -> Result<(), String> {
    printing::imp::print_raw(&printer, &data)
}

#[tauri::command]
fn open_drawer(printer: String) -> Result<(), String> {
    printing::imp::open_drawer(&printer)
}

// Grava bytes (ex.: backup .db) numa pasta escolhida pelo usuario, usando o
// sistema de arquivos nativo. Evita a API File System Access do navegador,
// que no WebView exibe prompts de permissao a cada gravacao.
#[tauri::command]
fn save_file_bytes(dir: String, filename: String, data: Vec<u8>) -> Result<String, String> {
    let d = PathBuf::from(&dir);
    fs::create_dir_all(&d).map_err(|e| format!("criar pasta '{}': {}", dir, e))?;
    // Sanitiza o nome do arquivo (sem separadores de caminho).
    let safe: String = filename
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let full = d.join(&safe);
    fs::write(&full, &data).map_err(|e| format!("gravar '{}': {}", full.display(), e))?;
    Ok(full.to_string_lossy().to_string())
}

#[tauri::command]
fn read_server_log_tail(app: AppHandle) -> String {
    let p = log_path(&app);
    let file = match fs::File::open(&p) {
        Ok(f) => f,
        Err(_) => return String::new(),
    };
    let reader = BufReader::new(file);
    let lines: Vec<String> = reader.lines().map_while(Result::ok).collect();
    let start = lines.len().saturating_sub(40);
    lines[start..].join("\n")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ServerState::default())
        .setup(|app| {
            let _ = sync_installation_config(app.handle());

            // Garante que a janela principal abra visivel, restaurada (nao
            // minimizada), maximizada e em foco — ao ser iniciada pela tela
            // final do instalador ela vinha minimizada/sem foco.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.maximize();
                let _ = win.set_focus();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            ensure_identificador,
            hostname,
            start_embedded_server,
            read_server_log_tail,
            list_printers,
            print_raw,
            open_drawer,
            save_file_bytes
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o System PDV PRO")
        .run(|_, _| {});
}
