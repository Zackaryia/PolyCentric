import * as Base64 from '@borderless/base64';
import * as AbstractLevel from 'abstract-level';

import * as DB from './db';
import * as Util from './Util';
import * as Protocol from './protocol';
import * as Keys from './keys';
import * as Synchronization from './synchronization';
import * as Validation from './validation';

async function insertRange(
    table: AbstractLevel.AbstractLevel<Uint8Array, Uint8Array, Uint8Array>,
    event: Protocol.StorageTypeRange,
) {
    await table.put(
        Keys.pointerToKey({
            publicKey: event.publicKey,
            writerId: event.writerId,
            sequenceNumber: event.lowSequenceNumber,
        }),
        Protocol.StorageTypeRange.encode(event).finish(),
    );
}

async function insertEvent(
    table: AbstractLevel.AbstractLevel<Uint8Array, Uint8Array, Uint8Array>,
    event: Protocol.Event,
) {
    await table.put(
        Keys.pointerToKey({
            publicKey: event.authorPublicKey,
            writerId: event.writerId,
            sequenceNumber: event.sequenceNumber,
        }),
        Protocol.StorageTypeEvent.encode({
            event: event,
            mutationPointer: undefined,
        }).finish(),
    );
}

export async function levelUpdateRanges(
    table: AbstractLevel.AbstractLevel<Uint8Array, Uint8Array, Uint8Array>,
    event: Protocol.Pointer,
) {
    const key = Keys.pointerToKey(event);

    const possibleLowRange = (
        await table
            .values({
                lt: key,
                gte: DB.appendBuffers(
                    DB.appendBuffers(event.publicKey, event.writerId),
                    Keys.MIN_UINT64_KEY,
                ),
                limit: 1,
                reverse: true,
            })
            .all()
    ).map(DB.decodeStorageTypeRange);

    const possibleHighRange = (
        await table
            .values({
                gt: key,
                lte: DB.appendBuffers(
                    DB.appendBuffers(event.publicKey, event.writerId),
                    Keys.MAX_UINT64_KEY,
                ),
                limit: 1,
            })
            .all()
    ).map(DB.decodeStorageTypeRange);

    if (
        possibleHighRange.length !== 0 &&
        possibleHighRange[0].highSequenceNumber >= event.sequenceNumber &&
        possibleHighRange[0].lowSequenceNumber <= event.sequenceNumber
    ) {
        return;
    }

    if (
        possibleLowRange.length !== 0 &&
        possibleLowRange[0].highSequenceNumber >= event.sequenceNumber &&
        possibleLowRange[0].lowSequenceNumber <= event.sequenceNumber
    ) {
        return;
    }

    if (
        possibleLowRange.length !== 0 &&
        possibleHighRange.length !== 0 &&
        possibleLowRange[0].highSequenceNumber + 2 ===
            possibleHighRange[0].lowSequenceNumber
    ) {
        await table.batch([
            {
                type: 'del',
                key: Keys.pointerToKey({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    sequenceNumber: possibleHighRange[0].lowSequenceNumber,
                }),
            },
            {
                type: 'put',
                key: Keys.pointerToKey({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    sequenceNumber: possibleLowRange[0].lowSequenceNumber,
                }),
                value: Protocol.StorageTypeRange.encode({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    lowSequenceNumber: possibleLowRange[0].lowSequenceNumber,
                    highSequenceNumber: possibleHighRange[0].highSequenceNumber,
                }).finish(),
            },
        ]);
    } else if (
        possibleHighRange.length !== 0 &&
        possibleHighRange[0].lowSequenceNumber - 1 === event.sequenceNumber
    ) {
        await table.batch([
            {
                type: 'del',
                key: Keys.pointerToKey({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    sequenceNumber: possibleHighRange[0].lowSequenceNumber,
                }),
            },
            {
                type: 'put',
                key: Keys.pointerToKey({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    sequenceNumber: event.sequenceNumber,
                }),
                value: Protocol.StorageTypeRange.encode({
                    publicKey: event.publicKey,
                    writerId: event.writerId,
                    lowSequenceNumber: event.sequenceNumber,
                    highSequenceNumber: possibleHighRange[0].highSequenceNumber,
                }).finish(),
            },
        ]);
    } else if (
        possibleLowRange.length !== 0 &&
        possibleLowRange[0].highSequenceNumber + 1 === event.sequenceNumber
    ) {
        await insertRange(table, {
            publicKey: event.publicKey,
            writerId: event.writerId,
            lowSequenceNumber: possibleLowRange[0].lowSequenceNumber,
            highSequenceNumber: event.sequenceNumber,
        });
    } else {
        await insertRange(table, {
            publicKey: event.publicKey,
            writerId: event.writerId,
            lowSequenceNumber: event.sequenceNumber,
            highSequenceNumber: event.sequenceNumber,
        });
    }
}

