// Retire this old-origin worker so installed copies can show the move notice.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  await self.registration.unregister();
  await Promise.all((await caches.keys()).filter(name => /^(app-|psycle-|sweat-|dibs-)/.test(name)).map(name => caches.delete(name)));
  for (const client of await self.clients.matchAll({ type: 'window' })) await client.navigate(client.url);
})()));
