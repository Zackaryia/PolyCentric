import * as PolycentricReact from 'polycentric-react';

const cacheKey = 'polycentric-cache3';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", (event: ExtendableEvent) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event: ExtendableEvent) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event: FetchEvent) => {
    event.respondWith((async () => {
        const url = new URL(event.request.url);

        if (url.origin === self.location.origin) {
            let request = event.request;

            const accept = event.request.headers.get('Accept');

            if (accept !== null && accept.includes('text/html') === true) {
                request = new Request(url.origin + '/index.html');
            }

            const cache = await caches.open(cacheKey);

            try {
                const response = await fetch(request);

                if (response.ok === true) {
                    cache.put(request, response.clone());
                } else {
                    throw new Error('response was not ok');
                }

                return response;
            } catch {
                const cached = await cache.match(request.url);

                if (cached === undefined) {
                    return new Response(new Blob(), {
                        status: 404,
                    });
                } else {
                    return cached;
                }
            };
        } else {
             return fetch(event.request);
        }
    })());
});

export {};