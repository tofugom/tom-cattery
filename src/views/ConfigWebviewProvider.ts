import * as vscode from 'vscode';
import { TomcatInstance, PortConfig, DebugConfig } from '../types';
import { InstanceManager } from '../core/InstanceManager';
import { ProcessManager } from '../core/ProcessManager';

interface ConfigMessage {
  command: string;
  [key: string]: any;
}

export class ConfigWebviewProvider {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private instanceManager: InstanceManager,
    private processManager: ProcessManager,
  ) {}

  openConfig(instance: TomcatInstance): void {
    const existing = this.panels.get(instance.name);
    if (existing) {
      existing.reveal();
      existing.webview.postMessage({ command: 'loadConfig', data: this.serializeInstance(instance) });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'tomCatteryConfig',
      `Config: ${instance.name}`,
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panels.set(instance.name, panel);

    panel.webview.html = this.getHtmlForWebview(instance);

    panel.webview.onDidReceiveMessage(
      (msg: ConfigMessage) => this.handleMessage(msg, instance, panel),
    );

    panel.onDidDispose(() => {
      this.panels.delete(instance.name);
    });
  }

  private serializeInstance(instance: TomcatInstance) {
    return {
      name: instance.name,
      runtimePath: instance.runtimePath,
      javaHome: instance.javaHome,
      ports: { ...instance.ports },
      jvmArgs: instance.jvmArgs,
      envVars: { ...instance.envVars },
      debug: { ...instance.debug },
      status: instance.status,
    };
  }

  private async handleMessage(
    msg: ConfigMessage,
    instance: TomcatInstance,
    panel: vscode.WebviewPanel,
  ): Promise<void> {
    switch (msg.command) {
      case 'loadConfig': {
        const current = this.instanceManager.getInstance(instance.name);
        if (current) {
          panel.webview.postMessage({ command: 'loadConfig', data: this.serializeInstance(current) });
        }
        break;
      }

      case 'saveConfig': {
        try {
          await this.applyConfigData(instance, msg.data);
          await this.instanceManager.saveFullConfig(instance);
          panel.webview.postMessage({ command: 'saveResult', success: true });

          if (this.processManager.isRunning(instance.name)) {
            vscode.window.showWarningMessage(
              `Server "${instance.name}" is running. Restart required for changes to take effect.`,
              'Restart Now',
            ).then(action => {
              if (action === 'Restart Now') {
                this.processManager.restartServer(instance);
              }
            });
          } else {
            vscode.window.showInformationMessage(`Configuration saved for "${instance.name}".`);
          }
        } catch (err: any) {
          panel.webview.postMessage({ command: 'saveResult', success: false, error: err.message });
          vscode.window.showErrorMessage(`Failed to save config: ${err.message}`);
        }
        break;
      }

      case 'applyAndRestart': {
        try {
          await this.applyConfigData(instance, msg.data);
          await this.instanceManager.saveFullConfig(instance);
          panel.webview.postMessage({ command: 'saveResult', success: true });

          if (this.processManager.isRunning(instance.name)) {
            vscode.window.showInformationMessage(`Configuration saved. Restarting "${instance.name}"...`);
            await this.processManager.restartServer(instance);
          } else {
            vscode.window.showInformationMessage(`Configuration saved for "${instance.name}".`);
          }
        } catch (err: any) {
          panel.webview.postMessage({ command: 'saveResult', success: false, error: err.message });
          vscode.window.showErrorMessage(`Failed to apply config: ${err.message}`);
        }
        break;
      }

      case 'browseJavaHome': {
        const uri = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Select JAVA_HOME',
        });
        if (uri && uri.length > 0) {
          panel.webview.postMessage({ command: 'javaHomePath', path: uri[0].fsPath });
        }
        break;
      }
    }
  }

  private applyConfigData(instance: TomcatInstance, data: any): void {
    instance.javaHome = data.javaHome || instance.javaHome;
    instance.ports = {
      http: parseInt(data.ports.http) || instance.ports.http,
      https: parseInt(data.ports.https) || instance.ports.https,
      shutdown: parseInt(data.ports.shutdown) || instance.ports.shutdown,
      ajp: parseInt(data.ports.ajp) || instance.ports.ajp,
      debug: parseInt(data.ports.debug) || instance.ports.debug,
    };
    instance.jvmArgs = (data.jvmArgs || []).filter((a: string) => a.trim());
    instance.envVars = data.envVars || {};
    instance.debug = {
      ...instance.debug,
      suspend: !!data.debug.suspend,
      autoAttach: !!data.debug.autoAttach,
      port: instance.ports.debug,
    };
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  private getHtmlForWebview(instance: TomcatInstance): string {
    const data = JSON.stringify(this.serializeInstance(instance));

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Config: ${this.escapeHtml(instance.name)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 24px;
  }
  h1 {
    font-size: 1.4em;
    font-weight: 600;
    margin-bottom: 20px;
    color: var(--vscode-foreground);
  }
  h2 {
    font-size: 1.1em;
    font-weight: 600;
    margin: 20px 0 10px 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #444));
    color: var(--vscode-foreground);
  }
  .section { margin-bottom: 16px; }
  .field {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
    gap: 8px;
  }
  .field label {
    min-width: 120px;
    font-weight: 500;
    color: var(--vscode-foreground);
  }
  input[type="text"], input[type="number"] {
    flex: 1;
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #444));
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    outline: none;
  }
  input:focus {
    border-color: var(--vscode-focusBorder);
  }
  input[readonly] {
    opacity: 0.7;
    cursor: default;
  }
  textarea {
    width: 100%;
    min-height: 100px;
    padding: 6px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, #444));
    border-radius: 2px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
    resize: vertical;
    outline: none;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  button {
    padding: 6px 14px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn-row {
    margin-top: 20px;
    display: flex;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, #444));
  }
  .env-table { width: 100%; border-collapse: collapse; }
  .env-table th {
    text-align: left;
    padding: 4px 8px;
    font-weight: 500;
    color: var(--vscode-foreground);
    border-bottom: 1px solid var(--vscode-widget-border, #444);
  }
  .env-table td { padding: 4px 8px; }
  .env-table input { width: 100%; }
  .env-table .remove-btn {
    padding: 2px 8px;
    background: transparent;
    color: var(--vscode-errorForeground, #f44);
    border: 1px solid var(--vscode-errorForeground, #f44);
    border-radius: 2px;
    cursor: pointer;
    font-size: 0.85em;
  }
  .env-table .remove-btn:hover {
    background: var(--vscode-errorForeground, #f44);
    color: var(--vscode-editor-background);
  }
  .add-btn {
    margin-top: 4px;
    padding: 4px 10px;
    font-size: 0.9em;
  }
  .toggle-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
  }
  .toggle-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--vscode-focusBorder);
  }
  .status-msg {
    margin-top: 8px;
    padding: 6px 10px;
    border-radius: 3px;
    font-size: 0.9em;
    display: none;
  }
  .status-msg.success {
    display: block;
    background: var(--vscode-inputValidation-infoBackground, #063b49);
    border: 1px solid var(--vscode-inputValidation-infoBorder, #007acc);
  }
  .status-msg.error {
    display: block;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  }
</style>
</head>
<body>
  <h1>Server Configuration: ${this.escapeHtml(instance.name)}</h1>

  <div class="section">
    <h2>General</h2>
    <div class="field">
      <label>Server Name</label>
      <input type="text" id="serverName" readonly />
    </div>
    <div class="field">
      <label>Runtime Path</label>
      <input type="text" id="runtimePath" readonly />
    </div>
    <div class="field">
      <label>JAVA_HOME</label>
      <input type="text" id="javaHome" />
      <button class="secondary" id="browseJavaHome">Browse...</button>
    </div>
  </div>

  <div class="section">
    <h2>Ports</h2>
    <div class="field">
      <label>HTTP</label>
      <input type="number" id="portHttp" min="1" max="65535" />
    </div>
    <div class="field">
      <label>HTTPS</label>
      <input type="number" id="portHttps" min="1" max="65535" />
    </div>
    <div class="field">
      <label>Shutdown</label>
      <input type="number" id="portShutdown" min="1" max="65535" />
    </div>
    <div class="field">
      <label>AJP</label>
      <input type="number" id="portAjp" min="1" max="65535" />
    </div>
    <div class="field">
      <label>Debug</label>
      <input type="number" id="portDebug" min="1" max="65535" />
    </div>
  </div>

  <div class="section">
    <h2>JVM Options</h2>
    <p style="margin-bottom:6px; opacity:0.8; font-size:0.9em;">One option per line (e.g. -Xms256m)</p>
    <textarea id="jvmArgs" spellcheck="false"></textarea>
  </div>

  <div class="section">
    <h2>Environment Variables</h2>
    <table class="env-table">
      <thead><tr><th>Key</th><th>Value</th><th></th></tr></thead>
      <tbody id="envVarsBody"></tbody>
    </table>
    <button class="secondary add-btn" id="addEnvVar">+ Add Variable</button>
  </div>

  <div class="section">
    <h2>Debug</h2>
    <div class="toggle-row">
      <input type="checkbox" id="debugSuspend" />
      <label for="debugSuspend">Suspend on start (wait for debugger)</label>
    </div>
    <div class="toggle-row">
      <input type="checkbox" id="debugAutoAttach" />
      <label for="debugAutoAttach">Auto-attach debugger</label>
    </div>
  </div>

  <div id="statusMsg" class="status-msg"></div>

  <div class="btn-row">
    <button id="btnSave">Save</button>
    <button id="btnApplyRestart" class="secondary">Save &amp; Restart</button>
  </div>

<script>
  const vscode = acquireVsCodeApi();
  let config = ${data};

  function populateForm(data) {
    config = data;
    document.getElementById('serverName').value = data.name;
    document.getElementById('runtimePath').value = data.runtimePath;
    document.getElementById('javaHome').value = data.javaHome || '';
    document.getElementById('portHttp').value = data.ports.http;
    document.getElementById('portHttps').value = data.ports.https;
    document.getElementById('portShutdown').value = data.ports.shutdown;
    document.getElementById('portAjp').value = data.ports.ajp;
    document.getElementById('portDebug').value = data.ports.debug;
    document.getElementById('jvmArgs').value = (data.jvmArgs || []).join('\\n');
    document.getElementById('debugSuspend').checked = data.debug.suspend;
    document.getElementById('debugAutoAttach').checked = data.debug.autoAttach;
    renderEnvVars(data.envVars || {});
  }

  function renderEnvVars(envVars) {
    const tbody = document.getElementById('envVarsBody');
    tbody.innerHTML = '';
    for (const [key, value] of Object.entries(envVars)) {
      addEnvVarRow(key, value);
    }
  }

  function addEnvVarRow(key, value) {
    const tbody = document.getElementById('envVarsBody');
    const tr = document.createElement('tr');
    tr.innerHTML =
      '<td><input type="text" class="env-key" value="' + escapeAttr(key || '') + '" placeholder="KEY" /></td>' +
      '<td><input type="text" class="env-val" value="' + escapeAttr(value || '') + '" placeholder="value" /></td>' +
      '<td><button class="remove-btn" onclick="this.closest(\\'tr\\').remove()">Remove</button></td>';
    tbody.appendChild(tr);
  }

  function escapeAttr(s) {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function collectData() {
    const jvmText = document.getElementById('jvmArgs').value;
    const jvmArgs = jvmText.split('\\n').map(l => l.trim()).filter(Boolean);

    const envVars = {};
    document.querySelectorAll('#envVarsBody tr').forEach(tr => {
      const key = tr.querySelector('.env-key').value.trim();
      const val = tr.querySelector('.env-val').value;
      if (key) { envVars[key] = val; }
    });

    return {
      javaHome: document.getElementById('javaHome').value,
      ports: {
        http: document.getElementById('portHttp').value,
        https: document.getElementById('portHttps').value,
        shutdown: document.getElementById('portShutdown').value,
        ajp: document.getElementById('portAjp').value,
        debug: document.getElementById('portDebug').value,
      },
      jvmArgs,
      envVars,
      debug: {
        suspend: document.getElementById('debugSuspend').checked,
        autoAttach: document.getElementById('debugAutoAttach').checked,
      },
    };
  }

  function showStatus(msg, isError) {
    const el = document.getElementById('statusMsg');
    el.textContent = msg;
    el.className = 'status-msg ' + (isError ? 'error' : 'success');
    if (!isError) {
      setTimeout(() => { el.className = 'status-msg'; }, 3000);
    }
  }

  document.getElementById('btnSave').addEventListener('click', () => {
    vscode.postMessage({ command: 'saveConfig', data: collectData() });
  });

  document.getElementById('btnApplyRestart').addEventListener('click', () => {
    vscode.postMessage({ command: 'applyAndRestart', data: collectData() });
  });

  document.getElementById('browseJavaHome').addEventListener('click', () => {
    vscode.postMessage({ command: 'browseJavaHome' });
  });

  document.getElementById('addEnvVar').addEventListener('click', () => {
    addEnvVarRow('', '');
  });

  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.command) {
      case 'loadConfig':
        populateForm(msg.data);
        break;
      case 'saveResult':
        if (msg.success) {
          showStatus('Configuration saved successfully.', false);
        } else {
          showStatus('Save failed: ' + (msg.error || 'Unknown error'), true);
        }
        break;
      case 'javaHomePath':
        document.getElementById('javaHome').value = msg.path;
        break;
    }
  });

  // Initial populate
  populateForm(config);
</script>
</body>
</html>`;
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
