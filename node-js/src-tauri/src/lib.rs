use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// O servidor compilado com 'pkg' é um executável de console — sem essa
// flag, o Windows abre uma janela de console preta pra ele junto com o
// app, mesmo ele rodando em segundo plano.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

// Guarda o processo do servidor pra podermos matá-lo quando a janela do
// app fechar — sem isso, ele continua rodando escondido em segundo plano
// depois que o usuário fecha o QuickDeck.
struct ServidorNode(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // Pasta de dados do usuário (sempre gravável, diferente da pasta de
      // instalação — que em muitos SOs exige permissão de administrador).
      // É onde o atalhos.json de verdade fica salvo.
      let dir_dados = app
        .path()
        .app_data_dir()
        .expect("Não consegui achar a pasta de dados do usuário");
      std::fs::create_dir_all(&dir_dados)
        .expect("Não consegui criar a pasta de dados do usuário");

      // O binário do servidor ("sidecar") vem empacotado na mesma pasta do
      // próprio executável do QuickDeck — funciona tanto em desenvolvimento
      // quanto depois de instalado, sem depender de o usuário ter Node.js.
      // Usamos Command puro (não o plugin de shell do Tauri) porque a
      // captura de saída por pipe do plugin, combinada com o jeito que o
      // Tauri "assina"/empacota o binário principal pro instalador, fazia o
      // executável do servidor (compilado com 'pkg') falhar ao ler o
      // próprio conteúdo embutido — testado e confirmado que só acontecia
      // assim, nunca rodando ele puro.
      let exe_atual =
        std::env::current_exe().expect("Não consegui achar o caminho do próprio executável");
      let pasta_exe = exe_atual.parent().expect("Executável sem pasta pai");
      let nome_servidor = if cfg!(windows) { "servidor.exe" } else { "servidor" };
      let caminho_servidor = pasta_exe.join(nome_servidor);

      let mut comando = Command::new(&caminho_servidor);
      comando
        .current_dir(&dir_dados)
        .env("QUICKDECK_DATA_DIR", dir_dados.to_string_lossy().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

      #[cfg(windows)]
      comando.creation_flags(CREATE_NO_WINDOW);

      let child = comando
        .spawn()
        .expect("Falha ao iniciar o servidor do QuickDeck");

      app.manage(ServidorNode(Mutex::new(Some(child))));

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Ao fechar a janela (ou sair do app), mata o servidor junto — sem
      // isso, ele fica rodando escondido em segundo plano.
      if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
        if let Some(state) = app_handle.try_state::<ServidorNode>() {
          if let Ok(mut guard) = state.0.lock() {
            if let Some(mut child) = guard.take() {
              let _ = child.kill();
            }
          }
        }
      }
    });
}
