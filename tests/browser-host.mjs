import {VERSION} from '../core.mjs';

// Test-only Chrome transport shim. Storage operations use real browser IndexedDB.
// Never packaged; serve only in an isolated localhost browser profile.
if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw Error('Local test harness only');
const state = {}, listeners = [], broadcasts = [];
const admin = {id: 'mini-test', url: 'chrome-extension://mini-test/popup.html'};
const game = {id: 'mini-test', url: 'https://gg-client-r.crave-saga.net/client/test/index_dmm.html', tab: {id: 1}, frameId: 0};
let ready;
const get = async keys => {
  if (keys === null || keys === undefined) return structuredClone(state);
  if (typeof keys === 'string') return {[keys]: structuredClone(state[keys])};
  if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, structuredClone(state[key])]));
  return Object.fromEntries(Object.entries(keys).map(([key, fallback]) => [key, structuredClone(state[key] ?? fallback)]));
};
const chromeMock = {
  storage: {local: {
    get, set: async values => Object.assign(state, structuredClone(values)),
    remove: async keys => { for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key]; },
    setAccessLevel: async () => {}
  }},
  runtime: {
    id: 'mini-test', getURL: file => 'chrome-extension://mini-test/' + file,
    getManifest: () => ({version: VERSION}),
    onMessage: {addListener: listener => listeners.push(listener)},
    onInstalled: {addListener() {}},
    sendMessage(message, callback) {
      const promise = send(message);
      if (callback) promise.then(callback);
      return promise;
    }
  },
  tabs: {
    query: async () => [{id: 1}],
    sendMessage: async (tabId, message) => { broadcasts.push({tabId, message: structuredClone(message)}); },
    create: async () => { throw Error('Open-tab is extension-only'); }
  }
};
globalThis.chrome = chromeMock;
export async function send(message, sender = admin) {
  await ready;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Backend test response timeout')), 20000);
    listeners[0](message, sender, response => { clearTimeout(timer); resolve(response); });
  });
}
export const fixtures = {admin, game, state, broadcasts};
ready = import('../background.mjs');
await ready;