export async function levelSaveEvent(
    state: DB.PolycentricState,
    eventTainted: Protocol.Event,
) {
    if (Validation.validateEvent(eventTainted) === false) {
        console.log('event validation failed');

        return;
    }

    return await state.lock.acquire('lock', async () => {
        const event = DB.deepCopyEvent(eventTainted);

        const key = Keys.pointerToKey({
            publicKey: event.authorPublicKey,
            writerId: event.writerId,
            sequenceNumber: event.sequenceNumber,
        });

        if ((await DB.doesKeyExist(state.levelEvents, key)) === true) {
            return;
        }

        const body = Protocol.EventBody.decode(event.content);

        if (Validation.validateEventBody(body) === false) {
            console.log('event body validation failed');

            return;
        }

        let mutatedProfile = false;

        {
            let mutated = false;

            const rawExisting = await DB.tryLoadKey(
                state.levelProfiles,
                event.authorPublicKey,
            );

            if (rawExisting === undefined) {
                mutated = true;
            }

            let profile: Protocol.StorageTypeProfile = {
                publicKey: event.authorPublicKey,
                username: new TextEncoder().encode('unknown'),
                description: undefined,
                imagePointer: undefined,
                mutatedBy: undefined,
                unixMilliseconds: 0,
                heads: [],
                servers: [],
            };

            if (rawExisting !== undefined) {
                profile = Protocol.StorageTypeProfile.decode(rawExisting);
            }

            if (
                body.profile !== undefined &&
                profile.unixMilliseconds < event.unixMilliseconds
            ) {
                profile.username = body.profile.profileName;
                profile.description = body.profile.profileDescription;
                profile.servers = body.profile.profileServers;
                profile.imagePointer = body.profile.profileImagePointer;
                profile.unixMilliseconds = event.unixMilliseconds;
                profile.mutatedBy = {
                    publicKey: event.authorPublicKey,
                    writerId: event.writerId,
                    sequenceNumber: event.sequenceNumber,
                };

                mutated = true;
            }

            let foundHead = false;
            for (const head of profile.heads) {
                if (Util.blobsEqual(head.key, event.writerId)) {
                    if (head.value < event.sequenceNumber) {
                        head.value = event.sequenceNumber;
                        mutated = true;
                    }
                    foundHead = true;
                    break;
                }
            }
            if (foundHead === false) {
                profile.heads.push({
                    key: event.writerId,
                    value: event.sequenceNumber,
                });
                mutated = true;
            }

            if (mutated) {
                await state.levelProfiles.put(
                    event.authorPublicKey,
                    Protocol.StorageTypeProfile.encode(profile).finish(),
                );
            }

            mutatedProfile = mutated;
        }

        if (body.follow !== undefined) {
            const messageFromIdentity = Util.blobsEqual(
                (await DB.levelLoadIdentity(state)).publicKey,
                event.authorPublicKey,
            );

            if (messageFromIdentity) {
                let update = false;

                const existing = await DB.tryLoadKey(
                    state.levelFollowing,
                    body.follow.publicKey,
                );

                if (existing === undefined) {
                    update = true;
                } else {
                    const decoded =
                        Protocol.StorageTypeFollowing.decode(existing);

                    if (decoded.unixMilliseconds < event.unixMilliseconds) {
                        update = true;
                    }
                }

                if (update === true) {
                    await state.levelFollowing.put(
                        body.follow.publicKey,
                        Protocol.StorageTypeFollowing.encode({
                            publicKey: body.follow.publicKey,
                            unixMilliseconds: event.unixMilliseconds,
                            unfollow: body.follow.unfollow,
                        }).finish(),
                    );

                    if (body.follow.unfollow === false) {
                        Synchronization.addFeed(state, body.follow.publicKey);
                    }
                }
            }
        }

        if (body.delete !== undefined && body.delete.pointer !== undefined) {
            const pointer = body.delete.pointer;

            if (Util.blobsEqual(pointer.publicKey, event.authorPublicKey)) {
                await state.levelEvents.put(
                    Keys.pointerToKey(pointer),
                    Protocol.StorageTypeEvent.encode({
                        event: undefined,
                        mutationPointer: {
                            publicKey: event.authorPublicKey,
                            writerId: event.writerId,
                            sequenceNumber: event.sequenceNumber,
                        },
                    }).finish(),
                );

                await levelUpdateRanges(state.levelRanges, pointer);
            } else {
                console.log('received malicious delete');
            }
        }

        await levelUpdateRanges(state.levelRanges, {
            publicKey: event.authorPublicKey,
            writerId: event.writerId,
            sequenceNumber: event.sequenceNumber,
        });

        await insertEvent(state.levelEvents, event);

        {
            const key = Base64.encode(
                Keys.pointerToKey({
                    publicKey: event.authorPublicKey,
                    writerId: event.writerId,
                    sequenceNumber: event.sequenceNumber,
                }),
            );

            DB.fireListenersForEvent(state, key);
        }

        if (mutatedProfile) {
            const key = Base64.encode(
                new Uint8Array([
                    ...new TextEncoder().encode('!profiles!'),
                    ...event.authorPublicKey,
                ]),
            );

            DB.fireListenersForEvent(state, key);
        }

        if (body.message !== undefined) {
            await state.levelIndexPostByTime.put(
                DB.deepCopyUint8Array(
                    Util.numberToBinaryBE(event.unixMilliseconds),
                ),
                DB.deepCopyUint8Array(key),
            );

            await state.levelIndexPostByAuthorByTime.put(
                Keys.makeStorageTypeEventKeyByAuthorByTime(
                    event.authorPublicKey,
                    event.unixMilliseconds,
                ),
                DB.deepCopyUint8Array(key),
            );
        }
    });
}