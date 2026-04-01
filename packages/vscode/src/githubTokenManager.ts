/**
 * GitHub Token Manager
 * Manages GitHub access tokens per host using VS Code's Secret Storage
 */

import * as vscode from "vscode";
import { Logger } from "@ragnarok/core";

const logger = new Logger("GitHubTokenManager");

export class GitHubTokenManager {
  private static instance: GitHubTokenManager;
  private secretStorage: vscode.SecretStorage;
  private static readonly TOKEN_PREFIX = "ragnarok.github.token.";
  private static readonly HOSTS_KEY = "ragnarok.github.hosts";

  private constructor(secretStorage: vscode.SecretStorage) {
    this.secretStorage = secretStorage;
  }

  /**
   * Initialize the token manager
   */
  public static initialize(context: vscode.ExtensionContext): GitHubTokenManager {
    if (!GitHubTokenManager.instance) {
      GitHubTokenManager.instance = new GitHubTokenManager(context.secrets);
    }
    return GitHubTokenManager.instance;
  }

  /**
   * Get the singleton instance
   */
  public static getInstance(): GitHubTokenManager {
    if (!GitHubTokenManager.instance) {
      throw new Error("GitHubTokenManager not initialized. Call initialize() first.");
    }
    return GitHubTokenManager.instance;
  }

  /**
   * Extract host from GitHub URL
   * @param url GitHub repository URL
   * @returns Host name (e.g., "github.com", "github.company.com")
   */
  public extractHost(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname;
    } catch (error) {
      logger.error(`Failed to extract host from URL: ${url}`, error);
      return null;
    }
  }

  /**
   * Get token for a specific host
   * @param host GitHub host (e.g., "github.com", "github.company.com")
   * @returns Token or undefined if not found
   */
  public async getToken(host: string): Promise<string | undefined> {
    const key = `${GitHubTokenManager.TOKEN_PREFIX}${host}`;
    const token = await this.secretStorage.get(key);

    if (token) {
      logger.info(`Retrieved token for host: ${host}`);
    } else {
      logger.info(`No token found for host: ${host}`);
    }

    return token;
  }

  /**
   * Get token by URL
   * @param url GitHub repository URL
   * @returns Token or undefined if not found
   */
  public async getTokenByUrl(url: string): Promise<string | undefined> {
    const host = this.extractHost(url);
    if (!host) {
      return undefined;
    }
    return this.getToken(host);
  }

  /**
   * Store token for a specific host
   * @param host GitHub host (e.g., "github.com", "github.company.com")
   * @param token GitHub access token
   */
  public async setToken(host: string, token: string): Promise<void> {
    const key = `${GitHubTokenManager.TOKEN_PREFIX}${host}`;
    await this.secretStorage.store(key, token);
    logger.info(`Stored token for host: ${host}`);
  }

  /**
   * Delete token for a specific host
   * @param host GitHub host
   */
  public async deleteToken(host: string): Promise<void> {
    const key = `${GitHubTokenManager.TOKEN_PREFIX}${host}`;
    await this.secretStorage.delete(key);
    logger.info(`Deleted token for host: ${host}`);
  }

  /**
   * List all stored GitHub hosts (not the tokens themselves)
   * Note: VS Code Secret Storage doesn't provide a way to list all keys,
   * so we maintain a separate list in global state
   */
  public async listHosts(context: vscode.ExtensionContext): Promise<string[]> {
    const hosts = context.globalState.get<string[]>(GitHubTokenManager.HOSTS_KEY, []);
    return hosts;
  }

  /**
   * Add host to the tracked list
   */
  public async addHostToList(context: vscode.ExtensionContext, host: string): Promise<void> {
    const hosts = await this.listHosts(context);
    if (!hosts.includes(host)) {
      hosts.push(host);
      await context.globalState.update(GitHubTokenManager.HOSTS_KEY, hosts);
      logger.info(`Added host to tracked list: ${host}`);
    }
  }

  /**
   * Remove host from the tracked list
   */
  public async removeHostFromList(context: vscode.ExtensionContext, host: string): Promise<void> {
    const hosts = await this.listHosts(context);
    const filtered = hosts.filter((h) => h !== host);
    await context.globalState.update(GitHubTokenManager.HOSTS_KEY, filtered);
    logger.info(`Removed host from tracked list: ${host}`);
  }

  /**
   * Check if token exists for a host
   */
  public async hasToken(host: string): Promise<boolean> {
    const token = await this.getToken(host);
    return token !== undefined && token.length > 0;
  }

  /**
   * Prompt user to save token for a host
   */
  public async promptToSaveToken(context: vscode.ExtensionContext, host: string, token: string): Promise<boolean> {
    const save = await vscode.window.showInformationMessage(
      `Would you like to save the access token for "${host}" for future use?`,
      "Save Token",
      "Don't Save",
    );

    if (save === "Save Token") {
      await this.setToken(host, token);
      await this.addHostToList(context, host);
      logger.info(`User saved token for host: ${host}`);
      return true;
    }

    logger.info(`User declined to save token for host: ${host}`);
    return false;
  }
}
