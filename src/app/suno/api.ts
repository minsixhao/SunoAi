import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import {
  BaseClient,
  ControllerPool,
  ProxyService,
  Service,
  ChatModel,
  ChatProvider,
  PROXY_API_KEY,
  nanoid,
} from './base-client';
import _ from 'lodash';
import { Buffer } from 'node:buffer';
import { CookieJar } from 'tough-cookie';
import UserAgent from 'user-agents';
import { wrapper } from 'axios-cookiejar-support';
import { Mutex } from 'async-mutex';
import { urlAsX } from '../../common/utils/utils';

export interface SunoAudioInfo {
  id: string;
  title?: string;
  image_url?: string;
  lyric?: string;
  audio_url?: string;
  video_url?: string;
  created_at: string;
  model_name?: string;
  gpt_description_prompt?: string;
  prompt?: string;
  status: string;
  type?: string;
  tags?: string;
  duration?: string;
  content?: Buffer;
  provider?: ChatProvider;
  model?: ChatModel;
  apiKey?: string;
  proxy?: string;
  remainingCredits?: number;
}

export interface SunoReqReturn {
  apiKey: string;
  songIds: string[];
}

export class SunoClient extends BaseClient {
  private static BASE_URL: string = 'https://studio-api.suno.ai';
  private static CLERK_BASE_URL: string = 'https://clerk.suno.com';

  private readonly client: AxiosInstance;
  private sid?: string;
  private currentToken?: string;
  private keepAliveMutex = new Mutex();
  private songRequestQueue = new SongRequestQueue(10);

  constructor(
    private readonly apiKey: Service,
    private readonly proxyServers: ProxyService[],
  ) {
    super();

    const cookieJar = new CookieJar();
    const randomUserAgent = new UserAgent(/Chrome/).random().toString();
    this.client = wrapper(
      axios.create({
        jar: cookieJar,
        withCredentials: true,
        headers: {
          'User-Agent': randomUserAgent,
          Cookie: this.apiKey.apiKey,
        },
      }),
    );
    this.client.interceptors.request.use((config) => {
      if (this.currentToken) {
        config.headers['Authorization'] = `Bearer ${this.currentToken}`;
      }
      return config;
    });
  }

  calcService(model: ChatModel = ChatModel.Suno35) {
    let proxyServer = SunoClient.BASE_URL;
    let proxyService: ProxyService | undefined;
    if (this.proxyServers.length > 0) {
      proxyService = _.sample(this.proxyServers);
      proxyServer = proxyService!.server;
    }
    return [, proxyService, proxyServer] as const;
  }

  private reqConfig(apiKey: string, id?: string, useProxy?: boolean) {
    const headers = useProxy
      ? {
          'X-Proxy-Api-Key': PROXY_API_KEY,
          'X-Target-Host': 'studio-api.suno.ai',
          'x-trace-id': id ?? nanoid(16),
          'x-start-at': Date.now(),
        }
      : {};

    const controller = this.newAbortSignal();
    if (id) {
      ControllerPool.addController(id, controller);
    }
    return {
      timeout: this.timeout,
      headers,
      signal: controller.signal,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    } as AxiosRequestConfig;
  }

  async init(): Promise<SunoClient> {
    await this.getAuthToken();
    await this.keepAlive();
    return this;
  }

  private async getAuthToken(id?: string) {
    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };
    const path = '/v1/client?_clerk_js_version=4.72.4';
    const sessionResponse = await this.client.get(
      `${SunoClient.CLERK_BASE_URL}${path}`,
    );

