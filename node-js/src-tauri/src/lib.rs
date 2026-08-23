use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

// Guarda o processo do servidor Node.js pra podermos matá-lo quando a janela
// do app fechar — sem isso, o server.js continua rodando escondido em
// segundo plano depois que o usuário fecha o QuickDeck.
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

      // Sobe o servidor Node.js (server.js) que fica em node-js/, um nível
      // acima da pasta src-tauri, antes de a janela carregar a interface.
      // A janela carrega o index.html empacotado, mas todos os fetch()
      // dessa página batem em http://localhost:3000, então o servidor
      // precisa estar de pé.
      let child = Command::new("node")
        .arg("server.js")
        .current_dir("..")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("Falha ao iniciar o servidor Node.js (server.js). Verifique se o Node está instalado.");

      app.manage(ServidorNode(Mutex::new(Some(child))));

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app_handle, event| {
      // Ao fechar a janela (ou sair do app), mata o servidor Node junto —
      // sem isso, o server.js fica rodando escondido em segundo plano.
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
