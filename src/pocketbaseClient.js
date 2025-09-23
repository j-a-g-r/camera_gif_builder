import PocketBase from 'pocketbase';

export function createClient(url) {
  const pb = new PocketBase(url);
  return pb;
}

// Upload a GIF buffer to the `gifs` collection.
// Inputs: pb (PocketBase client), buffer (Buffer), filename (string like 'name.gif')
export async function uploadGifRecord(pb, buffer, filename = 'animation.gif') {
  if (!pb) throw new Error('PocketBase client is required');
  if (!buffer || !buffer.length) throw new Error('GIF buffer is empty');

  // Use Web-compatible FormData/Blob available in Node 18+
  const form = new FormData();
  const blob = new Blob([buffer], { type: 'image/gif' });
  form.append('gif', blob, filename);

  const record = await pb.collection('gifs').create(form);
  return record;
}
