import { customAlphabet } from 'nanoid';
export const MAX_TIMEOUT = 600000;
export class BaseClient {
  public timeout = MAX_TIMEOUT;
  constructor() {}
  newAbortSignal(timeoutMs = this.timeout) {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), timeoutMs || 0);
    return abortController;
  }
}

export const ControllerPool = {
  controllers: {} as Record<string, AbortController>,

  addController(messageId: string, controller: AbortController) {
    const key = this.key(messageId);
    this.controllers[key] = controller;
    return key;
  },

  stop(messageId: string) {
    const key = this.key(messageId);
    const controller = this.controllers[key];
    controller?.abort();
  },

  remove(messageId: string) {
    const key = this.key(messageId);
    delete this.controllers[key];
  },

  key(messageIndex: string) {
    return `conversation-${messageIndex}`;
  },
};

export interface ProxyService {
  id: string;
  server: string;
}

export interface Service {
  serviceModel: string;
  apiBase: string;
  apiKey: string;
  weight: number;
}

export enum ChatModel {
  Suno35 = 'suno-3.5', // Suno3.5
}

export enum ChatProvider {
  Suno = 'Suno',
}

export const PROXY_API_KEY =
  'ITAXtKOhglJxKNKLcrcsvjYmY7glmocsMkpLygpTm7mdIzjAWJkt94lptcBgdRER';

export const nanoid = (size: number, numberOnly: boolean = false) =>
  customAlphabet(
    numberOnly
      ? '0123456789'
      : '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
    size,
  )();
