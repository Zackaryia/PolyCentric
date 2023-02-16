import Long from 'long';

import * as ProcessHandle from './process-handle';
import * as MetaStore from './meta-store';
import * as PersistenceDriver from './persistence-driver';
import * as Models from './models';
import * as Synchronization from './synchronization';
import * as Util from './util';
import * as Protocol from './protocol';
import * as APIMethods from './api-methods';

async function createProcessHandle(): Promise<ProcessHandle.ProcessHandle> {
    return await ProcessHandle.createProcessHandle(
        await MetaStore.createMetaStore(
            PersistenceDriver.createPersistenceDriverMemory(),
        ),
    );
}

describe('processHandle', () => {
    test('basic post', async () => {
        const processHandle = await createProcessHandle();

        const events: Array<Models.SignedEvent> = [];
        processHandle.setListener((event: Models.SignedEvent) => {
            events.push(event);
        });

        await processHandle.post('jej');
        await processHandle.post('hello world');

        expect(events.length).toStrictEqual(2);

        expect(
            Models.eventFromProtoBuffer(events[0].event()).logicalClock(),
        ).toStrictEqual(new Long(1, 0, true));

        expect(
            Models.eventFromProtoBuffer(events[1].event()).logicalClock(),
        ).toStrictEqual(new Long(2, 0, true));
    });

    test('addAndRemoveServer', async () => {
        const processHandle = await createProcessHandle();

        await processHandle.addServer('127.0.0.1');
        await processHandle.addServer('127.0.0.2');
        await processHandle.addServer('127.0.0.3');
        await processHandle.removeServer('127.0.0.1');

        const serverState = await processHandle.loadSystemState(
            processHandle.system(),
        );

        expect(serverState.servers()).toStrictEqual(['127.0.0.2', '127.0.0.3']);
    });

    test('username', async () => {
        const processHandle = await createProcessHandle();

        await processHandle.setUsername('alice');
        await processHandle.setUsername('bob');

        const serverState = await processHandle.loadSystemState(
            processHandle.system(),
        );

        expect(serverState.username()).toStrictEqual('bob');
    });

    test('description', async () => {
        const processHandle = await createProcessHandle();

        await processHandle.setDescription('test');

        const serverState = await processHandle.loadSystemState(
            processHandle.system(),
        );

        expect(serverState.description()).toStrictEqual('test');
    });

    test('avatar', async () => {
        const processHandle = await createProcessHandle();

        const fakeImage = Util.encodeText('not actually a png');
        const imagePointer = await processHandle.publishBlob(
            'image/png',
            fakeImage,
        );
        await processHandle.setAvatar(imagePointer);

        const serverState = await processHandle.loadSystemState(
            processHandle.system(),
        );

        const loadedAvatar = await processHandle.loadBlob(
            serverState.avatar()!,
        );

        expect(loadedAvatar!.mime()).toStrictEqual('image/png');
        expect(
            Util.buffersEqual(loadedAvatar!.content(), fakeImage),
        ).toStrictEqual(true);
    });

    test('claim then vouch', async () => {
        const processHandle = await createProcessHandle();

        const claimPointer = await processHandle.claim(
            Models.claimHackerNews('pg'),
        );

        await processHandle.vouch(claimPointer);
    });

    test('sync', async () => {
        const s1p1 = await createProcessHandle();
        await s1p1.addServer('http://127.0.0.1:8081');
        await s1p1.setDescription('hello');

        const claim = Models.claimHackerNews('pg');

        const claimPointer = await s1p1.claim(claim);
        await s1p1.vouch(claimPointer);

        await Synchronization.backFillServers(s1p1, s1p1.system());

        const s2p1 = await createProcessHandle();

        await Synchronization.backfillClient(
            s2p1,
            s1p1.system(),
            'http://127.0.0.1:8081',
        );

        const s1State = await s2p1.loadSystemState(s1p1.system());

        expect(s1State.description()).toStrictEqual('hello');

        const resolved = await APIMethods.getResolveClaim(
            'http://localhost:8081',
            s1p1.system(),
            claim,
        );

        expect(resolved.events.length).toStrictEqual(2);
    });
});