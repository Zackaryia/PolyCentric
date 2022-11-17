import * as Ed from '@noble/ed25519';
import * as AbstractLevel from 'abstract-level';
import AsyncLock from 'async-lock';
import Long from 'long';
import * as Base64 from '@borderless/base64';
import * as Lodash from 'lodash';

import * as Util from './Util';
import * as Keys from './keys';
import * as Protocol from './protocol';
import * as Crypto from './crypto';
import * as Synchronization from './synchronization';
import * as APIMethods from './APIMethods';
import * as Ingest from './ingest';
import * as PersistenceDriver from './persistence-driver';

export const STORAGE_VERSION = 0;

export type Listener = {
    key: string;
    callback: () => void;
};

export class DependencyContext {
    private _mutated: boolean;
    private _cleanup: boolean;
    private _handler: (() => void) | undefined;
    private _listeners: Array<Listener>;
    private _state: PolycentricState;
    private _listenerCallback: () => void;

    public constructor(state: PolycentricState) {
        this._mutated = false;
        this._cleanup = false;
        this._handler = undefined;
        this._listeners = new Array();
        this._state = state;

        const selfa = this;

        this._listenerCallback = Lodash.once(() => {
            selfa._mutated = true;

            if (selfa._handler !== undefined && selfa._cleanup !== true) {
                selfa._handler();
            }
        });
    }

    public addDependency(pointer: Protocol.Pointer): void {
        const key = Keys.pointerToKey(pointer);

        this.addDependencyByKey(key);
    }

    public addDependencyByKey(buffer: Uint8Array): void {
        if (this._cleanup === true) {
            throw new Error('addDependency called after cleanup');
        }

        const key = Base64.encode(buffer);

        this._listeners.push({
            key: key,
            callback: this._listenerCallback,
        });

        waitOnEvent(this._state, key, this._listenerCallback);
    }

    public cleanup(): void {
        if (this._cleanup === true) {
            console.log('cleanup called after cleanup');
            return;
            // throw new Error("cleanup called after cleanup");
        }

        for (const listener of this._listeners) {
            cancelWaitOnEvent(this._state, listener.key, listener.callback);
        }

        this._cleanup = true;
    }

    public setHandler(callback: () => void): void {
        this._handler = callback;

        if (this._mutated === true) {
            console.log('mutation detected on set handler');

            this._handler();
        }
    }
}

export enum EventMessageType {
    Message,
    Profile,
    Follow,
    BlobMeta,
    BlobSection,
    Delete,
    Unknown,
}

export interface IIdentityState {
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    writerId: Uint8Array;
    sequenceNumber: number;
}

export type BinaryAbstractLevel = AbstractLevel.AbstractLevel<
    Uint8Array,
    Uint8Array,
    Uint8Array
>;

export type BinaryAbstractSubLevel = AbstractLevel.AbstractSublevel<
    BinaryAbstractLevel,
    Uint8Array,
    Uint8Array,
    Uint8Array
>;

export type BinaryPutLevel = AbstractLevel.AbstractBatchPutOperation<
    BinaryAbstractLevel,
    Uint8Array,
    Uint8Array
>;

export class PolycentricState {
    sync: Synchronization.SynchronizationState;
    identity: IIdentityState | undefined;
    autoSync: boolean;
    lock: AsyncLock;
    persistenceDriver: PersistenceDriver.PersistenceDriver;
    client: string;

    level: BinaryAbstractLevel;
    levelEvents: BinaryAbstractSubLevel;
    levelRanges: BinaryAbstractLevel;
    levelFollowing: BinaryAbstractLevel;
    private readonly levelFollowing2: BinaryAbstractSubLevel;
    levelProfiles: BinaryAbstractSubLevel;
    levelIndexPostByTime: BinaryAbstractSubLevel;
    levelIndexPostByAuthorByTime: BinaryAbstractSubLevel;

    listeners: Map<string, Set<() => void>>;

