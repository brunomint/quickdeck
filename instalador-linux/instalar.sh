#!/usr/bin/env bash
# Instalador do QuickDeck pra Linux — detecta sua distro e instala o pacote
# certo automaticamente, ou usa o AppImage como alternativa universal se a
# distro não for baseada em Debian/Fedora, criando um atalho no menu de
# aplicativos mesmo assim.
#
# Uso: ./instalar.sh (dentro da pasta que veio com o .deb/.rpm/.AppImage)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "=== Instalador do QuickDeck ==="
echo

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
    local appimage
    appimage="$(ls ./*.AppImage 2>/dev/null | head -n1)"
    if [ -z "$appimage" ]; then
        echo "Não achei um arquivo .AppImage nessa pasta."
        exit 1
    fi

    echo "Instalando via AppImage (funciona em qualquer distro Linux)..."

    local destino="$HOME/Applications"
    mkdir -p "$destino"
    cp "$appimage" "$destino/QuickDeck.AppImage"
    chmod +x "$destino/QuickDeck.AppImage"

    # AppImage sozinho não aparece no menu de aplicativos — cria o atalho
    # manualmente (ícone incluso nessa mesma pasta).
    local dir_icones="$HOME/.local/share/icons"
    local dir_atalhos="$HOME/.local/share/applications"
    mkdir -p "$dir_icones" "$dir_atalhos"
    if [ -f "./quickdeck.png" ]; then
        cp "./quickdeck.png" "$dir_icones/quickdeck.png"
    fi

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

# --- Detecta a distro e escolhe o formato certo ---
if command -v apt-get >/dev/null 2>&1 && ls ./*.deb >/dev/null 2>&1; then
    echo "Detectei uma distro baseada em Debian/Ubuntu — instalando o pacote .deb..."
    sudo apt-get install -y "$(ls ./*.deb | head -n1)"
elif command -v dnf >/dev/null 2>&1 && ls ./*.rpm >/dev/null 2>&1; then
    echo "Detectei uma distro baseada em Fedora — instalando o pacote .rpm..."
    sudo dnf install -y "$(ls ./*.rpm | head -n1)"
elif command -v zypper >/dev/null 2>&1 && ls ./*.rpm >/dev/null 2>&1; then
    echo "Detectei openSUSE — instalando o pacote .rpm..."
    sudo zypper install -y "$(ls ./*.rpm | head -n1)"
else
    instalar_appimage
fi

echo
instalar_dependencias_janelas

echo
echo "Instalação concluída! Procure por 'QuickDeck' no menu de aplicativos."
