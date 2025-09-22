import PocketBase from 'pocketbase';

export function createClient(url) {
  const pb = new PocketBase(url);
  return pb;
}
