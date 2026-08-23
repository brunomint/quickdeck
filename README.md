# QuickDeck

Um painel de atalhos remoto: transforme o celular num controle pro seu
computador, parecido com um Stream Deck físico — só que de graça, rodando na
sua própria rede local.

![Clicando num atalho pelo celular e o programa abrindo no PC](docs/demo.gif)

## O que é

QuickDeck é um app de desktop (Windows, macOS e Linux) que sobe um servidor
na sua rede local. Escaneando um QR code, seu celular vira um controle
remoto: toque num ícone e o programa correspondente abre no computador —
sem precisar de internet, conta ou nuvem, só a mesma rede Wi-Fi.

Nasceu como um projeto pessoal/presente e foi crescendo: hoje tem
sincronização em tempo real entre dispositivos, gerenciamento de janelas
(minimizar, restaurar, fechar), atalhos configuráveis com ícone/emoji, e uma
camada de segurança com token de emparelhamento.

## Principais recursos

- **Atalhos configuráveis** — crie/edite/apague pelo próprio app, escolhendo
  entre os programas já instalados ou digitando o comando manualmente.
- **Abre links direto** — um atalho pode apontar pra uma URL em vez de um
  comando, e abre no navegador padrão.
- **Sincronização em tempo real** — adicionou um atalho num dispositivo? Os
  outros conectados atualizam sozinhos (Server-Sent Events), sem recarregar.
- **Dock de janelas abertas** — veja o que está rodando e minimize, restaure
  ou feche direto pelo celular.

  ![Dock de janelas abertas](docs/screenshot-dock.png)
- **Clique único abre, duplo clique minimiza/restaura** — na própria aba de
  atalhos, um clique sempre abre um programa novo; dois cliques rápidos no
  mesmo ícone minimizam a janela dele (se estiver aberta) ou trazem de volta
  (se já estiver minimizada) — sem precisar trocar de aba.
- **Layout responsivo** — a grade se adapta ao celular em pé ou deitado, com
  paginação estilo Stream Deck físico quando há muitos atalhos.
- **Modo de edição** — os controles de editar/apagar ficam escondidos por
  padrão, evitando toques acidentais; só aparecem quando você "destrava".
- **Emparelhamento por token** — pra que apenas dispositivos autorizados pelo
  QR code (ou o próprio computador) possam disparar ações — sem senha pra
  decorar.

## Como instalar

Baixe o instalador da sua plataforma na [página de
Releases](https://github.com/brunomint/quickdeck/releases/latest):

| Plataforma | Formato |
|---|---|
| Windows | `.exe` (recomendado) ou `.msi` |
| macOS | `.dmg` (universal — Intel e Apple Silicon) |
| Linux | `.deb`, `.rpm`, `.AppImage`, ou rode `instalar.sh` pra detectar sua distro sozinho |

Depois de instalado, abra o QuickDeck, clique em **"Conectar celular"** e
escaneie o QR code com a câmera do celular (precisa estar na mesma rede
Wi-Fi).

![Conectar pelo celular](docs/screenshot-conectar.png)

> **macOS:** como o app não é assinado digitalmente (isso custa uma
> assinatura anual da Apple), na primeira abertura clique com o botão
> direito no ícone e escolha "Abrir" em vez do duplo clique normal.
>
> **Linux:** os recursos de gerenciar janelas (minimizar/fechar) usam
> `wmctrl` e `xdotool` — o `instalar.sh` oferece instalar automaticamente se
> estiverem faltando.

## Tecnologias usadas

- **Backend:** Node.js + Express
- **Frontend:** HTML/JS puro + Tailwind CSS (sem build step)
- **App nativo:** [Tauri](https://tauri.app/) (Rust) — empacota o servidor
  Node numa janela nativa leve, sem o peso do Electron
- **Sincronização:** Server-Sent Events
- **CI:** GitHub Actions compila os instaladores das três plataformas

## Segurança

Um app que abre programas e mexe em janelas remotamente precisa levar
segurança a sério:

- Token de emparelhamento nas rotas que criam atalhos ou disparam ações —
  gerado ao iniciar, embutido no QR code, nunca exposto pra quem não está na
  própria máquina.
- Validação estrita de qualquer identificador de janela antes de montar um
  comando de shell (evita injeção de comando).
- Conteúdo definido pelo usuário (nome de atalho, título de janela) é
  sempre renderizado como texto puro, nunca interpretado como HTML.
- O servidor só expõe os arquivos da interface — nunca o próprio código-fonte
  ou o arquivo de configuração dos atalhos.

## Rodando localmente (dev)

```bash
cd node-js
npm install
node server.js          # sobe o servidor em http://localhost:3000

# opcional: janela nativa via Tauri
cargo install tauri-cli --version "^2"
cargo tauri dev
```

## ☕ Apoie o projeto

Se o QuickDeck foi útil pra você, considere apoiar em
[ko-fi.com/brunofragosodealmeida](https://ko-fi.com/brunofragosodealmeida).

## Licença

[MIT](LICENSE) — use, modifique e distribua à vontade.
