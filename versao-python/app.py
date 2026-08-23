import subprocess
from flask import Flask, jsonify, send_from_directory
from flask_cors import CORS

app = Flask(__name__, static_folder='.')
CORS(app)  # Permite que o celular acesse o servidor sem bloqueios


@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/launch/<app_name>')
def launch_app(app_name):
    try:
        # Dispara o comando no terminal do sistema operacional do computador
        subprocess.Popen(app_name, shell=True)
        return jsonify({'status': 'sucesso', 'opened': app_name})
    except Exception as e:
        return jsonify({'status': 'erro', 'error': str(e)}), 500


@app.route('/apps-abertos')
def apps_abertos():
    # Lista aplicativos abertos (Dock dinâmico). Exemplo focado em macOS via AppleScript.
    # No Linux, troque por algo como subprocess.check_output(['wmctrl', '-l']).
    # No Windows, use PowerShell (ex: 'Get-Process').
    try:
        script = 'tell application "System Events" to get name of every process whose background only is false'
        resultado = subprocess.check_output(['osascript', '-e', script]).decode('utf-8')

        apps = [app_name.strip() for app_name in resultado.split(',')]

        return jsonify({'status': 'sucesso', 'apps': apps})
    except Exception as e:
        return jsonify({'status': 'erro', 'error': str(e)}), 500


if __name__ == '__main__':
    # Roda o servidor aberto na rede local na porta 5000
    app.run(host='0.0.0.0', port=5000, debug=True)
