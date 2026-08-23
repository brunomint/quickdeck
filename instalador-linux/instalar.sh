#!/usr/bin/env bash
# Instalador do QuickDeck pra Linux — baixa a versão mais recente direto do
# GitHub e instala sozinho, detectando sua distro. Não precisa baixar nada
# na mão antes, só rodar este script.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/brunomint/quickdeck/main/instalador-linux/instalar.sh | bash
# ou baixe e rode: bash instalar.sh

set -euo pipefail

REPO="brunomint/quickdeck"
API_RELEASE="https://api.github.com/repos/$REPO/releases/latest"

echo "=== Instalador do QuickDeck ==="
echo

if ! command -v curl >/dev/null 2>&1; then
    echo "Precisa do 'curl' instalado pra baixar os arquivos. Instale com o gerenciador de pacotes da sua distro e rode de novo."
    exit 1
fi

echo "Consultando a versão mais recente no GitHub..."
ASSETS_JSON="$(curl -fsSL "$API_RELEASE")"

# Extrai a URL de download do primeiro asset cujo nome bate com o padrão
# passado (ex: '_amd64\.deb$') — evita depender de 'jq', que nem sempre
# vem instalado por padrão.
url_do_asset() {
    printf '%s\n' "$ASSETS_JSON" \
        | grep -oE '"browser_download_url": *"[^"]+"' \
        | sed -E 's/.*"(https:[^"]+)"/\1/' \
        | grep -E "$1" \
        | head -n1 || true
}

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT
cd "$TMPDIR"

instalar_dependencias_janelas() {
    # wmctrl e xdotool são usados pra listar/fechar/minimizar janelas na aba
    # "Recentes / Dock". Sem eles o resto do app funciona, só essa parte não.
    local faltando=()
    command -v wmctrl >/dev/null 2>&1 || faltando+=(wmctrl)
    command -v xdotool >/dev/null 2>&1 || faltando+=(xdotool)

    if [ ${#faltando[@]} -eq 0 ]; then
        return
    fi

    echo "Pra minimizar/fechar janelas pela aba 'Recentes', o QuickDeck também precisa de: ${faltando[*]}"
    read -r -p "Instalar agora? [S/n] " resposta
    if [[ "$resposta" =~ ^[Nn]$ ]]; then
        echo "Ok, pulando — você pode instalar depois com o gerenciador de pacotes da sua distro."
        return
    fi

    if command -v apt-get >/dev/null 2>&1; then
        sudo apt-get install -y "${faltando[@]}"
    elif command -v dnf >/dev/null 2>&1; then
        sudo dnf install -y "${faltando[@]}"
    elif command -v zypper >/dev/null 2>&1; then
        sudo zypper install -y "${faltando[@]}"
    elif command -v pacman >/dev/null 2>&1; then
        sudo pacman -S --noconfirm "${faltando[@]}"
    else
        echo "Não reconheci o gerenciador de pacotes — instale manualmente: ${faltando[*]}"
    fi
}

instalar_appimage() {
    local url
    url="$(url_do_asset '_amd64\.AppImage$')"
    if [ -z "$url" ]; then
        echo "Não achei um .AppImage na última Release. Baixe manualmente em:"
        echo "https://github.com/$REPO/releases/latest"
        exit 1
    fi

    echo "Baixando o AppImage (funciona em qualquer distro Linux)..."
    curl -fsSL -o quickdeck.AppImage "$url"
    chmod +x quickdeck.AppImage

    local destino="$HOME/Applications"
    mkdir -p "$destino"
    cp quickdeck.AppImage "$destino/QuickDeck.AppImage"

    # AppImage sozinho não aparece no menu de aplicativos — baixa o ícone e
    # cria o atalho manualmente.
    local dir_icones="$HOME/.local/share/icons"
    local dir_atalhos="$HOME/.local/share/applications"
    mkdir -p "$dir_icones" "$dir_atalhos"

    local url_icone
    url_icone="$(url_do_asset 'quickdeck\.png$')"
    [ -n "$url_icone" ] && curl -fsSL -o "$dir_icones/quickdeck.png" "$url_icone"

    cat > "$dir_atalhos/quickdeck.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=QuickDeck
Comment=Painel de atalhos remoto (celular -> computador)
Exec=$destino/QuickDeck.AppImage
Icon=$dir_icones/quickdeck.png
Categories=Utility;
Terminal=false
EOF

    command -v update-desktop-database >/dev/null 2>&1 && \
        update-desktop-database "$dir_atalhos" >/dev/null 2>&1 || true

    echo "Pronto! O QuickDeck já aparece no menu de aplicativos."
}

# --- Detecta a distro, baixa e instala o formato certo ---
if command -v apt-get >/dev/null 2>&1; then
    url="$(url_do_asset '_amd64\.deb$')"
    if [ -z "$url" ]; then
        echo "Não achei um .deb na última Release. Baixe manualmente em: https://github.com/$REPO/releases/latest"
        exit 1
    fi
    echo "Detectei uma distro baseada em Debian/Ubuntu — baixando o pacote .deb..."
    curl -fsSL -o quickdeck.deb "$url"
    sudo apt-get install -y ./quickdeck.deb
elif command -v dnf >/dev/null 2>&1; then
    url="$(url_do_asset '\.x86_64\.rpm$')"
    if [ -z "$url" ]; then
        echo "Não achei um .rpm na última Release. Baixe manualmente em: https://github.com/$REPO/releases/latest"
        exit 1
    fi
    echo "Detectei uma distro baseada em Fedora — baixando o pacote .rpm..."
    curl -fsSL -o quickdeck.rpm "$url"
    sudo dnf install -y ./quickdeck.rpm
elif command -v zypper >/dev/null 2>&1; then
    url="$(url_do_asset '\.x86_64\.rpm$')"
    if [ -z "$url" ]; then
        echo "Não achei um .rpm na última Release. Baixe manualmente em: https://github.com/$REPO/releases/latest"
        exit 1
    fi
    echo "Detectei openSUSE — baixando o pacote .rpm..."
    curl -fsSL -o quickdeck.rpm "$url"
    sudo zypper install -y ./quickdeck.rpm
else
    instalar_appimage
fi

echo
instalar_dependencias_janelas

echo
echo "Instalação concluída! Procure por 'QuickDeck' no menu de aplicativos."
