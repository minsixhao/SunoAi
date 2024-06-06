import { newSunoClient } from '../api';
import { Service } from '../base-client';
import { Time } from '../utils/time';

export const JEST_TIMEOUT = 1000_000_000;

Time.init();
jest.setTimeout(JEST_TIMEOUT);
describe('SunoApi', () => {
  let client = newSunoClient(['cookie'] as Service[], ['proxyServers']);

  it('generate suno', async () => {
    const res = await (await client).generate('雨后天晴');
    console.log(res);
  });

  it('custom_generate suno', async () => {
    const res = await (
      await client
    ).customGenerate('雨后天晴开心', '轻快 流行', '放晴了');
  });

  it('getMySubscription', async () => {
    const res = await (await client).getCredits();
    console.log(res);
  });

  it('getSongs', async () => {
    const songIds = [
      '8cc7ba1b-29a2-418b-b40a-f64c893ce2d8',
      '3be660b6-c925-4c42-bd04-4606f5d62ad2',
    ];
    const res = await (await client).getSunoSongRes(songIds);
    console.log(res);
  });

  it('generate lyricsResponse', async () => {
    const res = await (await client).generateLyrics('雨后天晴开心');
    console.log(res);
  });

  it('get lyricsResponse by id', async () => {
    const res = await (
      await client
    ).getLyricsById('b63de7c6-8a8a-4a63-9cf6-a54fb561c4a8');
    console.log(res);
  });
});
