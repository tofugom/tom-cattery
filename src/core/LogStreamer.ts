import * as vscode from 'vscode';

export class LogStreamer {
  private channels = new Map<string, vscode.OutputChannel>();

  getChannel(serverName: string): vscode.OutputChannel {
    let channel = this.channels.get(serverName);
    if (!channel) {
      channel = vscode.window.createOutputChannel(`Tom Cattery: ${serverName}`);
      this.channels.set(serverName, channel);
    }
    return channel;
  }

  show(serverName: string): void {
    this.getChannel(serverName).show(true);
  }

  disposeChannel(serverName: string): void {
    const channel = this.channels.get(serverName);
    if (channel) {
      channel.dispose();
      this.channels.delete(serverName);
    }
  }

  disposeAll(): void {
    for (const channel of this.channels.values()) {
      channel.dispose();
    }
    this.channels.clear();
  }
}