    if (!sessionResponse?.data?.response?.['last_active_session_id']) {
      throw new Error(
        'Failed to get session id, you may need to update the SUNO_COOKIE',
      );
    }
    this.sid = sessionResponse.data.response['last_active_session_id'];
  }

  async keepAlive(id?: string): Promise<void> {
    if (!this.sid) {
      throw new Error('Session ID is not set. Cannot renew token.');
    }
    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };
    const path = '/v1/client?_clerk_js_version=4.72.4';
    const sessionResponse = await this.client.get(
      `${SunoClient.CLERK_BASE_URL}${path}`,
    );

    await this.keepAliveMutex.runExclusive(async () => {
      const renewUrl = `${SunoClient.CLERK_BASE_URL}/v1/client/sessions/${this.sid}/tokens?_clerk_js_version==4.72.4`;
      const renewResponse = await this.client.post(renewUrl);
      this.currentToken = renewResponse.data['jwt'];
    });
  }

  async generate(
    prompt: string,
    makeInstrumental: boolean = false,
  ): Promise<SunoReqReturn> {
    await this.keepAlive();
    return await this.makeReqGenerateSongs(
      prompt,
      false,
      undefined,
      undefined,
      makeInstrumental,
    );
  }

  async customGenerate(
    prompt: string,
    tags: string,
    title: string,
    make_instrumental: boolean = false,
  ): Promise<SunoReqReturn> {
    await this.keepAlive();
    return await this.makeReqGenerateSongs(
      prompt,
      true,
      tags,
      title,
      make_instrumental,
    );
  }

  async makeReqGenerateSongs(
    prompt: string,
    isCustom: boolean,
    tags?: string,
    title?: string,
    makeInstrumental?: boolean,
    id?: string,
  ): Promise<SunoReqReturn> {
    await this.keepAlive();
    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };

    try {
      // 控制并发最多为10个
      const payload: any = {
        mv: 'chirp-v3-5',
        prompt: '',
        make_instrumental: false,
      };
      if (isCustom) {
        payload.tags = tags;
        payload.title = title;
        payload.prompt = prompt;
      } else {
        payload.gpt_description_prompt = prompt;
      }
      if (makeInstrumental) {
        payload.make_instrumental = makeInstrumental;
        payload.prompt = '';
      }

      const songIdsPromise = new Promise<string[]>((resolve, reject) => {
        this.songRequestQueue.add(async () => {
          try {
            const response = await this.client.post(
              `${proxyServer}/api/generate/v2/`,
              payload,
              config,
            );
            if (response.status !== 200) {
              throw new Error('Error response:' + response.statusText);
            }
            const songIds = response.data['clips'].map(
              (audio: any) => audio.id,
            );
            resolve(songIds);
          } catch (error) {
            reject(
              new Error(`Failed to generate song. Error: ${error.message}`),
            );
          }
        });
      });
      const songIds = await songIdsPromise;
      const songRes = {
        apiKey: this.apiKey.apiKey!,
        songIds: songIds,
      };
      return songRes;
    } catch (error) {
      throw new Error(`Failed to generate song. Error: ${error.message}`);
    }
  }

  async getSunoSongRes(
    songIds: string[],
  ): Promise<SunoAudioInfo[] | undefined> {
    await this.keepAlive();
    const response = await this.getSongFromSongIds(songIds);
    const resolvedResponse = await Promise.all(response);
    const allCompleted = resolvedResponse.every(
      (audio) => audio.status === 'streaming' || audio.status === 'complete',
    );
    if (!allCompleted) {
      return;
    }
    const allCompletedResPromise = resolvedResponse.map(async (audio) => {
      const [audioData, contentType] = await urlAsX(
        audio.audio_url as string,
        'arraybuffer',
      );
      const buff = Buffer.from(audioData, 'base64');
      return {
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.prompt,
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        gpt_description_prompt: audio.gpt_description_prompt,
        prompt: audio.prompt,
        status: audio.status,
        type: audio.type,
        duration: audio.duration,
        content: buff,
        provider: ChatProvider.Suno,
        model: ChatModel.Suno35,
        apiKey: audio.apiKey,
        proxy: audio.proxy,
        remainingCredits: await this.getCredits(),
      };
    });

    return await Promise.all(allCompletedResPromise);
  }

  parseLyrics(prompt: string): string {
    const lines = prompt.split('\n').filter((line) => line.trim() !== '');
    return lines.join('\n');
  }

  async generateLyrics(prompt: string, id?: string): Promise<string> {
    await this.keepAlive();

    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };
    const generateResponse = await this.client.post(
      `${proxyServer}/api/generate/lyrics/`,
      { prompt },
      config,
    );
    if (generateResponse.status !== 200) {
      throw new Error(
        `Failed to get lyrics. Error: ${generateResponse.data.message}`,
      );
    }
    const generateId = generateResponse.data.id;
    return this.parseLyrics(generateId);
  }

  async getLyricsById(id: string) {
    await this.keepAlive();

    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };
    const lyricsResponse = await this.client.get(
      `${proxyServer}/api/generate/lyrics/${id}`,
      config,
    );
    if (lyricsResponse.status !== 200) {
      throw new Error(
        `Failed to get lyrics. Error: ${lyricsResponse.data.message}`,
      );
    }
    return {
      lyricId: id,
      status: lyricsResponse.data.status,
      lyrics: this.parseLyrics(lyricsResponse.data.text),
    };
  }

  async getSongFromSongIds(
    songIds?: string[],
    id?: string,
  ): Promise<SunoAudioInfo[]> {
    await this.keepAlive();

    const model = ChatModel.Suno35;
    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };

    try {
      let url = `${proxyServer}/api/feed/`;
      if (songIds) {
        url = `${url}?ids=${songIds.join(',')}`;
      }
      const response = await this.client.get(url, config);

      const audios = response.data;
      return audios.map(async (audio: any) => ({
        id: audio.id,
        title: audio.title,
        image_url: audio.image_url,
        lyric: audio.metadata.prompt
          ? this.parseLyrics(audio.metadata.prompt)
          : '',
        audio_url: audio.audio_url,
        video_url: audio.video_url,
        created_at: audio.created_at,
        model_name: audio.model_name,
        status: audio.status,
        gpt_description_prompt: audio.metadata.gpt_description_prompt,
        prompt: audio.metadata.prompt,
        type: audio.metadata.type,
        tags: audio.metadata.tags,
        duration: audio.metadata.duration_formatted,
        content: Buffer.from(''),
        provider: ChatProvider.Suno,
        model: ChatModel.Suno35,
        apikey: this.apiKey.apiKey,
        proxy: proxyServer,
        remainingCredits: await this.getCredits(),
      }));
    } catch (error) {
      throw new Error(error);
    } finally {
      if (id) {
        ControllerPool.remove(id);
      }
    }
  }

  // 获取 suno 剩余额度
  async getCredits(id?: string): Promise<number> {
    await this.keepAlive();
    const [service, proxyService, proxyServer] = this.calcService();
    const config = this.reqConfig('', id, !!proxyService);
    config.headers = {
      ...config.headers,
      'Content-Type': 'application/json',
    };
    const response = await this.client.get(
      `${proxyServer}/api/billing/info/`,
      config,
    );
    return response.data.total_credits_left;
  }
}

