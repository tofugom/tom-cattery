import * as fs from 'fs/promises';
import { PortConfig } from '../types';

export class ConfigParser {
  static async patchServerXmlPorts(xmlPath: string, ports: PortConfig): Promise<void> {
    let content = await fs.readFile(xmlPath, 'utf-8');

    // <Server port="8005" shutdown="SHUTDOWN">
    content = content.replace(
      /(<Server\s[^>]*port=")8005(")/,
      `$1${ports.shutdown}$2`,
    );

    // <Connector port="8080" protocol="HTTP/1.1"
    content = content.replace(
      /(<Connector\s[^>]*port=")8080(")/,
      `$1${ports.http}$2`,
    );

    // redirectPort="8443" (appears in HTTP and AJP connectors)
    content = content.replace(
      /redirectPort="8443"/g,
      `redirectPort="${ports.https}"`,
    );

    // <Connector port="8443" (HTTPS, often commented out)
    content = content.replace(
      /(port=")8443(")/g,
      `$1${ports.https}$2`,
    );

    // AJP port="8009" (often commented out)
    content = content.replace(
      /(port=")8009(")/g,
      `$1${ports.ajp}$2`,
    );

    await fs.writeFile(xmlPath, content, 'utf-8');
  }

  /**
   * Update server.xml ports from oldPorts to newPorts.
   * Unlike patchServerXmlPorts (which assumes default Tomcat ports),
   * this replaces previously-set custom port values.
   */
  static async updateServerXmlPorts(
    xmlPath: string,
    oldPorts: PortConfig,
    newPorts: PortConfig,
  ): Promise<void> {
    let content = await fs.readFile(xmlPath, 'utf-8');

    // Shutdown port: <Server port="XXXX"
    if (oldPorts.shutdown !== newPorts.shutdown) {
      content = content.replace(
        new RegExp(`(<Server\\s[^>]*port=")${oldPorts.shutdown}(")`),
        `$1${newPorts.shutdown}$2`,
      );
    }

    // HTTP port: <Connector port="XXXX" protocol="HTTP/1.1"
    if (oldPorts.http !== newPorts.http) {
      content = content.replace(
        new RegExp(`(<Connector\\s[^>]*port=")${oldPorts.http}("[^>]*protocol="HTTP)`),
        `$1${newPorts.http}$2`,
      );
    }

    // HTTPS / redirectPort
    if (oldPorts.https !== newPorts.https) {
      content = content.replace(
        new RegExp(`redirectPort="${oldPorts.https}"`, 'g'),
        `redirectPort="${newPorts.https}"`,
      );
      content = content.replace(
        new RegExp(`(port=")${oldPorts.https}(")`, 'g'),
        `$1${newPorts.https}$2`,
      );
    }

    // AJP port
    if (oldPorts.ajp !== newPorts.ajp) {
      content = content.replace(
        new RegExp(`(port=")${oldPorts.ajp}(")`, 'g'),
        `$1${newPorts.ajp}$2`,
      );
    }

    await fs.writeFile(xmlPath, content, 'utf-8');
  }

  static async patchContextXml(xmlPath: string): Promise<void> {
    let content = await fs.readFile(xmlPath, 'utf-8');
    if (!content.includes('reloadable=')) {
      content = content.replace('<Context>', '<Context reloadable="true">');
    }
    await fs.writeFile(xmlPath, content, 'utf-8');
  }
}