    constructor(
        level: BinaryAbstractLevel,
        persistenceDriver: PersistenceDriver.PersistenceDriver,
        client: string,
    ) {
        console.log('creating state');
        this.sync = new Synchronization.SynchronizationState();
        this.identity = undefined;
        this.autoSync = true;
        this.listeners = new Map();
        this.persistenceDriver = persistenceDriver;
        this.client = client;

        this.lock = new AsyncLock();

        this.level = level;

        this.levelEvents = this.level.sublevel('events', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractSubLevel;

        this.levelRanges = this.level.sublevel('ranges', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractLevel;

        this.levelFollowing = this.level.sublevel('following', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractLevel;

        this.levelFollowing2 = this.level.sublevel('following2', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractSubLevel;

        this.levelProfiles = this.level.sublevel('profiles', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractSubLevel;

        this.levelIndexPostByTime = this.level.sublevel('indexPostByTime', {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
        }) as BinaryAbstractSubLevel;

        this.levelIndexPostByAuthorByTime = this.level.sublevel(
            'indexPostByAuthorByTime',
            {
                keyEncoding: 'buffer',
                valueEncoding: 'buffer',
            },
        ) as BinaryAbstractSubLevel;

        this.level.setMaxListeners(10000);
    }

    makeProfilePut(
        key: Uint8Array,
        body: Protocol.StorageTypeProfile,
    ): BinaryPutLevel {
        if (key.length != 32) {
            throw new Error('expected key to be 32 bytes');
        }

        return {
            type: 'put',
            key: key,
            value: Protocol.StorageTypeProfile.encode(body).finish(),
            sublevel: this.levelProfiles,
        };
    }

    makeEventPut(
        key: Uint8Array,
        body: Protocol.StorageTypeEvent,
    ): BinaryPutLevel {
        if (key.length !== 32 + 32 + 8) {
            throw new Error('incorrect key size');
        }

        return {
            type: 'put',
            key: key,
            value: Protocol.StorageTypeEvent.encode(body).finish(),
            sublevel: this.levelEvents,
        };
    }

    makeIndexPostByTimePut(
        unixMilliseconds: number,
        key: Uint8Array,
    ): BinaryPutLevel {
        if (key.length !== 32 + 32 + 8) {
            throw new Error('incorrect key size');
        }

        return {
            type: 'put',
            key: Util.numberToBinaryBE(unixMilliseconds),
            value: key,
            sublevel: this.levelIndexPostByTime,
        };
    }

    makeIndexPostByAuthorByTimePut(
        author: Uint8Array,
        unixMilliseconds: number,
        key: Uint8Array,
    ): BinaryPutLevel {
        if (author.length != 32) {
            throw new Error('expected key to be 32 bytes');
        }

        if (key.length !== 32 + 32 + 8) {
            throw new Error('incorrect key size');
        }

        return {
            type: 'put',
            key: Keys.makeStorageTypeEventKeyByAuthorByTime(
                author,
                unixMilliseconds,
            ),
            value: key,
            sublevel: this.levelIndexPostByAuthorByTime,
        };
    }

    makeFollowingPut(
        follower: Uint8Array,
        following: Uint8Array,
        body: Protocol.StorageTypeFollowing,
    ): BinaryPutLevel {
        if (follower.length != 32) {
            throw new Error('expected follower to be 32 bytes');
        }

        if (following.length != 32) {
            throw new Error('expected following to be 32 bytes');
        }

        if (body.publicKey.length != 32) {
            throw new Error('expected body.publicKey to be 32 bytes');
        }

        const key = appendBuffers(follower, following);

        return {
            type: 'put',
            key: key,
            value: Protocol.StorageTypeFollowing.encode(body).finish(),
            sublevel: this.levelFollowing2,
        };
    }

    async getFollowing(
        follower: Uint8Array,
        following: Uint8Array,
    ): Promise<Protocol.StorageTypeFollowing | undefined> {
        if (follower.length != 32) {
            throw new Error('expected follower to be 32 bytes');
        }

        if (following.length != 32) {
            throw new Error('expected following to be 32 bytes');
        }

        const key = appendBuffers(follower, following);

        const value = await tryLoadKey(this.levelFollowing2, key);

        if (value === undefined) {
            return undefined;
        }

        return Protocol.StorageTypeFollowing.decode(value);
    }

    async getAllFollowing(
        follower: Uint8Array,
    ): Promise<Array<Protocol.StorageTypeFollowing>> {
        return (
            await this.levelFollowing2
                .values({
                    lte: appendBuffers(follower, Keys.MAX_32BYTE_KEY),
                    gte: appendBuffers(follower, Keys.MIN_32BYTE_KEY),
                })
                .all()
        ).map((item) => {
            return Protocol.StorageTypeFollowing.decode(item);
        });
    }
}

export function waitOnEvent(
    state: PolycentricState,
    key: string,
    cb: () => void,
) {
    let listenersForKey = state.listeners.get(key);

    if (listenersForKey === undefined) {
        listenersForKey = new Set();

        state.listeners.set(key, listenersForKey);
    }

    listenersForKey.add(cb);
}

export function cancelWaitOnEvent(
    state: PolycentricState,
    key: string,
    cb: () => void,
) {
    let listenersForKey = state.listeners.get(key);

    if (listenersForKey !== undefined) {
        listenersForKey.delete(cb);
    }
}

export function fireListenersForEvent(state: PolycentricState, key: string) {
    let listenersForKey = state.listeners.get(key);

    if (listenersForKey !== undefined) {
        for (const listener of listenersForKey) {
            listener();
        }
    }
}

export async function doesIdentityExist(
    state: PolycentricState,
): Promise<boolean> {
    return await doesKeyExist(state.level, Keys.IDENTITY_KEY);
}

export async function cacheIdentity(state: PolycentricState): Promise<void> {
    const identity = await levelLoadIdentity(state);
    state.identity = identity;
}

export async function startIdentity(state: PolycentricState): Promise<void> {
    const identity = await levelLoadIdentity(state);
    state.identity = identity;
    Synchronization.synchronizationMain(state);
    Synchronization.addFeed(state, identity.publicKey);
    Synchronization.addAllFollowing(state);
    Synchronization.backfillServer(state);
}

export async function createStateNewIdentity(
    metaStore: PersistenceDriver.IMetaStore,
    persistenceDriver: PersistenceDriver.PersistenceDriver,
    profileName?: string,
): Promise<PolycentricState> {
    const privateKey = Ed.utils.randomPrivateKey();

    const state = await createStateExtendIdentity(
        metaStore,
        persistenceDriver,
        privateKey,
    );

    const message = makeDefaultEventBody();

    if (profileName === undefined) {
        profileName = 'Anonymous';
    }

    message.profile = {
        profileName: new TextEncoder().encode(profileName),
        profileDescription: undefined,
        profileServers: [
            new TextEncoder().encode('https://srv1.polycentric.io'),
        ],
    };

    await levelSavePost(state, message);

    return state;
}

export async function createStateExtendIdentity(
    metaStore: PersistenceDriver.IMetaStore,
    persistenceDriver: PersistenceDriver.PersistenceDriver,
    privateKey: Uint8Array,
): Promise<PolycentricState> {
    const publicKey = await Ed.getPublicKey(privateKey);
    const writerId = Ed.utils.randomPrivateKey();

    const store = await metaStore.openStore(publicKey, STORAGE_VERSION);

    const state = new PolycentricState(store, persistenceDriver, 'browser');

    await state.level.put(
        Keys.IDENTITY_KEY,
        Protocol.StorageTypeIdentity.encode({
            privateKey: privateKey,
            writerId: writerId,
            sequenceNumber: 0,
        }).finish(),
    );

    return state;
}

export async function newIdentity(
    state: PolycentricState,
    profileName?: string,
) {
    const privateKey = Ed.utils.randomPrivateKey();

    await levelNewDeviceForExistingIdentity(state, privateKey);

    const message = makeDefaultEventBody();

    if (profileName === undefined) {
        profileName = 'Anonymous';
    }

    message.profile = {
        profileName: new TextEncoder().encode(profileName),
        profileDescription: undefined,
        profileServers: [
            new TextEncoder().encode('https://srv1.polycentric.io'),
        ],
    };

    await levelSavePost(state, message);
}

export async function loadProfile(
    state: PolycentricState,
): Promise<Protocol.StorageTypeProfile> {
    const identity = await levelLoadIdentity(state);

    const potentialProfile = await tryLoadKey(
        state.levelProfiles,
        identity.publicKey,
    );

    if (potentialProfile === undefined) {
        throw new Error('expected profile');
    }

    const profile: Protocol.StorageTypeProfile =
        Protocol.StorageTypeProfile.decode(potentialProfile);

    return profile;
}

export async function loadSpecificProfile(
    state: PolycentricState,
    publicKey: Uint8Array,
): Promise<Protocol.StorageTypeProfile | undefined> {
    const potentialProfile = await tryLoadKey(state.levelProfiles, publicKey);

    if (potentialProfile === undefined) {
        return undefined;
    }

    const profile: Protocol.StorageTypeProfile =
        Protocol.StorageTypeProfile.decode(potentialProfile);

    return profile;
}

export async function search(
    state: PolycentricState,
    query: string,
): Promise<Array<[string, Protocol.ResponseSearch]>> {
    const profile = await loadProfile(state);

    const result: Array<[string, Protocol.ResponseSearch]> = [];

    for (const server of profile.servers) {
        const address = new TextDecoder().decode(server);

        const response = await APIMethods.fetchPostSearch(address, {
            search: query,
        });

        result.push([address, response]);
    }

    return result;
}

export async function explore(
    state: PolycentricState,
    beforeTime: number | undefined,
): Promise<Array<[string, Protocol.ResponseSearch]>> {
    const profile = await loadProfile(state);

    const result: Array<[string, Protocol.ResponseSearch]> = [];

    for (const server of profile.servers) {
        try {
            const address = new TextDecoder().decode(server);

            const response = await APIMethods.fetchPostExplore(address, {
                beforeTime: beforeTime,
            });

            result.push([address, response]);
        } catch (err) {
            console.log('explore', err);
        }
    }

    return result;
}

export async function notifications(
    state: PolycentricState,
    afterIndex: number | undefined,
): Promise<Array<[string, Protocol.ResponseNotifications]>> {
    const identity = await levelLoadIdentity(state);
    const profile = await loadProfile(state);

    const result: Array<[string, Protocol.ResponseNotifications]> = [];

    for (const server of profile.servers) {
        const address = new TextDecoder().decode(server);

        const response = await APIMethods.fetchPostNotifications(address, {
            publicKey: identity.publicKey,
            afterIndex: afterIndex,
        });

        result.push([address, response]);
    }

    return result;
}

export async function recommend_profiles(
    state: PolycentricState,
): Promise<Array<[string, Protocol.Event]>> {
    const profile = await loadProfile(state);

    const result: Array<[string, Protocol.Event]> = [];

    for (const server of profile.servers) {
        try {
            const address = new TextDecoder().decode(server);

            const events = await APIMethods.fetchGetRecommendProfiles(address);

            for (const event of events.events) {
                result.push([address, event]);
            }
        } catch (err) {
            console.log('failed to fetch recommended', err);
        }
    }

    return result;
}

export function makeDefaultEventBody(): Protocol.EventBody {
    return {
        message: undefined,
        profile: undefined,
        follow: undefined,
        blobMeta: undefined,
        blobSection: undefined,
        delete: undefined,
    };
}

export async function saveBlob(
    state: PolycentricState,
    kind: string,
    blob: Uint8Array,
): Promise<Protocol.Pointer> {
    const meta = makeDefaultEventBody();
    meta.blobMeta = {
        sectionCount: 1,
        kind: kind,
    };

    const section = makeDefaultEventBody();
    section.blobSection = {
        metaPointer: 0,
        content: blob,
    };

    const pointer = await levelSavePost(state, meta);

    section.blobSection.metaPointer = pointer.sequenceNumber;

    await levelSavePost(state, section);

    return pointer;
}

export async function deletePost(
    state: PolycentricState,
    pointer: Protocol.Pointer,
): Promise<Protocol.Pointer> {
    const body = makeDefaultEventBody();
    body.delete = {
        pointer: pointer,
    };
    return await levelSavePost(state, body);
}

export type BlobWithKind = {
    kind: string;
    blob: Uint8Array;
};

export async function tryLoadStorageEventByPointer(
    state: PolycentricState,
    pointer: Protocol.Pointer,
): Promise<Protocol.StorageTypeEvent | undefined> {
    const value = await tryLoadStorageEventByKey(
        state,
        Keys.pointerToKey(pointer),
    );

    return value;
}

export async function tryLoadStorageEventByKey(
    state: PolycentricState,
    key: Uint8Array,
): Promise<Protocol.StorageTypeEvent | undefined> {
    const raw = await tryLoadKey(state.levelEvents, key);

    if (raw === undefined) {
        const pointer = Keys.keyToPointer(key);

        Synchronization.needPointer(state, pointer);

        return undefined;
    }

    return Protocol.StorageTypeEvent.decode(raw);
}

export async function loadBlob(
    state: PolycentricState,
    pointer: Protocol.Pointer,
    dependencyContext: DependencyContext,
): Promise<BlobWithKind | undefined> {
    dependencyContext.addDependency(pointer);

    const outerMeta = await tryLoadStorageEventByPointer(state, pointer);

    if (outerMeta === undefined) {
        // console.log('tried to load blob without a meta event');
        return undefined;
    }

    if (outerMeta.event === undefined) {
        return undefined;
    }

    const meta = outerMeta.event;

    const decodedMeta = Protocol.EventBody.decode(meta.content);

    if (decodedMeta.blobMeta === undefined) {
        console.log('tried to load blob where meta event is wrong type');
        return undefined;
    }

    let result = new Uint8Array();

    for (let i = 1; i <= decodedMeta.blobMeta.sectionCount; i++) {
        const sectionPointer = {
            publicKey: pointer.publicKey,
            writerId: pointer.writerId,
            sequenceNumber: pointer.sequenceNumber + i,
        };

        dependencyContext.addDependency(sectionPointer);

        const outerSection = await tryLoadStorageEventByPointer(
            state,
            sectionPointer,
        );

        if (outerSection === undefined) {
            // console.log('tried to load blob without a meta section');
            return undefined;
        }

        if (outerSection.event === undefined) {
            return undefined;
        }

        const section = outerSection.event;

        const decodedSection = Protocol.EventBody.decode(section.content);

        if (decodedSection.blobSection === undefined) {
            console.log('blob section was invalid type');
            return undefined;
        }

        result = decodedSection.blobSection.content;
    }

    return {
        kind: decodedMeta.blobMeta.kind,
        blob: result,
    };
}

export function deepCopyUint8Array(src: Uint8Array): Uint8Array {
    return src.slice(0);
}

export function deepCopyEvent(event: Protocol.Event): Protocol.Event {
    if (event.signature === undefined) {
        throw new Error('signature was undefined');
    }

    return {
        writerId: deepCopyUint8Array(event.writerId),
        authorPublicKey: deepCopyUint8Array(event.authorPublicKey),
        sequenceNumber: event.sequenceNumber,
        content: deepCopyUint8Array(event.content),
        signature: deepCopyUint8Array(event.signature),
        unixMilliseconds: event.unixMilliseconds,
        clocks: event.clocks.map((clock) => {
            return {
                key: deepCopyUint8Array(clock.key),
                value: clock.value,
            };
        }),
    };
}

export function bodyToEventBodyType(
    body: Protocol.EventBody,
): EventMessageType {
    if (body.message !== undefined) {
        return EventMessageType.Message;
    } else if (body.profile !== undefined) {
        return EventMessageType.Profile;
    } else if (body.follow !== undefined) {
        return EventMessageType.Follow;
    } else if (body.blobMeta !== undefined) {
        return EventMessageType.BlobMeta;
    } else if (body.blobSection !== undefined) {
        return EventMessageType.BlobSection;
    } else if (body.delete !== undefined) {
        return EventMessageType.Delete;
    } else {
        return EventMessageType.Unknown;
    }
}

export async function rangesForFeed(
    state: PolycentricState,
    publicKey: Uint8Array,
    writerId: Uint8Array,
): Promise<Array<Protocol.StorageTypeRange>> {
    return (
        await state.levelRanges
            .values({
                lte: appendBuffers(
                    appendBuffers(publicKey, writerId),
                    Keys.MAX_UINT64_KEY,
                ),
                gte: appendBuffers(
                    appendBuffers(publicKey, writerId),
                    Keys.MIN_UINT64_KEY,
                ),
            })
            .all()
    ).map((x) => Protocol.StorageTypeRange.decode(x));
}

export async function doesKeyExist(
    table: AbstractLevel.AbstractLevel<Uint8Array, Uint8Array, Uint8Array>,
    key: Uint8Array,
) {
    try {
        await table.get(key);
        return true;
    } catch (err) {
        return false;
    }
}

export async function tryLoadKey(
    table: AbstractLevel.AbstractLevel<Uint8Array, Uint8Array, Uint8Array>,
    key: Uint8Array,
): Promise<Uint8Array | undefined> {
    try {
        return await table.get(key);
    } catch (err) {
        return undefined;
    }
}

export async function isFeedComplete(
    state: PolycentricState,
    publicKey: Uint8Array,
): Promise<boolean> {
    const potentialProfile = await tryLoadKey(state.levelProfiles, publicKey);

    if (potentialProfile === undefined) {
        return false;
    }

    const profile = Protocol.StorageTypeProfile.decode(potentialProfile);

    for (const entry of profile.heads) {
        const ranges = await rangesForFeed(state, publicKey, entry.key);

        let sum = 0;
        for (const range of ranges) {
            sum += range.highSequenceNumber - range.lowSequenceNumber + 1;
        }

        if (sum < entry.value) {
            return false;
        }
    }

    return true;
}

export async function makeSyncStatusString(
    state: PolycentricState,
    publicKey: Uint8Array,
) {
    const potentialProfile = await tryLoadKey(state.levelProfiles, publicKey);

    if (potentialProfile === undefined) {
        return 'unknown profile';
    }

    const profile = Protocol.StorageTypeProfile.decode(potentialProfile);

    let status = '';

    for (const entry of profile.heads) {
        const ranges = await rangesForFeed(state, publicKey, entry.key);

        let sum = 0;
        for (const range of ranges) {
            sum += range.highSequenceNumber - range.lowSequenceNumber + 1;
        }

        status += sum.toString() + '/' + entry.value.toString() + ' ';
    }

    return status;
}

export function appendBuffers(left: Uint8Array, right: Uint8Array): Uint8Array {
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left);
    merged.set(right, left.length);
    return merged;
}

export function decodeStorageTypeRange(
    value: Uint8Array,
): Protocol.StorageTypeRange {
    return Protocol.StorageTypeRange.decode(value);
}
export async function levelFollowUser(
    state: PolycentricState,
    publicKey: Uint8Array,
) {
    if (!(await levelAmFollowing(state, publicKey))) {
        const event = makeDefaultEventBody();
        event.follow = {
            publicKey: publicKey,
            unfollow: false,
        };

        await levelSavePost(state, event);
    } else {
        console.log('already following');
    }
}

export async function levelUnfollowUser(
    state: PolycentricState,
    publicKey: Uint8Array,
) {
    if (await levelAmFollowing(state, publicKey)) {
        const event = makeDefaultEventBody();
        event.follow = {
            publicKey: publicKey,
            unfollow: true,
        };

        await levelSavePost(state, event);
    } else {
        console.log('not already following');
    }
}

export async function levelAmFollowing(
    state: PolycentricState,
    publicKey: Uint8Array,
) {
    const result = await state.getFollowing(
        state.identity!.publicKey,
        publicKey,
    );

    if (result === undefined) {
        return false;
    }

    return !result.unfollow;
}

export async function levelLoadFollowing(
    state: PolycentricState,
): Promise<Array<Uint8Array>> {
    const result = [];

    const all = await state.getAllFollowing(state.identity!.publicKey);

    for (const value of all) {
        if (value.unfollow === false) {
            result.push(value.publicKey);
        }
    }

    return result;
}

export async function levelNewDeviceForExistingIdentity(
    state: PolycentricState,
    privateKey: Uint8Array,
) {
    const writerId = Ed.utils.randomPrivateKey();

    await state.level.put(
        Keys.IDENTITY_KEY,
        Protocol.StorageTypeIdentity.encode({
            privateKey: privateKey,
            writerId: writerId,
            sequenceNumber: 0,
        }).finish(),
    );
}

export async function levelLoadIdentity(
    state: PolycentricState,
): Promise<IIdentityState> {
    const rawResult = await tryLoadKey(state.level, Keys.IDENTITY_KEY);

    if (rawResult === undefined) {
        throw new Error('Expected identity to exist');
    }

    const identity = Protocol.StorageTypeIdentity.decode(rawResult);

    const publicKey = await Ed.getPublicKey(identity.privateKey);

    return {
        privateKey: identity.privateKey,
        writerId: identity.writerId,
        publicKey: publicKey,
        sequenceNumber: identity.sequenceNumber,
    };
}

export async function levelSavePost(
    state: PolycentricState,
    message: Protocol.EventBody,
): Promise<Protocol.Pointer> {
    const identity = await levelLoadIdentity(state);

    identity.sequenceNumber += 1;

    const content = Protocol.EventBody.encode(message).finish();

    const event: Protocol.Event = {
        writerId: identity.writerId,
        authorPublicKey: identity.publicKey,
        sequenceNumber: identity.sequenceNumber,
        content: content,
        clocks: [],
        signature: undefined,
        previousEventHash: undefined,
        unixMilliseconds: Date.now(),
    };

    await Crypto.addEventSignature(event, identity.privateKey);

    await state.level.put(
        Keys.IDENTITY_KEY,
        Protocol.StorageTypeIdentity.encode({
            privateKey: identity.privateKey,
            writerId: identity.writerId,
            sequenceNumber: identity.sequenceNumber,
        }).finish(),
    );

    await Ingest.levelSaveEvent(state, event);

    if (state.autoSync === true) {
        Synchronization.backfillServer(state);
    }

    return {
        publicKey: identity.publicKey,
        writerId: identity.writerId,
        sequenceNumber: event.sequenceNumber,
    };
}