class SongRequestQueue {
  private queue: (() => Promise<void>)[] = [];
  private activeCount = 0;
  private readonly concurrencyLimit: number;

  constructor(concurrencyLimit: number) {
    this.concurrencyLimit = concurrencyLimit;
  }

  async add(task: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
      const runTask = async () => {
        this.activeCount++;
        try {
          await task();
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          this.activeCount--;
          this.next();
        }
      };

      if (this.activeCount < this.concurrencyLimit) {
        runTask();
      } else {
        this.queue.push(runTask);
      }
    });
  }

  private next() {
    if (this.queue.length > 0 && this.activeCount < this.concurrencyLimit) {
      const nextTask = this.queue.shift();
      if (nextTask) {
        nextTask();
      }
    }
  }
}

export const newSunoClient = async (
  apiKeys: Service[],
  proxies: ProxyService[],
  apiKey?: string,
) => {
  let keys = apiKeys.filter((e) => e.serviceModel === ChatModel.Suno35);
  keys = keys.flatMap((k) => {
    return _.times(k.weight, () => k);
  });
  let key;
  if (apiKey) {
    // 根据 Cookie 锁定到具体的 Cookie 服务
    key = keys.find((k) => k.apiKey === apiKey)!;
  } else {
    key = _.sample(keys)!;
  }
  const client = new SunoClient(key, proxies);
  return await client.init();
};
